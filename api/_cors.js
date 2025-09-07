// Simple CORS helper for Vercel Node functions
const ORIGIN = "https://www.talkingcare.uk";

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": ORIGIN,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-vercel-protection-bypass, Accept",
    "Access-Control-Max-Age": "86400",
    ...extra,
  };
}

function send(res, status, body, extra = {}) {
  const headers = corsHeaders(extra);
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (typeof body === "string") {
    res.setHeader("Content-Type", extra["Content-Type"] || "text/plain; charset=utf-8");
    res.end(body);
  } else {
    res.setHeader("Content-Type", extra["Content-Type"] || "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  }
}

function ok(res, body, extra = {}) { send(res, 200, body, extra); }
function noContent(res)           { send(res, 204, "", {}); }
function bad(res, msg)            { send(res, 400, { ok:false, error: msg }); }
function fail(res, msg)           { send(res, 500, { ok:false, error: msg }); }

module.exports = { corsHeaders, send, ok, noContent, bad, fail, ORIGIN };
