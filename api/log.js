export const config = { runtime: "nodejs" };

const ORIGIN = process.env.ALLOW_ORIGIN || "https://www.talkingcare.uk";
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "Content-Type, Accept";
const MAX_AGE = "86400";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", METHODS);
  res.setHeader("Access-Control-Allow-Headers", HEADERS);
  res.setHeader("Access-Control-Max-Age", MAX_AGE);
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.setHeader("Allow", "POST, OPTIONS"); res.status(405).json({ ok:false }); return; }

  // Best effort: swallow body and return ok
  try {
    // eslint-disable-next-line no-unused-vars
    const _ = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  } catch {}
  res.status(200).json({ ok: true });
}
