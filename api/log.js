// File: api/log.js

const ALLOWED_ORIGINS = new Set([
  "https://www.talkingcare.uk",
]);

function pickOrigin(req) {
  const origin = req.headers?.origin || "";
  return ALLOWED_ORIGINS.has(origin) ? origin : "https://www.talkingcare.uk";
}

function setCors(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function endPreflight(res) {
  res.statusCode = 204;
  res.end();
}

export default async function handler(req, res) {
  const origin = pickOrigin(req);
  setCors(res, origin);

  if (req.method === "OPTIONS") {
    return endPreflight(res);
  }

  if (req.method === "GET") {
    // minimal health check
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    // Swallow body and return quickly; this is fire-and-forget logging
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Log API Error:", err);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
}
