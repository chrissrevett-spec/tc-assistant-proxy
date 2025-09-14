// /api/assistant.js
//
// One endpoint, two modes using OpenAI APIs:
//
//  • Non-streaming  : POST /api/assistant?stream=off  -> JSON { ok, text, usage }
//  • Streaming (SSE): POST /api/assistant?stream=on   -> raw SSE forwarded as-is
//
// Enhancements in this version:
// - If OPENAI_ASSISTANT_ID is set, calls the Assistants Responses endpoint
//   (/v1/assistants/{id}/responses) so your Assistant’s vector store & tools are used.
// - Passes your live system instructions (fetched via Assistants v2) as `instructions`
//   on each call, so changes in the dashboard take effect immediately.
// - Falls back to plain /v1/responses when OPENAI_ASSISTANT_ID is not set.
// - Keeps all previous behavior, signatures, and SSE event passthrough intact.

const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;
const OPENAI_MODEL        = process.env.OPENAI_MODEL || "gpt-4o-mini"; // used in fallback (/responses)
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || "";     // enables vector store flow
const CORS_ALLOW_ORIGIN   = process.env.CORS_ALLOW_ORIGIN || "https://tc-assistant-proxy.vercel.app";
const CORS_ALLOW_METHODS  = process.env.CORS_ALLOW_METHODS || "GET, POST, OPTIONS";
const CORS_ALLOW_HEADERS  = process.env.CORS_ALLOW_HEADERS || "Content-Type, Accept";
const CORS_MAX_AGE        = "86400";

if (!OPENAI_API_KEY) {
  console.error("[assistant] Missing OPENAI_API_KEY");
}
if (!OPENAI_ASSISTANT_ID) {
  console.warn("[assistant] OPENAI_ASSISTANT_ID not set — using fallback /responses (no vector store).");
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
  const fallback =
    "You are Talking Care Navigator. Be concise, practical, UK-focused, and cite official guidance at the end when relevant.";

  if (!OPENAI_ASSISTANT_ID) return fallback; // fallback when no assistant id

  const now = Date.now();
  if (instrCache.text && now - instrCache.at < INSTR_CACHE_TTL_MS) {
    return instrCache.text;
  }

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
      return fallback;
    }

    const data = await r.json();
    const sys = (data && typeof data.instructions === "string" && data.instructions.trim())
      ? data.instructions.trim()
      : "";

    const finalSys = sys || fallback;
    instrCache = { text: finalSys, at: now };
    return finalSys;
  } catch (e) {
    console.warn("[assistant] Error fetching assistant instructions:", e?.message || e);
    return fallback;
  }
}

// ---------- Builders ----------
function buildResponsesRequest(userMessage, sysInstructions, extra = {}) {
  // Used for the plain /v1/responses fallback (no vector store)
  return {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: sysInstructions },
      { role: "user",   content: userMessage }
    ],
    ...extra,
  };
}

function buildAssistantResponsesRequest(userMessage, sysInstructions, extra = {}) {
  // Used for /v1/assistants/{id}/responses (assistant brings vector store/tools/model)
  // `instructions` augments/overrides the Assistant’s baseline instructions per request.
  return {
    instructions: sysInstructions,
    input: [
      { role: "user", content: userMessage }
    ],
    ...extra,
  };
}

// Extract text from Responses JSON (covers both endpoints)
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

// ---------- Non-streaming ----------
async function handleNonStreaming(userMessage) {
  const sys = await fetchAssistantInstructions();

  // Use Assistant Responses if assistant id present (vector store path), else fallback
  if (OPENAI_ASSISTANT_ID) {
    const payload = buildAssistantResponsesRequest(userMessage, sys, { stream: false });
    const resp = await oaJson(`/assistants/${OPENAI_ASSISTANT_ID}/responses`, "POST", payload, {
      "OpenAI-Beta": "assistants=v2",
    });
    const text = extractTextFromResponse(resp);
    const usage = resp?.usage || null;
    return { ok: true, text, usage };
  } else {
    const payload = buildResponsesRequest(userMessage, sys, { stream: false });
    const resp = await oaJson("/responses", "POST", payload);
    const text = extractTextFromResponse(resp);
    const usage = resp?.usage || null;
    return { ok: true, text, usage };
  }
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

  // Signal start
  send("start", { ok: true });

  // Fetch system instructions (cached) before opening upstream stream
  const sys = await fetchAssistantInstructions();

  // Choose endpoint + headers
  const isAssistantFlow = !!OPENAI_ASSISTANT_ID;
  const url = isAssistantFlow
    ? `https://api.openai.com/v1/assistants/${OPENAI_ASSISTANT_ID}/responses`
    : "https://api.openai.com/v1/responses";

  const payload = isAssistantFlow
    ? buildAssistantResponsesRequest(userMessage, sys, { stream: true })
    : buildResponsesRequest(userMessage, sys, { stream: true });

  const headers = {
    "Authorization": `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    ...(isAssistantFlow ? { "OpenAI-Beta": "assistants=v2" } : {}),
  };

  // Kick off upstream streaming
  const upstream = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!upstream.ok || !upstream.body) {
    const errTxt = await upstream.text().catch(() => "");
    send("error", { ok:false, step:"responses_stream", error: errTxt || upstream.status });
    try { res.end(); } catch {}
    return;
  }

  // Pass bytes through unmodified so event names remain intact
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8");

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      try { res.write(decoder.decode(value, { stream: true })); } catch {}
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
