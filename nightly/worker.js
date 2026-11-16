// =====================================================================================
// Owlet → Huckleberry: daily automatic import (Cloudflare Worker)
// =====================================================================================
//
// Every day at noon (local time), this Worker:
//   1. signs in to Owlet and downloads the last 36 hours of sleep summaries,
//   2. keeps only overnight sleeps (starting 6 pm – 9 am) that finished at least an hour ago,
//   3. signs in to Huckleberry and skips any sleep that overlaps one already logged,
//   4. writes the rest into Huckleberry the same way the Huckleberry app does.
//
// Full step-by-step setup (Cloudflare account, secrets, schedule, testing, pitfalls) is in
// README.md in this repo. Quick reference:
//
// Settings (Worker → Settings → Variables and Secrets):
//   Secrets:  OWLET_EMAIL, OWLET_PASSWORD, HB_EMAIL, HB_PASSWORD
//             RUN_KEY      any long random string of letters and numbers; it lets you
//                          trigger a run from your browser (see "Manual runs" below)
//   Text:     TIMEZONE     e.g. America/New_York (without it, times are treated as UTC)
//             OWLET_REGION world or europe (default world)
//             CHILD_NAME   optional; Huckleberry child nickname (default: first child)
//             RUN_HOUR     optional; local hour to run, 0-23 (default 12 = noon)
//
// Schedule (Worker → Settings → Trigger Events → Cron Triggers):
//   Cloudflare's cron runs in UTC and doesn't know about daylight saving, so add BOTH UTC
//   times that can be RUN_HOUR in your time zone (summer and winter). For noon US Eastern:
//     0 16 * * *   and   0 17 * * *
//   Each run checks the real local time and quietly does nothing if it isn't RUN_HOUR, so
//   the import happens exactly once a day all year.
//
// Manual runs from a browser (the key is a ?key= parameter, NOT part of the path):
//   https://<worker>.workers.dev/?key=<RUN_KEY>           dry run: shows what it would import
//   https://<worker>.workers.dev/?key=<RUN_KEY>&write=1   imports for real
//
// Each run's report also goes to the Worker's logs (Worker → Logs, once Workers Logs is
// turned on). It contains only sleep times, never logins or tokens.
//
// Unofficial: this uses undocumented Owlet and Huckleberry APIs and can break at any time.

// ------------------------------------------------------------------ tunable settings

const OVERNIGHT_FROM = 18;   // a sleep counts as overnight if it starts at or after 6 pm...
const OVERNIGHT_TO = 9;      // ...or before 9 am (local time). Naps outside this are ignored.
const LOOKBACK_HOURS = 36;   // how far back to look on each run (covers a missed day's night)
const SETTLE_MINUTES = 60;   // skip sleeps that ended less than this long ago: they may still be
                             // in progress, and importing a half-finished sleep would block the
                             // full one later (it would count as "already there")

// ------------------------------------------------------------------ service constants

// Public client constants from the Owlet Android app, as used by the open-source
// pyowletapi library (https://github.com/ryanbdclark/pyowletapi). Not personal secrets:
// every copy of the app ships with them. Owlet's device cloud is run by Ayla Networks.
const OWLET = {
  world: {
    apiKey: "AIzaSyCsDZ8kWxQuLJAMVnmEhEkayH1TSxKXfGA",                          // Google sign-in
    mini: "https://ayla-sso.owletdata.com/mini/",                                // Owlet token swap
    signin: "https://user-field-1a2039d9.aylanetworks.com/api/v1/token_sign_in", // Ayla sign-in
    base: "https://ads-field-1a2039d9.aylanetworks.com/apiv1",                   // device data
    appId: "sso-prod-3g-id",
    appSecret: "sso-prod-UEjtnPCtFfjdwIwxqnC0OipxRFU",
  },
  europe: {
    apiKey: "AIzaSyDm6EhV70wudwN3iOSq3vTjtsdGjdFLuuM",
    mini: "https://ayla-sso.eu.owletdata.com/mini/",
    signin: "https://user-field-eu-1a2039d9.aylanetworks.com/api/v1/token_sign_in",
    base: "https://ads-field-eu-1a2039d9.aylanetworks.com/apiv1",
    appId: "OwletCare-Android-EU-fw-id",
    appSecret: "OwletCare-Android-EU-JKupMPBoj_Npce_9a95Pc8Qo0Mw",
  },
};

