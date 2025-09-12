// /api/assistant.js
//
// One endpoint, two modes using OpenAI "Responses" API:
//
//  • Non-streaming  : POST /api/assistant?stream=off  -> JSON { ok, text, usage }
//  • Streaming (SSE): POST /api/assistant?stream=on   -> raw SSE forwarded as-is
//
// Notes
// - Uses Responses API so we avoid threads/runs race conditions entirely.
// - Robust body parsing (handles Squarespace/Firefox text/plain).
// - CORS is configurable via env; default is the widget's own origin.
// - Non-streaming now extracts text from *all* possible places to avoid blank outputs.

const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;
const OPENAI_MODEL       = process.env.OPENAI_MODEL || "gpt-4o-mini"; // must support Responses streaming
const CORS_ALLOW_ORIGIN  = process.env.CORS_ALLOW_ORIGIN || "https://tc-assistant-proxy.vercel.app";
const CORS_ALLOW_METHODS = process.env.CORS_ALLOW_METHODS || "GET, POST, OPTIONS";
const CORS_ALLOW_HEADERS = process.env.CORS_ALLOW_HEADERS || "Content-Type, Accept";
const CORS_MAX_AGE       = "86400";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
}

// ---------- CORS ----------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
  res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  res.setHeader("Access-Control-Max-Age", CORS_MAX_AGE);
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
async function oaJson(path, method, body, headers = {}) {
  const r = await fetch(`https://api.openai.com/v1${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const errTxt = await r.text().catch(() => "");
    throw new Error(`${method} ${path} failed: ${r.status} ${errTxt}`);
  }
  return r.json();
}

function buildResponsesRequest(userMessage, extra = {}) {
  return {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: "You are Talking Care Navigator. Be concise, practical, UK-focused, and cite official guidance at the end when relevant." },
      { role: "user",   content: userMessage }
    ],
    ...extra,
  };
}

// Extracts text from a Responses API JSON object (works for both stream==false reply and for post-hoc objects)
function extractTextFromResponse(resp) {
  // If SDK returns `output` array with items of type "message" containing content parts:
  let out = "";

  // 1) Try the documented `output` -> message -> content -> output_text parts
  if (Array.isArray(resp?.output)) {
    for (const item of resp.output) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part?.type === "output_text" && typeof part.text === "string") {
            out += part.text;
          }
        }
      }
    }
  }

  // 2) Some SDKs may also set a convenience `text` field (string)
  if (!out && typeof resp?.text === "string") out = resp.text;

  // 3) Some SDKs nest in `response.output_text` (older drafts)
  if (!out && typeof resp?.response?.output_text === "string") out = resp.response.output_text;

  // final fallback
  return out || "";
}

// ---------- Non-streaming ----------
async function handleNonStreaming(userMessage) {
  const payload = buildResponsesRequest(userMessage, { stream: false });
  const resp = await oaJson("/responses", "POST", payload);

  const text = extractTextFromResponse(resp);
  const usage = resp?.usage || null;
  return { ok: true, text, usage };
}

// ---------- Streaming (SSE passthrough) ----------
async function handleStreaming(res, userMessage) {
  // Tell the browser we’ll stream SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    // mirror CORS on stream
    "Access-Control-Allow-Origin": CORS_ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
  });

  const write = (chunk) => { try { res.write(chunk); } catch {} };
  const send = (event, data) => {
    try {
      if (event) res.write(`event: ${event}\n`);
      if (data !== undefined) res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
    } catch {}
  };

  // Optional: let the client know the stream has started
  send("start", { ok: true });

  // Kick off upstream streaming
  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    },
    body: JSON.stringify(buildResponsesRequest(userMessage, { stream: true })),
  });

  if (!upstream.ok || !upstream.body) {
    const errTxt = await upstream.text().catch(() => "");
    send("error", { ok:false, step:"responses_stream", error: errTxt || upstream.status });
    try { res.end(); } catch {}
    return;
  }

  // Pass bytes through unmodified so events (`response.output_text.delta`, etc.) remain intact
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8");

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      write(decoder.decode(value, { stream: true }));
    }
  } catch {
    // client aborted / network error — ignore
  } finally {
    send("done", "[DONE]");
    try { res.end(); } catch {}
  }
}

// ---------- Main handler ----------
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return endPreflight(res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok:false, error: "Method Not Allowed" });
  }

  try {
    const body = await readBody(req);
    const userMessage = (body.userMessage || "").toString().trim();
    const mode = (req.query.stream || "off").toString(); // "on" | "off"

    if (!userMessage) {
      return res.status(400).json({ ok:false, error: "Missing userMessage" });
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
      return res.status(500).json({ ok:false, error: "Internal Server Error" });
    } catch {}
  }
}
