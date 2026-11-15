// Cloudflare Worker: relays ONE Owlet login call that browsers can't make directly.
//
// Owlet's token endpoint (ayla-sso.owletdata.com/mini/) sends no CORS headers, so a web
// page can't call it. This worker forwards that single GET and adds CORS headers.
//
// It only ever contacts the two Owlet URLs below (no open proxy). It sees the user's
// short-lived Google ID token in the Authorization header, never their password, and it
// stores and logs nothing.
//
//   GET /mini?region=world|europe   (Authorization: <Google ID token>)

const TARGETS = {
  world: "https://ayla-sso.owletdata.com/mini/",
  europe: "https://ayla-sso.eu.owletdata.com/mini/",
};

// Pages allowed to use this relay. Add your own page's origin here.
const ALLOWED_ORIGINS = [
  "https://bbelk.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response("Origin not allowed", { status: 403 });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    const url = new URL(request.url);
    const target = TARGETS[url.searchParams.get("region") || "world"];
    if (request.method !== "GET" || url.pathname !== "/mini" || !target) {
      return new Response("Not found", { status: 404, headers: cors(origin) });
    }
    const token = request.headers.get("Authorization");
    if (!token) {
      return new Response("Missing Authorization", { status: 400, headers: cors(origin) });
    }

    const upstream = await fetch(target, { headers: { Authorization: token } });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(origin) },
    });
  },
};