// Huckleberry runs on Google Firebase (project "simpleintervals"). The API key is the public
// one built into the Huckleberry app, as used by py-huckleberry-api
// (https://github.com/Woyken/py-huckleberry-api). Your own login is still required.
const HB_KEY = "AIzaSyApGVHktXeekGyAt-G6dIeWHUkq2oXqcjg";
const HB_DB = "https://firestore.googleapis.com/v1/projects/simpleintervals/databases/(default)/documents";

// ------------------------------------------------------------------ entry points

export default {
  // Called by Cloudflare for each cron trigger.
  async scheduled(event, env, ctx) {
    const runHour = Number(env.RUN_HOUR || 12);
    // Two cron triggers fire each day (summer + winter UTC times). Only the one that lands
    // on RUN_HOUR in your time zone does anything; the other returns immediately.
    if (localParts(Date.now(), env.TIMEZONE || "UTC").hour !== runHour) return;
    // waitUntil keeps the Worker alive until the import finishes.
    ctx.waitUntil(run(env, true));
  },

  // Called when you open the Worker's address in a browser. Protected by RUN_KEY so random
  // visitors can't trigger imports. Each failure says exactly what's wrong, because a plain
  // "Not found" turned out to be very confusing during setup.
  async fetch(request, env) {
    const url = new URL(request.url);
    const text = (body, status) => new Response(body + "\n", { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    if (url.pathname !== "/") return text("Not found", 404); // e.g. the browser's /favicon.ico request
    // Note: the editor's preview pane may not have your secrets, so test in a normal browser tab.
    if (!env.RUN_KEY) return text("RUN_KEY isn't set for this deployment. Add it under Settings → Variables and Secrets, then deploy.", 403);
    const key = url.searchParams.get("key");
    if (key === null) return text("Add ?key=<your RUN_KEY> to the end of this address.", 403);
    if (key !== env.RUN_KEY) return text("Wrong key: it doesn't match RUN_KEY.", 403);
    // Dry run unless &write=1 is on the address.
    const report = await run(env, url.searchParams.get("write") === "1");
    return new Response(report + "\n", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  },
};

// ------------------------------------------------------------------ the import itself

// Does one import (or dry run when write is false) and returns a plain-text report.
// Never throws: failures become a "Failed: ..." report so they show up in logs and the browser.
async function run(env, write) {
  const tz = env.TIMEZONE || "UTC";
  const lines = [];
  try {
    const now = Date.now();
    const since = now - LOOKBACK_HOURS * 3600e3;

    // 1. Owlet: sign in, list socks, decode each sock's recent sleep sessions.
    const owlet = await owletLogin(env);
    const devices = await call(`${owlet.base}/devices.json`, { headers: owlet.headers }, "Owlet devices");
    let found = [];
    for (const d of devices) found.push(...sessionsFrom(await fetchSummaries(owlet, d.device.dsn, since)));

    // 2. Keep overnight sleeps in the lookback window; hold back ones that may still be going.
    const tooRecent = [];
    found = found.filter((s) => {
      const h = localParts(s.start, tz).hour;
      if (s.start < since || !(h >= OVERNIGHT_FROM || h < OVERNIGHT_TO)) return false;
      if (s.end > now - SETTLE_MINUTES * 60e3) { tooRecent.push(s); return false; }
      return true;
    });

    // 3. Huckleberry: sign in, pick the child, and drop anything that overlaps an existing
    //    sleep (hand-logged or imported earlier). Overlap, not exact match, because hand-logged
    //    times never line up exactly with Owlet's.
    const hb = await hbLogin(env);
    const child = await hbChild(hb, env.CHILD_NAME);
    const have = await hbExisting(hb, child.cid, since / 1000 - 86400, now / 1000 + 86400);
    const todo = found.filter((s) => !have.some(([a, b]) => a < s.end / 1000 && b > s.start / 1000));

    for (const s of found) {
      lines.push(`${todo.includes(s) ? (write ? "imported" : "would import") : "already there"}: ${span(s, tz)}`);
    }
    for (const s of tooRecent) lines.push(`not yet (still going or just ended): ${span(s, tz)}`);

    // 4. Write. Then refresh the app's "last sleep" summary, which drives its home screen.
    if (write) {
      for (const s of todo) await hbLogSleep(hb, child.cid, s, tz);
      if (todo.length) await hbUpdateLastSleep(hb, child.cid, todo.reduce((a, b) => (b.start > a.start ? b : a)), tz);
    }

    const hours = todo.reduce((n, s) => n + (s.end - s.start) / 3600e3, 0).toFixed(1);
    const head = todo.length
      ? `${write ? "Imported" : "Dry run: would import"} ${todo.length} sleep${todo.length === 1 ? "" : "s"} (${hours} h) for ${child.nickname}`
      : `Nothing new for ${child.nickname}`;
    const report = [head, ...lines].join("\n");
    console.log(report);
    return report;
  } catch (e) {
    const report = ["Failed: " + e.message, ...lines].join("\n");
    console.error(report);
    return report;
  }
}

// ------------------------------------------------------------------ helpers

// fetch() + JSON + a readable error naming which step failed (e.g. "Owlet sign-in: HTTP 400 ...").
async function call(url, opts, what) {
  // PITFALL: Cloudflare Workers send no Accept header by default (browsers and Node do), and
  // Owlet's device cloud answers a valid sign-in with HTTP 406 without one. Always send it.
  const r = await fetch(url, { ...opts, headers: { Accept: "application/json", ...(opts.headers || {}) } });
  if (!r.ok) {
    let msg = await r.text().catch(() => "");
    try { msg = JSON.parse(msg).error?.message || msg; } catch { /* not JSON: keep the text */ }
    throw new Error(`${what}: HTTP ${r.status} ${String(msg).slice(0, 160)}`);
  }
  return r.json();
}

// Sleep times are plain numbers: milliseconds since 1970 (UTC). Plain numbers, not Date
// objects, because Cloudflare's code editor type-checks the file and flags maths on Dates.
/** @typedef {{ start: number, end: number }} Sleep */

/**
 * Wall-clock parts of a moment in time zone `tz` (Workers run in UTC, so we can't use
 * getHours() and friends).
 * @param {number} ms
 * @param {string} tz
 * @returns {{ year: string, month: string, day: string, hour: number, minute: string, second: string }}
 */
function localParts(ms, tz) {
  /** @type {Record<string, string>} */
  const p = {};
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(ms);
  for (const x of parts) p[x.type] = x.value;
  return { year: p.year, month: p.month, day: p.day, hour: +p.hour, minute: p.minute, second: p.second };
}

/**
 * Minutes behind UTC at that moment (positive in the Americas, e.g. 300 for New York in
 * winter and 240 in summer), the same convention as JavaScript's getTimezoneOffset().
 * Huckleberry stores this with every sleep, so it has to match what the app writes.
 * @param {number} ms
 * @param {string} tz
 */
function tzOffset(ms, tz) {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, p.hour, +p.minute, +p.second);
  return Math.round((Math.floor(ms / 1000) * 1000 - asUtc) / 60000);
}

/**
 * One report line's time range, e.g. "11/14 22:06 – 11/15 03:55 (5.8 h)".
 * @param {Sleep} s
 * @param {string} tz
 */
function span(s, tz) {
  const f = (/** @type {number} */ d) => { const p = localParts(d, tz); return `${p.month}/${p.day} ${String(p.hour).padStart(2, "0")}:${p.minute}`; };
  return `${f(s.start)} – ${f(s.end)} (${((s.end - s.start) / 3600e3).toFixed(1)} h)`;
}

// ------------------------------------------------------------------ Owlet

// Owlet's login is three steps:
//   1. Google Identity Toolkit checks email + password and returns a Google ID token.
//      (The X-Android-* headers identify the request as the Owlet app; Google requires them.)
//   2. Owlet's "mini" service swaps that for an Owlet "mini token". This is the step that
//      refuses web pages (no CORS), which is why the web page needs a relay. A Worker isn't
//      a web page, so it calls it directly.
//   3. Ayla's token_sign_in swaps the mini token for an access token for the device cloud.
async function owletLogin(env) {
  const R = OWLET[env.OWLET_REGION || "world"];
  if (!R) throw new Error("OWLET_REGION must be world or europe");
  const g = await call(`https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key=${R.apiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Android-Package": "com.owletcare.owletcare",
      "X-Android-Cert": "2A3BC26DB0B8B0792DBE28E6FFDC2598F9B12B74",
    },
    body: JSON.stringify({ email: env.OWLET_EMAIL, password: env.OWLET_PASSWORD, returnSecureToken: true }),
  }, "Owlet sign-in");
  const m = await call(R.mini, { headers: { Authorization: g.idToken } }, "Owlet token");
  const a = await call(R.signin, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: R.appId, app_secret: R.appSecret, provider: "owl_id", token: m.mini_token }),
  }, "Owlet device cloud");
  return { base: R.base, headers: { Authorization: "auth_token " + a.access_token } };
}

// The sleep history lives in the history of the sock's MONITORING_SUMMARY property. Ayla
// returns at most 100 datapoints per request, newest first, so we page backwards with
// created_at_end_date until we're a day past `sinceMs` (the extra day catches sessions that
// started before the window but were summarized inside it). The page cap is a safety net.
async function fetchSummaries(api, dsn, sinceMs) {
  const url = `${api.base}/dsns/${dsn}/properties/MONITORING_SUMMARY/datapoints.json`;
  const seen = new Map();
  let end = null;
  for (let page = 0; page < 20; page++) {
    const pts = (await call(url + (end ? `?filter[created_at_end_date]=${end}` : ""), { headers: api.headers }, "Owlet history"))
      .map((p) => p.datapoint);
    let added = 0;
    for (const p of pts) {
      // Pages can overlap at the boundary; dedupe on timestamp + start of the value.
      const k = p.created_at + (p.value || "").slice(0, 64);
      if (!seen.has(k)) { seen.set(k, p); added++; }
    }
    if (!added) break; // nothing new: reached the start of the history
    const oldest = pts.map((p) => p.created_at).sort()[0];
    if (Date.parse(oldest) < sinceMs - 86400e3) break;
    // Next page: everything up to one second before the oldest one we have.
    end = new Date(Date.parse(oldest) - 1000).toISOString().replace(/\.\d+Z$/, "Z");
  }
  return [...seen.values()];
}

// Decoding a MONITORING_SUMMARY value:
//   base64 (padding sometimes missing)
//   → 1 version byte
//   → frames of [2-byte big-endian length][1-byte checksum][protobuf message]
// Each protobuf message summarizes 10 minutes of readings. Field 25 holds Owlet's own sleep
// session as {1: {1: sleep start, 2: sleep end}} in Unix seconds: the same sessions the Owlet
// app shows (one night may be split into several sleeps if the baby woke up).

function b64bytes(s) {
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4)); // re-add missing padding
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Minimal protobuf reader: returns [fieldNumber, value] pairs. Varints become numbers,
// length-delimited fields stay as bytes (decode nested messages by calling parsePb again),
// fixed 32/64-bit fields are skipped (we don't need them).
function parsePb(b) {
  const out = [];
  let i = 0;
  const varint = () => {
    let r = 0, mul = 1, c;
    // Multiply instead of bit-shifting so values above 2^31 (timestamps) stay correct.
    do { c = b[i++]; if (c === undefined) throw new Error("eof"); r += (c & 0x7f) * mul; mul *= 128; } while (c & 0x80);
    return r;
  };
  while (i < b.length) {
    const key = varint(), f = Math.floor(key / 8), wt = key % 8;
    if (f === 0) throw new Error("field 0"); // not a valid message
    let v = null;
    if (wt === 0) v = varint();                                                                             // varint
    else if (wt === 2) { const n = varint(); if (i + n > b.length) throw new Error("short"); v = b.subarray(i, i + n); i += n; } // bytes
    else if (wt === 5) i += 4;                                                                              // fixed32
    else if (wt === 1) i += 8;                                                                              // fixed64
    else throw new Error("wire type " + wt);
    out.push([f, v]);
  }
  return out;
}

// All datapoints → list of sleeps {start, end} in ms, sorted by start. The same session
// appears in many 10-minute records while it's ongoing, each with a later end time, so we
// group by start and keep the latest end.
function sessionsFrom(points) {
  const ends = new Map(); // start (seconds) → set of end times (seconds)
  for (const p of points) {
    if (!p.value) continue;
    let raw;
    try { raw = b64bytes(p.value); } catch { continue; }
    for (let i = 1; i + 3 <= raw.length;) { // i = 1 skips the version byte
      const n = (raw[i] << 8) | raw[i + 1];
      const fr = raw.subarray(i + 3, i + 3 + n);
      i += 3 + n;
      try {
        for (const [f, v] of parsePb(fr)) {
          if (f !== 25 || !(v instanceof Uint8Array)) continue;
          for (const [f2, inner] of parsePb(v)) {
            if (f2 !== 1 || !(inner instanceof Uint8Array)) continue;
            const starts = [], stops = [];
            for (const [k, x] of parsePb(inner)) { if (k === 1) starts.push(x); if (k === 2) stops.push(x); }
            for (const st of starts) {
              if (!ends.has(st)) ends.set(st, new Set());
              stops.forEach((e) => ends.get(st).add(e));
            }
          }
        }
      } catch { /* skip a malformed frame, keep going */ }
    }
  }
  return [...ends.entries()]
    .filter(([, e]) => e.size)
    .map(([st, e]) => ({ start: st * 1000, end: Math.max(...e) * 1000 }))
    .sort((a, b) => a.start - b.start);
}

// ------------------------------------------------------------------ Huckleberry (Firestore REST)

// Layout of the data we touch:
//   users/{uid}                            → childList: [{cid, nickname, ...}]
//   sleep/{childId}                        → prefs.lastSleep (the app's "last sleep" summary)
//   sleep/{childId}/intervals/{id}         → one document per sleep {start, duration, offset, ...}
//   sleep/{childId}/intervals/{id} (multi) → older sleeps bundled into one doc: {multi: true, data: {...}}
// Firestore's REST API wraps every value in its type, e.g. {doubleValue: 1.5}.

// Firestore numbers come back as {integerValue: "123"} or {doubleValue: 1.5}.
const num = (v) => (v ? Number(v.integerValue ?? v.doubleValue ?? 0) : 0);

// Firebase email + password sign-in. The ID token lasts an hour, plenty for one run.
async function hbLogin(env) {
  const a = await call(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${HB_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: env.HB_EMAIL, password: env.HB_PASSWORD, returnSecureToken: true }),
  }, "Huckleberry sign-in");
  return { uid: a.localId, headers: { "Content-Type": "application/json", Authorization: "Bearer " + a.idToken } };
}

// The child to import into: CHILD_NAME if set (case-insensitive), else the first child.
async function hbChild(hb, name) {
  const u = await call(`${HB_DB}/users/${hb.uid}`, { headers: hb.headers }, "Huckleberry account");
  const kids = (u.fields?.childList?.arrayValue?.values || []).map((v) => ({
    cid: v.mapValue.fields.cid.stringValue,
    nickname: v.mapValue.fields.nickname?.stringValue || "your child",
  }));
  if (!kids.length) throw new Error("No children on the Huckleberry account");
  if (!name) return kids[0];
  const k = kids.find((c) => c.nickname.toLowerCase() === name.toLowerCase());
  if (!k) throw new Error(`No child named "${name}" (have: ${kids.map((c) => c.nickname).join(", ")})`);
  return k;
}

// [start, end] in seconds for sleeps already logged that start within [from, to).
// Two queries, because Firestore can't filter inside the bundled "multi" documents: one for
// regular per-sleep documents in the range, one for all multi documents (filtered here).
async function hbExisting(hb, cid, from, to) {
  const q = (where) => call(`${HB_DB}/sleep/${cid}:runQuery`, {
    method: "POST", headers: hb.headers,
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "intervals" }], where } }),
  }, "Huckleberry sleeps");
  const range = await q({ compositeFilter: { op: "AND", filters: [
    { fieldFilter: { field: { fieldPath: "start" }, op: "GREATER_THAN_OR_EQUAL", value: { doubleValue: from } } },
    { fieldFilter: { field: { fieldPath: "start" }, op: "LESS_THAN", value: { doubleValue: to } } },
  ] } });
  const multi = await q({ fieldFilter: { field: { fieldPath: "multi" }, op: "EQUAL", value: { booleanValue: true } } });
  const out = [];
  for (const r of range) {
    const f = r.document?.fields;
    if (f && !f.multi) out.push([num(f.start), num(f.start) + num(f.duration)]);
  }
  for (const r of multi) {
    for (const e of Object.values(r.document?.fields?.data?.mapValue?.fields || {})) {
      const f = e.mapValue?.fields;
      if (f && num(f.start) >= from && num(f.start) < to) out.push([num(f.start), num(f.start) + num(f.duration)]);
    }
  }
  return out;
}

// Adds one sleep, in the same document shape the Huckleberry app writes for a manual entry:
// id "<ms timestamp>-<20 hex chars>", times in seconds, time-zone offset in minutes.
// currentDocument.exists=false makes Firestore refuse to overwrite an existing document.
async function hbLogSleep(hb, cid, s, tz) {
  const hex = [...crypto.getRandomValues(new Uint8Array(10))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const id = `${Date.now()}-${hex}`;
  const start = s.start / 1000, end = s.end / 1000;
  await call(`${HB_DB}/sleep/${cid}/intervals/${id}?currentDocument.exists=false`, {
    method: "PATCH", headers: hb.headers,
    body: JSON.stringify({ fields: {
      _id: { stringValue: id },
      start: { doubleValue: start },
      duration: { doubleValue: end - start },
      offset: { doubleValue: tzOffset(s.start, tz) },
      end_offset: { doubleValue: tzOffset(s.end, tz) },
      details: { mapValue: {} },
      lastUpdated: { doubleValue: Date.now() / 1000 },
      tz: { stringValue: tz },
    } }),
  }, "Huckleberry write");
}

// Keeps the app's "last sleep" summary (sleep/{childId}.prefs.lastSleep) current, but only if
// what we imported is newer than what's there, so we never roll it back. The updateMask
// limits the write to these three fields; the rest of the document is left alone.
async function hbUpdateLastSleep(hb, cid, latest, tz) {
  const doc = await call(`${HB_DB}/sleep/${cid}`, { headers: hb.headers }, "Huckleberry sleep summary");
  const current = num(doc.fields?.prefs?.mapValue?.fields?.lastSleep?.mapValue?.fields?.start);
  const start = latest.start / 1000;
  if (current && start < current) return;
  const now = Date.now() / 1000;
  const mask = ["prefs.lastSleep", "prefs.timestamp", "prefs.local_timestamp"].map((p) => `updateMask.fieldPaths=${p}`).join("&");
  await call(`${HB_DB}/sleep/${cid}?${mask}`, {
    method: "PATCH", headers: hb.headers,
    body: JSON.stringify({ fields: { prefs: { mapValue: { fields: {
      lastSleep: { mapValue: { fields: {
        start: { doubleValue: start },
        duration: { doubleValue: latest.end / 1000 - start },
        offset: { doubleValue: tzOffset(latest.start, tz) },
      } } },
      timestamp: { mapValue: { fields: { seconds: { doubleValue: now } } } },
      local_timestamp: { doubleValue: now },
    } } } } }),
  }, "Huckleberry sleep summary");
}
