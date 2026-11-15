"""Pull Owlet's stored sleep sessions out of the MONITORING_SUMMARY history.

How it works (reverse-engineered 2026-11-15 on a Dream Sock, fw apa 2.1.2):

* Ayla keeps the datapoint history of the sock's MONITORING_SUMMARY property
  (months of it). The list endpoint returns 100 datapoints per call; we page
  backwards with filter[created_at_end_date].
* Each datapoint value is base64. Decoded: 1 version byte, then frames of
  [2-byte big-endian length][1-byte checksum][protobuf message].
* Each protobuf message summarizes one 10-minute window:
    1  window start (unix s)        3  window end
    4  window length (600)          6  seconds of good readings
    16-22 heart-rate / SpO2 stats   23 per-minute sleep state (1/8/15), often absent
    25 { 1: sleep session start, 2: sleep session end (once it has ended) }
    36 per-minute code (unknown)
* Field 25 is Owlet's own sleep session, the same one the app shows in History.
"""

from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone

import aiohttp
from pyowletapi.api import OwletAPI


def _varint(b: bytes, i: int) -> tuple[int, int]:
    r = s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7F) << s
        s += 7
        if not c & 0x80:
            return r, i


def parse_pb(b: bytes) -> list[tuple[int, int | bytes]]:
    """Minimal protobuf wire decoder: [(field, value)], nested messages left as bytes."""
    i, out = 0, []
    while i < len(b):
        key, i = _varint(b, i)
        f, wt = key >> 3, key & 7
        if f == 0:
            raise ValueError("field 0")
        if wt == 0:
            v, i = _varint(b, i)
        elif wt == 2:
            n, i = _varint(b, i)
            v = b[i:i + n]
            if len(v) != n:
                raise ValueError("truncated")
            i += n
        elif wt == 5:
            v, i = int.from_bytes(b[i:i + 4], "little"), i + 4
        elif wt == 1:
            v, i = int.from_bytes(b[i:i + 8], "little"), i + 8
        else:
            raise ValueError(f"wire type {wt}")
        out.append((f, v))
    return out


def summary_frames(value: str) -> list[bytes]:
    raw = base64.b64decode(value + "=" * (-len(value) % 4))
    i, out = 1, []
    while i + 3 <= len(raw):
        n = int.from_bytes(raw[i:i + 2], "big")
        out.append(raw[i + 3:i + 3 + n])
        i += 3 + n
    return out


def sessions_from_datapoints(points: list[dict]) -> list[tuple[datetime, datetime]]:
    """Return Owlet's completed sleep sessions as (start, end) UTC datetimes."""
    ends: dict[int, set[int]] = {}
    for p in points:
        if not p.get("value"):
            continue
        for frame in summary_frames(p["value"]):
            try:
                fields = parse_pb(frame)
            except (ValueError, IndexError):
                continue
            for f, v in fields:
                if f != 25 or not isinstance(v, bytes):
                    continue
                for f2, inner in parse_pb(v):  # 25 { 1: {1: start, 2: end} }
                    if f2 != 1 or not isinstance(inner, bytes):
                        continue
                    d: dict[int, list[int]] = {}
                    for k, x in parse_pb(inner):
                        d.setdefault(k, []).append(x)
                    for s in d.get(1, []):
                        ends.setdefault(s, set()).update(d.get(2, []))
    utc = lambda t: datetime.fromtimestamp(t, timezone.utc)  # noqa: E731
    return [(utc(s), utc(max(e))) for s, e in sorted(ends.items()) if e]


async def fetch_summary_history(api: OwletAPI, session: aiohttp.ClientSession, dsn: str,
                                since: datetime | None = None) -> list[dict]:
    """All MONITORING_SUMMARY datapoints (newest first pages, walking back in time)."""
    base = f"{api._api_url}/dsns/{dsn}/properties/MONITORING_SUMMARY/datapoints.json"  # noqa: SLF001
    seen: dict[str, dict] = {}
    end = None
    while True:
        await api.authenticate()  # refreshes the token if it expired
        url = base + (f"?filter[created_at_end_date]={end}" if end else "")
        async with session.get(url, headers=api.headers) as r:
            r.raise_for_status()
            pts = [p["datapoint"] for p in await r.json()]
        new = [p for p in pts if p["created_at"] + (p.get("value") or "")[:64] not in seen]
        if not new:
            break
        for p in new:
            seen[p["created_at"] + (p.get("value") or "")[:64]] = p
        oldest = datetime.fromisoformat(min(p["created_at"] for p in pts).replace("Z", "+00:00"))
        if since and oldest < since:
            break
        end = (oldest - timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return sorted(seen.values(), key=lambda p: p["created_at"])
