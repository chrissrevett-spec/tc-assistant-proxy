// /api/assistant.js
//
// One endpoint, two modes using OpenAI "Responses" API:
//
//  • Non-streaming  : POST /api/assistant?stream=off  -> JSON { ok, text, usage }
//  • Streaming (SSE): POST /api/assistant?stream=on   -> raw SSE forwarded as-is
//
// Updates in this version:
// - (1) Logs Assistants/Vector-Store retrieval tool calls seen in SSE
//       (events: response.tool_call.*) without changing the forwarded stream.
// - (2) Sets response_format: "verbose_json" for both streaming and non-streaming
//       to expose richer metadata (does not affect your UI streaming).
//
// Existing behavior, stability, and client-side logic remain unchanged.

const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;
const OPENAI_MODEL        = process.env.OPENAI_MODEL || "gpt-4o-mini"; // must support Responses streaming
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || "";     // used only to fetch system instructions
const CORS_ALLOW_ORIGIN   = process.env.CORS_ALLOW_ORIGIN || "https://tc-assistant-proxy.vercel.app";
const CORS_ALLOW_METHODS  = process.env.CORS_ALLOW_METHODS || "GET, POST, OPTIONS";
const CORS_ALLOW_HEADERS  = process.env.CORS_ALLOW_HEADERS || "Content-Type, Accept";
const CORS_MAX_AGE        = "86400";

