// =====================================================================================
// Owlet → Huckleberry: login relay (Cloudflare Worker)
// =====================================================================================
//
// Relays ONE Owlet login call that web pages aren't allowed to make directly.
//
// Why: Owlet's login has three steps. The middle one, Owlet's token endpoint
// (ayla-sso.owletdata.com/mini/), sends no CORS headers, so browsers block a web page from
// reading its answer. This Worker makes that single GET on the page's behalf and adds the
// CORS headers the browser needs. The other two steps go straight from the page.
//
// What it can see: the short-lived (about 1 hour) Google ID token in the Authorization
// header, and the Owlet token that comes back. Never your password, your Huckleberry login,
// or any sleep data. It stores and logs nothing.
//
// What it can't do: it only ever contacts the two Owlet URLs below, so it isn't an open
// proxy anyone can use to reach other sites.
//
// Run your own copy (free, about 5 minutes); setup steps are in README.md in this repo.
// There is deliberately no shared relay: whoever runs a relay could change its code to keep
// those tokens.
//
// Request format (sent by index.html):
//   GET /mini?region=world|europe      Authorization: <Google ID token>
//
// Opening the relay's address directly in a browser tab shows "Origin not allowed".
// That's expected: it only answers the pages listed in ALLOWED_ORIGINS.

// Owlet's token endpoint for each account region.
const TARGETS = {
  world: "https://ayla-sso.owletdata.com/mini/",
  europe: "https://ayla-sso.eu.owletdata.com/mini/",
};

// Web pages allowed to use this relay (scheme + host, no path, no trailing slash).
// The first is the public GitHub Pages copy of index.html; the others are for testing a
// local copy (e.g. `python -m http.server 8000`). If you host index.html somewhere else,
// add that page's origin here.
// Note: this stops other *websites* from using your relay through visitors' browsers. A
// script outside a browser can fake the Origin header, so treat it as a fence, not a lock.
// The worst a stranger can do is use up your free daily request allowance (Cloudflare
// doesn't bill for going over on the free plan; the relay just stops for the day).
const ALLOWED_ORIGINS = [
  "https://bbelk.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

// CORS headers that let the allowed page read the response.
function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization", // the page sends the token in this header
    "Access-Control-Max-Age": "86400",               // browser can cache the preflight for a day
    "Vary": "Origin",
  };
}

export default {
  async fetch(request) {
    // Only answer pages on the allowlist.
    const origin = request.headers.get("Origin") || "";
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response("Origin not allowed", { status: 403 });
    }
    // Because the page sends an Authorization header, the browser first asks permission
    // with an OPTIONS "preflight" request. Say yes.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    // The only thing this relay does: GET /mini?region=...
    const url = new URL(request.url);
    const target = TARGETS[url.searchParams.get("region") || "world"];
    if (request.method !== "GET" || url.pathname !== "/mini" || !target) {
      return new Response("Not found", { status: 404, headers: cors(origin) });
    }
    const token = request.headers.get("Authorization");
    if (!token) {
      return new Response("Missing Authorization", { status: 400, headers: cors(origin) });
    }

    // Forward just the token, nothing else from the original request, and pass Owlet's
    // answer (success or error) straight back. no-store so nothing caches the token.
    const upstream = await fetch(target, { headers: { Authorization: token } });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(origin) },
    });
  },
};
