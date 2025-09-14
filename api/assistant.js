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
// - Non-streaming extracts text from *all* possible places to avoid blank outputs.
// - NEW: system instructions are fetched dynamically from your Assistant (if OPENAI_ASSISTANT_ID is set)
//        and cached in-memory for a short period. Falls back to a safe default if not set/available.

const OPENAI_API_KEY     = process.env.OPENAI_API_KEY;
const OPENAI_MODEL       = process.env.OPENAI_MODEL || "gpt-4o-mini"; // must support Responses streaming
const OPENAI_ASSISTANT_ID= process.env.OPENAI_ASSISTANT_ID || "";     // optional; enables dynamic instructions

const CORS_ALLOW_ORIGIN  = process.env.CORS_ALLOW_ORIGIN  || "https://tc-assistant-proxy.vercel.app";
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

// ---------- Assistant instructions (dynamic) ----------
const FALLBACK_INSTRUCTIONS =
  "You are Talking Care Navigator. Be concise, practical, UK-focused, and cite official guidance at the end when relevant.";

let cachedInstr = null;
let cachedAt = 0;
const INSTR_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getAssistantInstructions() {
  // If no Assistant ID, use fallback
  if (!OPENAI_ASSISTANT_ID) {
    return FALLBACK_INSTRUCTIONS;
  }

  const now = Date.now();
  if (cachedInstr && (now - cachedAt) < INSTR_TTL_MS) {
    return cachedInstr;
  }

  try {
    const resp = await fetch(`https://api.openai.com/v1/assistants/${OPENAI_ASSISTANT_ID}`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` }
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      console.warn("Failed to fetch assistant instructions:", resp.status, t);
      return FALLBACK_INSTRUCTIONS;
    }
    const data = await resp.json();
    const instructions = (data && typeof data.instructions === "string" && data.instructions.trim())
      ? data.instructions
      : FALLBACK_INSTRUCTIONS;

    cachedInstr = instructions;
    cachedAt = now;
    return instructions;
  } catch (e) {
    console.warn("Error fetching assistant instructions:", e?.message || e);
    return FALLBACK_INSTRUCTIONS;
  }
}

// Build a Responses API request payload (uses dynamic instructions if available)
async function buildResponsesRequest(userMessage, extra = {}) {
  const systemPreamble = await getAssistantInstructions();
  return {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: systemPreamble },
      { role: "user",   content: userMessage }
    ],
    ...extra,
  };
}

// Extracts text from a Responses API JSON object (works for stream==false reply)
function extractTextFromResponse(resp) {
  let out = "";

  // 1) Standard Responses output format
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

  // 2) Convenience `text` field if present
  if (!out && typeof resp?.text === "string") out = resp.text;

  // 3) Older nesting variants
  if (!out && typeof resp?.response?.output_text === "string") out = resp.response.output_text;

  return out || "";
}

// ---------- Non-streaming ----------
async function handleNonStreaming(userMessage) {
  const payload = await buildResponsesRequest(userMessage, { stream: false });
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

  const send = (event, data) => {
    try {
      if (event) res.write(`event: ${event}\n`);
      if (data !== undefined) res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
    } catch {}
  };

  // Optional: let the client know the stream has started
  send("start", { ok: true, using_system_instructions: !!OPENAI_ASSISTANT_ID });

  // Kick off upstream streaming
  const body = await buildResponsesRequest(userMessage, { stream: true });
  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    },
    body: JSON.stringify(body),
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
      try { res.write(decoder.decode(value, { stream: true })); } catch {}
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