if (!OPENAI_API_KEY) {
  console.error("[assistant] Missing OPENAI_API_KEY");
}
if (!OPENAI_ASSISTANT_ID) {
  console.warn("[assistant] OPENAI_ASSISTANT_ID not set — will use fallback system instructions.");
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

// ---------- Assistants API: fetch system instructions (with small cache) ----------
const INSTR_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let instrCache = { text: "", at: 0 };

async function fetchAssistantInstructions() {
  // If no Assistant ID, skip to fallback
  if (!OPENAI_ASSISTANT_ID) {
    return "You are Talking Care Navigator. Be concise, practical, UK-focused, and cite official guidance at the end when relevant.";
  }

  // Use cache if fresh
  const now = Date.now();
  if (instrCache.text && now - instrCache.at < INSTR_CACHE_TTL_MS) {
    return instrCache.text;
  }

  // Fetch from Assistants API (v2)
  try {
    const r = await fetch(`https://api.openai.com/v1/assistants/${OPENAI_ASSISTANT_ID}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2",
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
    });

    if (!r.ok) {
      const errTxt = await r.text().catch(() => "");
      console.warn(`[assistant] Failed to fetch assistant instructions: ${r.status} ${errTxt}`);
      // fallback
      return "You are Talking Care Navigator. Be concise, practical, UK-focused, and cite official guidance at the end when relevant.";
    }

    const data = await r.json();
    const sys = (data && typeof data.instructions === "string" && data.instructions.trim())
      ? data.instructions.trim()
      : "";

    const finalSys = sys || "You are Talking Care Navigator. Be concise, practical, UK-focused, and cite official guidance at the end when relevant.";

    instrCache = { text: finalSys, at: now };
    console.info("[assistant] Using system instructions from Assistant:", {
      id: data?.id, hasInstructions: !!sys
    });
    return finalSys;
  } catch (e) {
    console.warn("[assistant] Error fetching assistant instructions:", e?.message || e);
    return "You are Talking Care Navigator. Be concise, practical, UK-focused, and cite official guidance at the end when relevant.";
  }
}

// ---------- Build Responses request ----------
// IMPORTANT: response_format: "verbose_json" for richer metadata.
function buildResponsesRequest(userMessage, sysInstructions, extra = {}) {
  return {
    model: OPENAI_MODEL,
    response_format: "verbose_json",
    input: [
      { role: "system", content: sysInstructions },
      { role: "user",   content: userMessage }
    ],
    ...extra,
  };
}

// Extract text from Responses JSON
function extractTextFromResponse(resp) {
  let out = "";

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
  if (!out && typeof resp?.text === "string") out = resp.text;
  if (!out && typeof resp?.response?.output_text === "string") out = resp.response.output_text;

  return out || "";
}

// ---------- Utility: compact log for tool events ----------
function logToolEvent(eventName, raw) {
  try {
    const d = typeof raw === "string" ? JSON.parse(raw) : raw;
    // The SSE "data" for tool events typically contains:
    // { type, tool_call_id, tool_name, status, ... } with optional input/output
    const type = d?.type || eventName;
    const toolName = d?.tool_name || d?.name || d?.tool || "unknown_tool";
    const callId = d?.tool_call_id || d?.id || "unknown_call";
    const status  = d?.status || d?.state || undefined;

    // Try to surface any retrieved file ids / quotes if present
    let fileIds = [];
    let quotes  = [];

    // Common shapes:
    // - d.output: [ { file_id, quote, ... }, ... ]
    // - d.result?.items or d.items
    const outputs = Array.isArray(d?.output) ? d.output : (Array.isArray(d?.items) ? d.items : []);
    for (const it of outputs) {
      if (it?.file_id) fileIds.push(it.file_id);
      if (it?.quote) quotes.push(it.quote.slice(0, 140)); // trim for logs
    }
    if (!fileIds.length && d?.file_id) fileIds = [d.file_id];

    console.info("[assistant][tool]", {
      event: eventName,
      type,
      toolName,
      callId,
      status,
      fileIds: fileIds.length ? fileIds : undefined,
      quotes: quotes.length ? quotes : undefined,
    });
  } catch (e) {
    console.info("[assistant][tool]", eventName, "(unparsed)", (typeof raw === "string" ? raw.slice(0, 500) : raw));
  }
}

// ---------- Non-streaming ----------
async function handleNonStreaming(userMessage) {
  const sys = await fetchAssistantInstructions();
  const payload = buildResponsesRequest(userMessage, sys, { stream: false });
  const resp = await oaJson("/responses", "POST", payload);

  // Optional: log any tool-ish artifacts found in non-stream response
  try {
    if (Array.isArray(resp?.output)) {
      for (const item of resp.output) {
        if (item?.type && String(item.type).includes("tool")) {
          console.info("[assistant][tool][nonstream]", item.type);
        }
      }
    }
  } catch {}

  const text = extractTextFromResponse(resp);
  const usage = resp?.usage || null;
  return { ok: true, text, usage };
}

// ---------- Streaming (SSE passthrough + server-side tee for logs) ----------
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

  // Signal start
  send("start", { ok: true });

  // Fetch system instructions (cached) before opening upstream stream
  const sys = await fetchAssistantInstructions();

  // Kick off upstream streaming to Responses API
  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    },
    body: JSON.stringify(buildResponsesRequest(userMessage, sys, { stream: true })),
  });

  if (!upstream.ok || !upstream.body) {
    const errTxt = await upstream.text().catch(() => "");
    send("error", { ok:false, step:"responses_stream", error: errTxt || upstream.status });
    try { res.end(); } catch {}
    return;
  }

  // ----- Tee the SSE stream: forward bytes unchanged, but also parse & log tool events -----
  const reader  = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const flushBlocksForLogs = (chunk) => {
    buffer += chunk;
    const blocks = buffer.split(/\n\n/);
    buffer = blocks.pop();
    for (const block of blocks) {
      const lines = block.split(/\n/);
      let event = "message";
      const dataLines = [];
      for (const line of lines) {
        if (!line) continue;
        if (line.startsWith(":")) continue; // comment/keepalive
        if (line.startsWith("event:")) { event = line.slice(6).trim(); continue; }
        if (line.startsWith("data:"))  { dataLines.push(line.slice(5).trim()); continue; }
      }
      const raw = dataLines.join("\n");

      // Log tool events only (prove retrieval beyond doubt)
      if (event.startsWith("response.tool_call")) {
        logToolEvent(event, raw);
      }
      // On completion, log a compact summary (usage tokens etc.)
      if (event === "response.completed") {
        try {
          const d = JSON.parse(raw);
          const u = d?.response?.usage || d?.usage || null;
          console.info("[assistant][completed]", {
            tokens: u ? {
              input: u.input_tokens,
              output: u.output_tokens,
              total: u.total_tokens
            } : undefined
          });
        } catch {
          console.info("[assistant][completed] (raw)", raw?.slice(0, 800));
        }
      }
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      // Forward to client exactly as-is
      try { res.write(decoder.decode(value, { stream: true })); } catch {}

      // ALSO parse for server logs (does not affect client)
      try { flushBlocksForLogs(decoder.decode(value, { stream: true })); } catch {}
    }
  } catch {
    // client aborted / network glitch
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
