# Owlet to Huckleberry

Copy your baby's sleep history from an Owlet sock account into Huckleberry, so you don't have to
log sleeps by hand.

> **Unofficial. Use at your own risk.** Not affiliated with or endorsed by Owlet Baby Care or
> Huckleberry Labs. It uses undocumented APIs that can break at any time. Automated access goes
> against both companies' terms of use, so either one could suspend your account. Keep your own
> backups. If you'd rather use an official route, residents of states with privacy laws (such as
> California's CCPA) can ask either company for a copy of their data.

## Pick how you want to use it

| You want to… | Use | Setup |
|---|---|---|
| Copy sleeps over now and then, by clicking a button | **The web page**: [bbelk.github.io/OwletToHuckleberry](https://bbelk.github.io/OwletToHuckleberry/) | A free Cloudflare account and a tiny relay ([Part 1](#part-1-set-up-your-relay-for-the-web-page)), about 10 minutes, once |
| Have last night's sleep copied over automatically every day | **The daily Worker** | A free Cloudflare account and one Worker ([Part 3](#part-3-daily-automatic-import)), about 15 minutes, once |
| Run it from a terminal (developers) | **The command-line tool** | Python 3.14 ([Command line](#command-line-python)) |

You can use both the page and the daily Worker. They skip sleeps that are already in
Huckleberry, so nothing gets added twice.

### What's in this repo

| File | What it is |
|---|---|
| `index.html` | The web page. Everything runs in your browser. |
| `relay/worker.js` | The relay the web page needs for one Owlet login step. You run your own copy on Cloudflare. |
| `nightly/worker.js` | The daily automatic import, also run on your own Cloudflare account. |
| `backfill.py`, `owlet_history.py`, `owlet_common.py` | The command-line tool. |

Every file is commented, including how the Owlet data is decoded.

---

## Part 0: Make a free Cloudflare account

Both the relay and the daily import run as **Cloudflare Workers**: small pieces of code that
Cloudflare runs for you, for free. You need an account once, for either or both.

1. Go to [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) and sign up with
   your email. It's free and doesn't ask for a card.
2. Verify your email.
3. You don't need to add a website or domain. Skip any prompts about that.

The free plan allows 100,000 Worker requests a day. Each use of the page takes a handful, and
the daily import takes a few per day. If a limit were ever hit, the Worker would simply stop
until the next day. Cloudflare doesn't bill on the free plan.

**Creating a Worker** (you'll do this in Part 1 and Part 3):

1. In the left menu, open **Workers & Pages**. It's under **Compute** in newer dashboards.
2. Click **Create** (or **Create application**).
3. Choose **Start with Hello World!**.
4. Give it a name. The name becomes part of its address:
   `https://<name>.<your-account>.workers.dev`.
5. Click **Deploy**. This deploys Cloudflare's sample code for now.
6. Click **Edit code**. Select everything in the editor, delete it, and paste in the code from
   this repo.
7. Click **Deploy** (top right).

---

## Part 1: Set up your relay (for the web page)

### Why the page needs a relay

Owlet's login has three steps. Two of them work from a web page. The middle one, which swaps your
Google sign-in for an Owlet token (`ayla-sso.owletdata.com/mini/`), is set up to refuse requests
from web pages: it sends no CORS headers, so browsers block the page from reading its answer.
The relay is a tiny Worker that makes just that one request for the page and hands back the
answer.

### What the relay can and can't see

- It handles a sign-in token that's good for about an hour, and the Owlet token that comes back.
- It never sees your password, your Huckleberry login, or any sleep data.
- It stores and logs nothing.
- It only ever talks to Owlet's login server, so it can't be used as a proxy to reach other sites.
- It only answers the web page (see `ALLOWED_ORIGINS` in the code).

**There's no shared relay, on purpose.** Whoever runs a relay could change its code to keep that
token and get into your Owlet account for about an hour. So everyone runs their own, and nobody
else is involved.

### Setup

1. Make a Cloudflare account ([Part 0](#part-0-make-a-free-cloudflare-account)) if you
   haven't yet.
2. Create a Worker named, for example, `owlet-relay`, and paste in
   [`relay/worker.js`](relay/worker.js). The web page has a **Copy relay code** button in its
   setup section that copies it for you.
3. Deploy it, and copy its address, for example `https://owlet-relay.yourname.workers.dev`.
4. On the [web page](https://bbelk.github.io/OwletToHuckleberry/), paste the address into
   **Relay URL** and tick **Remember logins on this device** so you only do this once.

**Check that it's running:** open the relay's address in a normal browser tab. It should say
**"Origin not allowed"**. That's correct: it only answers the web page, not a browser tab.

The relay doesn't need any settings or secrets.

---

## Part 2: Using the web page

Open [bbelk.github.io/OwletToHuckleberry](https://bbelk.github.io/OwletToHuckleberry/).

1. **Get the sleeps.** Enter your Owlet email, password and relay URL. Pick a date range (**Last
   night**, **7 days**, **30 days**, or any dates) and click **Load Owlet sleeps**. Only that
   range is downloaded.
   *Or* skip Owlet and choose a CSV you downloaded earlier (columns `start,end`, local time like
   `2026-11-14 19:30`).
2. **Review the sleeps.** They're listed newest first, in your local time. **Download CSV** saves
   what's shown. You can narrow the dates; widening them means loading again.
3. **Import into Huckleberry.** Sign in to Huckleberry, before or after step 1. Connecting only
   reads. Each sleep is tagged **New** or **Already there** (it overlaps a sleep already logged),
   and only the new ones are ticked. Change the ticks if you like, then click **Import selected**.
   It asks you to confirm first.

**Try one sleep first:** import a single new sleep and check it shows up in the Huckleberry app
before doing a big batch.

**"Remember logins on this device"** saves both logins and the relay URL in this browser's
storage, **unencrypted**. They never go anywhere else. Don't tick it on a shared computer.
Untick it to erase them.

Owlet often splits one night into several sleeps when the baby wakes up. Those are Owlet's own
sessions, the same ones the Owlet app shows, and they're imported as separate sleeps.

---

## Part 3: Daily automatic import

`nightly/worker.js` does the import for you every day. It runs on Cloudflare, so your computer
doesn't need to be on. It doesn't need the relay: the relay only exists because *web pages* are
blocked from one Owlet login step, and a Worker isn't a web page.

**Every day at noon (your time) it:**

1. Signs in to Owlet and reads the last 36 hours of history.
2. Keeps **overnight sleeps only**: sleeps that start between 6 pm and 9 am and ended at least an
   hour ago. All the pieces of a night split by wake-ups are included. Naps are not.
3. Signs in to Huckleberry and skips any sleep that overlaps one already logged.
4. Adds the rest, the same way the Huckleberry app does.

**Your logins** are stored as encrypted secrets in *your own* Cloudflare account. Once saved,
not even you can read them back in the dashboard.

### Setup (about 15 minutes)

1. **Make a Cloudflare account** ([Part 0](#part-0-make-a-free-cloudflare-account)), or use the
   one you made for the relay.
2. **Create a Worker** named, for example, `owlet-nightly`, paste in
   [`nightly/worker.js`](nightly/worker.js), and click **Deploy**. This is a separate Worker
   from the relay; don't paste it over the relay.
3. **Add your settings.** Open the Worker → **Settings** → **Variables and Secrets** → **Add**.
   For each row, pick the type, enter the name exactly as shown (capitals and underscores), and
   the value. Click **Deploy** when you're done.

   | Name | Type | Value |
   |---|---|---|
   | `OWLET_EMAIL` | Secret | your Owlet email |
   | `OWLET_PASSWORD` | Secret | your Owlet password |
   | `HB_EMAIL` | Secret | your Huckleberry email |
   | `HB_PASSWORD` | Secret | your Huckleberry password |
   | `RUN_KEY` | Secret | a long random string of **letters and numbers only** (no symbols, see [pitfalls](#pitfalls-and-troubleshooting)). It lets you run the Worker from your browser. |
   | `TIMEZONE` | Text | your time zone, e.g. `America/New_York`, `America/Chicago`, `America/Denver`, `America/Los_Angeles`, `Europe/London`, `Europe/Berlin` ([full list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)) |
   | `OWLET_REGION` | Text | optional: `europe` if your Owlet account is European (default `world`) |
   | `CHILD_NAME` | Text | optional: which child, as named in Huckleberry (default: the first one) |
   | `RUN_HOUR` | Text | optional: a different hour to run, 0–23 (default `12`) |

4. **Test it.** Open this address in a normal browser tab, with your Worker's address and your
   `RUN_KEY` after `?key=`:

   ```
   https://owlet-nightly.yourname.workers.dev/?key=YOURRUNKEY
   ```

   This is a **dry run**. It changes nothing and shows something like:

   ```
   Nothing new for Baby
   already there: 11/14 22:06 – 11/15 03:55 (5.8 h)
   already there: 11/15 05:19 – 11/15 07:21 (2.0 h)
   ```

   or "Dry run: would import 3 sleeps…". If something's wrong, it says what (see
   [pitfalls](#pitfalls-and-troubleshooting)). To do a real import right now, add `&write=1`
   to the end of the address.

5. **Set the schedule.** Worker → **Settings** → **Trigger Events** (called **Triggers** in some
   dashboards) → **Add** → **Cron Triggers**. Add **both** times for your time zone:

   | Your time zone | Add these two cron triggers |
   |---|---|
   | US Eastern | `0 16 * * *` and `0 17 * * *` |
   | US Central | `0 17 * * *` and `0 18 * * *` |
   | US Mountain | `0 18 * * *` and `0 19 * * *` |
   | US Pacific | `0 19 * * *` and `0 20 * * *` |
   | UK | `0 11 * * *` and `0 12 * * *` |
   | Central Europe | `0 10 * * *` and `0 11 * * *` |

   Why two: Cloudflare schedules in UTC, and noon your time is a different UTC hour in summer and
   winter. The Worker checks the real local time and only does the work on the one that's noon,
   so it imports once a day all year. If you changed `RUN_HOUR`, shift both times by the same
   number of hours. Arizona and other places without daylight saving only need one.

6. **Recommended: turn on logs.** Worker → **Settings** → **Observability** → turn on **Workers
   Logs**. Each run leaves a short report under the Worker's **Logs** tab, such as "Imported 3
   sleeps (10.2 h)" or "Failed: Owlet sign-in: HTTP 400 INVALID_PASSWORD". The reports hold only
   sleep times, never logins. Without logs, a failure is silent.

7. **Pick a strong key.** If you used something short like `test` while setting up, change
   `RUN_KEY` to a long random one now. Anyone with your address and key could trigger an import.

### Living with it

- **Stop logging nights by hand** in Huckleberry, or only log them before noon. A sleep logged
  by hand *before* the Worker runs is skipped. One logged *after* it ran shows up twice.
- **Check now and then.** If Owlet or Huckleberry change their systems, the import stops. Look
  at the Logs tab, or open the test address.
- **Changed a password?** Update the secret in Cloudflare.
- **Missed a day?** Each run looks back 36 hours, and the web page can fill in anything older.
- **Different overnight hours?** Change `OVERNIGHT_FROM` and `OVERNIGHT_TO` near the top of the
  code.
- **To turn it off**, delete the cron triggers, or delete the Worker.

---

## Pitfalls and troubleshooting

These are all things we actually ran into while setting this up.

### Daily Worker

| You see | What's going on | Fix |
|---|---|---|
| "Add ?key=… to the end of this address" | The key goes in a `?key=` parameter, not the path. `…workers.dev/test` won't work. | Use `…workers.dev/?key=YOURRUNKEY`. |
| "Wrong key: it doesn't match RUN_KEY" | The key in the address isn't exactly `RUN_KEY`. Symbols are the usual cause: in an address, `#` cuts off the rest, `&` splits it, and `+` becomes a space. | Make `RUN_KEY` letters and numbers only. |
| "RUN_KEY isn't set for this deployment" | The Worker can't see the secret. Cloudflare's code editor has a preview pane, which may not have your secrets. Or the secret was added without deploying. | Test in a normal browser tab. Check the Worker's **Deployments** list shows a deployment newer than your change. |
| "Hello World!" | Cloudflare's sample code is still deployed. | **Edit code**, paste `nightly/worker.js`, **Deploy**. |
| "Failed: Owlet device cloud: HTTP 406" | Owlet's device cloud refuses a sign-in unless the request says it accepts JSON. Browsers send that automatically; Cloudflare Workers don't. | Fixed in the current code. If you see it, you have an older copy: paste the latest `nightly/worker.js`. If you edit the code, keep the `Accept` header in `call()`. |
| Red squiggles / errors like "Operator '>' cannot be applied to types 'Date' and 'number'" in Cloudflare's editor | Cloudflare's editor type-checks the code. An older version did maths on dates in a way the checker rejects. | Fixed in the current code. Paste the latest version. |
| "Failed: Owlet sign-in: HTTP 400 …" or "Huckleberry sign-in: HTTP 400 …" | Wrong email or password. | Re-enter the secret. Secrets can't be viewed, only replaced. |
| "No child named …" | `CHILD_NAME` doesn't match a child in Huckleberry. The message lists the names it found. | Fix or remove `CHILD_NAME`. |
| It didn't run at noon | Only one cron trigger was added, or the wrong ones for your time zone, or `TIMEZONE` is missing (it then assumes UTC). | Add both triggers from the table, and set `TIMEZONE`. |
| A sleep shows up twice | It was logged by hand after the Worker had already imported it. | Delete one in the Huckleberry app. Stop logging nights by hand. |
| "not yet (still going or just ended)" | That sleep ended less than an hour ago, so it may still be going. | Nothing to do. The next run picks it up. |

### Web page

| You see | What's going on | Fix |
|---|---|---|
| "Couldn't reach ayla-sso.owletdata.com … (CORS)" | The page tried Owlet's token step without a working relay. | Check the **Relay URL**: your own relay's address, starting with `https://`. |
| "Couldn't reach …workers.dev" or "HTTP 403 … Origin not allowed" | The relay's address is wrong, or you're using the page from somewhere not in the relay's `ALLOWED_ORIGINS`. | Check the address. If you host your own copy of the page, add its origin (like `https://you.github.io`) to `ALLOWED_ORIGINS` in `relay/worker.js` and redeploy. |
| Opening the relay address shows "Origin not allowed" | Normal: the relay only answers the web page. | Nothing to fix. |
| The page looks old after an update | Your browser cached the previous version. | Hard refresh: Ctrl+Shift+R (Cmd+Shift+R on a Mac). |
| A night is split into several sleeps | Owlet's own sessions, split when the baby woke up. | Expected. The Owlet app shows the same split. |

### Forking or hosting your own copy

- **GitHub may email you a "secret detected" alert** about Google API keys (`AIza…`) in
  `index.html` and the Workers. These are the public keys built into the Owlet and Huckleberry
  apps, also published in the open-source libraries this project builds on. They can't get into
  anyone's account without that person's own email and password. Close the alert as a false
  positive.
- **Never commit `config.json`.** It holds your real logins for the command-line tool and is
  listed in `.gitignore`.
- If you host `index.html` somewhere other than `bbelk.github.io`, add that origin to
  `ALLOWED_ORIGINS` in your relay.

### Command line

- **"No module named aiohttp" (or similar)**: you ran the system Python. Use the virtual
  environment's Python: `.venv\Scripts\python backfill.py`.
- **`huckleberry-api` installs an old version without `log_sleep`**: it needs Python 3.14 or
  newer. Create the virtual environment with `py -3.14`.

---

## Command line (Python)

For developers. Requires Python 3.14+ (Windows commands shown).

```
py -3.14 -m venv .venv
.venv\Scripts\pip install -r requirements.txt
copy config.example.json config.json      # fill in both logins and your time zone

.venv\Scripts\python backfill.py --export-only           # write owlet_sleep_export.csv
.venv\Scripts\python backfill.py --since 2026-11-09      # dry run: what would be imported
.venv\Scripts\python backfill.py --since 2026-11-09 --write
```

The import skips any Owlet sleep that overlaps a sleep already in Huckleberry, so re-running it
is safe and hand-logged sleeps are never duplicated. The CSV it writes can also be loaded into
the web page.

---

## How it works

The Owlet app shows sleep history but has no export. Owlet's device cloud (run by Ayla Networks)
keeps the history of the sock's `MONITORING_SUMMARY` property, going back months. Each entry is
a base64 value holding protobuf records:

- After decoding: one version byte, then frames of `[2-byte length][1-byte checksum][protobuf]`.
- Each record summarizes 10 minutes of readings.
- **Field 25** carries Owlet's own sleep session (start and end): the same sessions the Owlet
  app shows.

The decoders in `owlet_history.py`, `index.html` and `nightly/worker.js` are commented
field by field.

Owlet login uses the same flow as [pyowletapi](https://github.com/ryanbdclark/pyowletapi):
Google sign-in, then Owlet's token service, then Ayla's sign-in. Huckleberry runs on Google
Firebase; reads and writes go through Firestore's REST API, matching what
[py-huckleberry-api](https://github.com/Woyken/py-huckleberry-api) and the Huckleberry app
write. Imported sleeps look exactly like ones entered by hand.

This project only ever exports history and imports it. It never polls live sock readings.

## Privacy summary

- **Web page:** logins go straight from your browser to Owlet's, Google's and Huckleberry's own
  servers, plus your own relay for one short-lived token. "Remember" keeps them in your
  browser only.
- **Daily Worker:** your logins are encrypted secrets in your own Cloudflare account.
- **This repo's author** never sees any of it: there's no shared server.
