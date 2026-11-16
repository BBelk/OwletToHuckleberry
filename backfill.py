"""Copy Owlet's stored sleep history (months of it) into Huckleberry.

Default is a dry run: it lists every Owlet sleep session and whether it would be
imported. Sessions that overlap any sleep already in Huckleberry are skipped, so
hand-logged sleeps are never duplicated. Re-running is safe for the same reason.

Usage:
  python backfill.py --export-only         # just write owlet_sleep_export.csv
  python backfill.py                       # dry run, all history
  python backfill.py --since 2026-11-01    # only sessions starting on/after a date
  python backfill.py --write               # actually log the new sessions
"""

from __future__ import annotations

import argparse
import asyncio
import csv
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import aiohttp
from huckleberry_api import HuckleberryAPI

from owlet_common import ROOT, load_config, owlet_login, pick_child
from owlet_history import fetch_summary_history, sessions_from_datapoints


async def main(args: argparse.Namespace) -> None:
    cfg = load_config()
    h = cfg["huckleberry"]
    tz = ZoneInfo(h["timezone"])
    since = datetime.fromisoformat(args.since).replace(tzinfo=tz) if args.since else None

    async with aiohttp.ClientSession() as session:
        # 1. Owlet: download the summary history and decode the sleep sessions.
        #    (Uses the first sock on the account.)
        print("Reading Owlet history...")
        api, socks = await owlet_login(cfg, session)
        points = await fetch_summary_history(api, session, socks[0].serial, since)
        sessions = sessions_from_datapoints(points)
        if since:
            sessions = [s for s in sessions if s[0] >= since]
        # 2. Always save a CSV (local time) so there's a copy, even on a dry run. The web
        #    page can import this file too.
        out = ROOT / "owlet_sleep_export.csv"
        with out.open("w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["start", "end", "hours"])
            for a, b in sessions:
                w.writerow([f"{a.astimezone(tz):%Y-%m-%d %H:%M}", f"{b.astimezone(tz):%Y-%m-%d %H:%M}",
                            round((b - a).total_seconds() / 3600, 2)])
        print(f"Owlet has {len(sessions)} sleep sessions "
              f"({len(points)} summary datapoints). Saved to {out.name}")
        if not sessions or args.export_only:
            return

        # 3. Huckleberry: anything overlapping an existing sleep (hand-logged or imported
        #    earlier) is skipped. Overlap rather than exact match, because hand-logged times
        #    never line up exactly with Owlet's.
        hb = HuckleberryAPI(email=h["email"], password=h["password"], timezone=h["timezone"],
                            websession=session)
        await hb.authenticate()
        cid = await pick_child(hb, h.get("child_name"))
        existing = await hb.list_sleep_intervals(
            cid, sessions[0][0] - timedelta(days=1), datetime.now(timezone.utc))
        taken = [(i.start, i.start + i.duration) for i in existing]

        todo = []
        for a, b in sessions:
            overlap = any(s < b.timestamp() and e > a.timestamp() for s, e in taken)
            mark = "skip (already in Huckleberry)" if overlap else "NEW"
            print(f"  {a.astimezone(tz):%a %Y-%m-%d %H:%M} -> {b.astimezone(tz):%a %H:%M}"
                  f"  {(b - a).total_seconds() / 3600:4.1f} h  {mark}")
            if not overlap:
                todo.append((a, b))

        print(f"\n{len(todo)} new of {len(sessions)}; {len(sessions) - len(todo)} already covered.")
        if not args.write:
            print("Dry run. Re-run with --write to log the new ones to Huckleberry.")
            return
        # 4. Write. ensure_session() refreshes the Huckleberry login if it expired mid-run.
        for a, b in todo:
            await hb.ensure_session()
            await hb.log_sleep(cid, start_time=a, end_time=b)
            print(f"  logged {a.astimezone(tz):%m-%d %H:%M} -> {b.astimezone(tz):%H:%M}")
        print(f"Done: logged {len(todo)} sleeps.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--since", help="only sessions starting on/after YYYY-MM-DD (local time)")
    ap.add_argument("--export-only", action="store_true", help="write the CSV and stop")
    ap.add_argument("--write", action="store_true", help="log new sessions to Huckleberry")
    asyncio.run(main(ap.parse_args()))
