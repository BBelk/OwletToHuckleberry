# Owlet to Huckleberry

Export your baby's sleep history from an Owlet sock account, and import it into Huckleberry.

> **Unofficial. Use at your own risk.** Not affiliated with or endorsed by Owlet Baby Care or
> Huckleberry Labs. It uses undocumented APIs that can break at any time. Automated access goes
> against both companies' terms of use, so either one could suspend your account. Keep your own
> backups. If you'd rather use an official route, residents of states with privacy laws (such as
> California's CCPA) can ask either company for a copy of their data.

## How it works

The Owlet app shows sleep history but has no export. Owlet's device cloud (run by Ayla
Networks) keeps the history of the sock's `MONITORING_SUMMARY` property, which covers months.
Each entry is a base64 value holding protobuf records. Each record summarizes 10 minutes, and
field 25 carries Owlet's own sleep session (start and end). These are the same sessions the app
shows. See `owlet_history.py` for the format.

Login uses the same flow as [pyowletapi](https://github.com/ryanbdclark/pyowletapi). Huckleberry
writes use [py-huckleberry-api](https://github.com/Woyken/py-huckleberry-api).

## Web page (`index.html`)

Everything runs in your browser:

1. Sign in to Owlet and load the full sleep history.
2. Pick a date range. You can download it as CSV.
3. Sign in to Huckleberry. The page marks which sleeps are already logged (by overlapping time)
   and ticks only the new ones. Change the selection if you like, then click **Import selected**.

"Remember logins on this device" saves both logins and the relay URL in this browser's
localStorage, unencrypted. They never go anywhere else. Untick it to erase them.

One Owlet login step (`ayla-sso.owletdata.com/mini/`) rejects requests from web pages, so the
page needs a small relay for that one call. `relay/worker.js` is a Cloudflare Worker that forwards
only that request, and only for the page origins listed in it. To deploy your own: Cloudflare
dashboard → Workers & Pages → Create → Hello World → Edit code, paste `relay/worker.js`, add your
page's origin to `ALLOWED_ORIGINS`, then Deploy and paste the `*.workers.dev` URL into the page.

## Command line (Windows, Python 3.14+)

```
py -3.14 -m venv .venv
.venv\Scripts\pip install -r requirements.txt
copy config.example.json config.json      # fill in logins + timezone

.venv\Scripts\python backfill.py --export-only           # write owlet_sleep_export.csv
.venv\Scripts\python backfill.py --since 2026-11-09      # dry run: what would be imported
.venv\Scripts\python backfill.py --since 2026-11-09 --write
```

The import skips any Owlet sleep that overlaps a sleep already in Huckleberry, so re-running it
is safe and hand-logged sleeps are never duplicated.
