// api/assistant.js
//
// One endpoint, two modes using the OpenAI "Responses" API:
//
//  • Non-streaming  : POST /api/assistant?stream=off  -> JSON { ok, text, usage }
//  • Streaming (SSE): POST /api/assistant?stream=on   -> raw SSE forwarded as-is
//
// Why Responses API?
// - Clean SSE (events: response.output_text.delta, response.completed, etc.).
// - Avoids threads/runs race conditions and 404/invalid run_id problems.
// - Faster first token than polling runs.
//
// Notes
// - We accept JSON and text/plain (Squarespace sometimes posts text/plain).
// - CORS tuned for Squarespace/Firefox.
// - You can keep your Squarespace widget code unchanged; it already expects
//   "response.output_text.delta" which this emits.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini"; // pick what you want
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
function endPreflight(res) {
  res.statusCode = 204;
  res.end();
}

// ---------- Body parsing ----------
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;

  return await new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const t = (data || "").trim();
      if (!t) return resolve({});
      // If JSON, parse; else treat as raw text as the user message
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
      "OpenAI-Beta": "responses=v1"
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!r.ok) {
    const errTxt = await r.text().catch(() => "");
    throw new Error(`${method} ${path} failed: ${r.status} ${errTxt}`);
  }
  return r.json();
}

// Build a Responses API request payload
function buildResponsesRequest(userMessage, opts = {}) {
  const systemPreamble =
    "You are Talking Care Navigator. Be concise, practical, and cite official UK guidance at the end.";

  return {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: systemPreamble },
      { role: "user",   content: userMessage }
    ],
    ...opts,
  };
}

// ---------- Non-streaming path ----------
async function handleNonStreaming(userMessage) {
  const payload = buildResponsesRequest(userMessage, { stream: false });

  const resp = await oaJson("/responses", "POST", payload)
    .catch(e => { console.error("OpenAI error", e); return null; });
  if (!resp) return { ok: false, text: "", usage: null };

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

// ---------- Streaming path ----------
async function handleStreaming(res, userMessage) {
  // Tell the browser we’ll stream SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": CORS_ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
  });
  res.flushHeaders?.();  // push headers immediately

  const forward = (event, data) => {
    try {
      if (event) res.write(`event: ${event}\n`);
      if (data !== undefined) res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
      res.flush?.();      // flush each block
    } catch {}
  };

  forward("start", { ok: true });

  // Request streaming from OpenAI
  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "OpenAI-Beta": "responses=v1"
    },
    body: JSON.stringify(buildResponsesRequest(userMessage, { stream: true })),
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
      const chunk = decoder.decode(value, { stream: true });
      res.write(chunk);
      res.flush?.();      // flush each chunk
    }
  } catch {
  } finally {
    forward("done", "[DONE]");
    try { res.end(); } catch {}
  }
}

// ---------- Main handler ----------
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
    const mode = (req.query.stream || "off").toString();

    if (!userMessage) {
      return res.status(400).json({ ok: false, error: "Missing userMessage" });
    }

    if (mode === "on") {
      return await handleStreaming(res, userMessage);
    } else {
      const out = await handleNonStreaming(userMessage);
      return res.status(200).json(out);
    }
  } catch (err) {
    console.error("assistant handler error:", err);
    try {
      return res.status(500).json({ ok: false, error: "Internal Server Error" });
    } catch {}
  }
}
