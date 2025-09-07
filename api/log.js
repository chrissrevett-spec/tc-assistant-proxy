// /api/log.js
export default async function handler(req, res) {
  const origin = req.headers.origin || "*";
  const headers = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-vercel-protection-bypass, Accept",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, headers); return res.end();
  }
  if (req.method !== "POST") {
    res.writeHead(405, { ...headers, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
  }
  // You can forward to a real log here if you like.
  res.writeHead(204, headers);
  res.end();
}
