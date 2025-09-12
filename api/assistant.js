// api/assistant.js
//
// One endpoint, two modes using the OpenAI "Responses" API:
//
//  • Non-streaming  : POST /api/assistant?stream=off  -> JSON { ok, text, usage }
//  • Streaming (SSE): POST /api/assistant?stream=on   -> raw SSE forwarded as-is
//
// Streaming requires a model that supports Responses streaming (e.g. gpt-4o-mini / gpt-4o).

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini"; // default safe
const CORS_ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN || "https://www.talkingcare.uk";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
}

// ---------- CORS ----------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
}
function endPreflight(res) { res.statusCode = 204; res.end(); }

// ---------- Body parsing ----------
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", c => (data += c));
    req.on("end", () => {
      const t = (data || "").trim();
      if (!t) return resolve({});
      if (t.startsWith("{") || t.startsWith("[")) {
        try { resolve(JSON.parse(t)); } catch { resolve({}); }
      } else {
        resolve({ userMessage: t });
      }
    });
    req.on("error", reject);
  });
}

// ---------- OpenAI helpers ----------
async function oaJson(path, method, body) {
  const r = await fetch(`https://api.openai.com/v1${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const errTxt = await r.text().catch(() => "");
    throw new Error(`${method} ${path} failed: ${r.status} ${errTxt}`);
  }
  return r.json();
}

function pickModel({ stream }) {
  // Guard: Responses streaming is NOT supported by 3.5.
  const m = (OPENAI_MODEL || "").trim();
  const is35 = /^gpt-3\.5/i.test(m);
  if (stream && is35) return "gpt-4o-mini"; // auto-upgrade for streaming
  return m || "gpt-4o-mini";
}

// Build a Responses API request payload
function buildResponsesRequest({ userMessage, stream }) {
  const systemPreamble =
    "You are Talking Care Navigator. Be concise, practical, and cite official UK guidance at the end.";
  return {
    model: pickModel({ stream }),
    input: [
      { role: "system", content: systemPreamble },
      { role: "user",   content: userMessage }
    ],
    stream: !!stream,
  };
}

// ---------- Non-streaming ----------
async function handleNonStreaming(userMessage) {
  const payload = buildResponsesRequest({ userMessage, stream: false });
  const resp = await oaJson("/responses", "POST", payload);

  let text = "";
  if (resp && Array.isArray(resp.output)) {
    for (const item of resp.output) {
      if (item.type === "output_text" && typeof item.text === "string") {
        text += item.text;
      }
    }
  }
  const usage = resp?.usage || null;
  return { ok: true, text, usage };
}

// ---------- Streaming ----------
async function handleStreaming(res, userMessage) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": CORS_ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
  });

  const forward = (event, data) => {
    try {
      if (event) res.write(`event: ${event}\n`);
      if (data !== undefined) res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
    } catch {}
  };

  forward("start", { ok: true });

  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    },
    body: JSON.stringify(buildResponsesRequest({ userMessage, stream: true })),
  });

  if (!upstream.ok || !upstream.body) {
    const errTxt = await upstream.text().catch(() => "");
    forward("error", { ok: false, step: "responses_stream", error: errTxt || upstream.status });
    try { res.end(); } catch {}
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8");
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true })); // keep OpenAI event names intact
    }
  } catch {
  } finally {
    forward("done", "[DONE]");
    try { res.end(); } catch {}
  }
}

// ---------- Main ----------
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return endPreflight(res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const body = await readBody(req);
    const userMessage = (body.userMessage || "").toString().trim();
    const mode = (req.query.stream || "off").toString(); // "on" | "off"
    if (!userMessage) return res.status(400).json({ ok: false, error: "Missing userMessage" });

    if (mode === "on") {
      return await handleStreaming(res, userMessage);
    } else {
      const out = await handleNonStreaming(userMessage);
      return res.status(200).json(out);
    }
  } catch (err) {
    console.error("assistant handler error:", err);
    try { return res.status(500).json({ ok: false, error: "Internal Server Error" }); }
    catch {}
  }
}
