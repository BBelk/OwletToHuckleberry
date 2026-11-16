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

1. Sign in to Owlet, pick a date range (last night, 7 or 30 days, or any dates) and load just
   those sleeps. Or skip Owlet and choose a CSV you downloaded earlier (columns `start,end`,
   local time like `2026-11-14 19:30`).
2. Review them in a table. You can download them as CSV.
3. Sign in to Huckleberry (before or after step 1). The page marks which sleeps are already logged (by overlapping time)
   and ticks only the new ones. Change the selection if you like, then click **Import selected**.

"Remember logins on this device" saves both logins and the relay URL in this browser's
localStorage, unencrypted. They never go anywhere else. Untick it to erase them.

### The relay

Owlet's login has three steps. The middle one (`ayla-sso.owletdata.com/mini/`, which swaps your
Google sign-in for an Owlet token) refuses requests from web pages, so the page sends just that
one request through a small relay: `relay/worker.js`, a Cloudflare Worker of about 60 lines.

- It only talks to Owlet's login server (it isn't an open proxy) and only answers this page.
- It stores and logs nothing.
- It handles a sign-in token that's good for about an hour. It never sees your password, your
  Huckleberry login, or any sleep data.

There's no shared relay. Whoever runs a relay could change its code to keep that token and get
into your Owlet account for about an hour, so each person runs their own. It's free and takes
about five minutes:

1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up) (no card).
2. Open **Workers & Pages** (under *Compute*) and click **Create**.
3. Choose **Start with Hello World!**, name it (for example `owlet-relay`), and click **Deploy**.
4. Click **Edit code**, replace everything with the contents of [`relay/worker.js`](relay/worker.js),
   and click **Deploy**.
5. Paste your worker's address (`https://owlet-relay.<you>.workers.dev`) into **Relay URL** on the
   page, and tick *Remember*.

To check it's running, open the address in a browser tab. "Origin not allowed" means it's working.
If you host your own copy of the page somewhere else, add that page's origin to `ALLOWED_ORIGINS`
in the worker.

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
