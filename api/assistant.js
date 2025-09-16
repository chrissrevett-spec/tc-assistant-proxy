// /api/assistant.js
//
// Two modes via OpenAI "Responses" API:
//  • Non-streaming  : POST /api/assistant?stream=off  -> JSON { ok, text, usage }
//  • Streaming (SSE): POST /api/assistant?stream=on   -> raw SSE forwarded as-is
//
// What this version adds
// 1) Hosted retrieval ON by default (File Search) using your Vector Store
// 2) Optional Web Search fallback if OPENAI_ENABLE_WEB_SEARCH=1
// 3) A strict grounding policy that tells the model to search the store first
// 4) Clean SSE passthrough plus useful error surfacing
//
// Required env vars
//  - OPENAI_API_KEY
//  - OPENAI_ASSISTANT_ID
//  - OPENAI_VECTOR_STORE_ID
// Optional env vars
//  - OPENAI_MODEL                (default: gpt-4o-mini)
//  - OPENAI_ENABLE_WEB_SEARCH    ("1" to enable Responses web_search tool)
//  - CORS_ALLOW_ORIGIN           (your site origin)
//  - DEBUG_SSE_LOG               ("1" to mirror key SSE deltas to server logs)

const OPENAI_API_KEY          = process.env.OPENAI_API_KEY;
const OPENAI_MODEL            = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_ASSISTANT_ID     = process.env.OPENAI_ASSISTANT_ID || "";
const OPENAI_VECTOR_STORE_ID  = process.env.OPENAI_VECTOR_STORE_ID || "";
const ENABLE_WEB_SEARCH       = process.env.OPENAI_ENABLE_WEB_SEARCH === "1";

const CORS_ALLOW_ORIGIN       = process.env.CORS_ALLOW_ORIGIN || "https://tc-assistant-proxy.vercel.app";
const CORS_ALLOW_METHODS      = process.env.CORS_ALLOW_METHODS || "GET, POST, OPTIONS";
const CORS_ALLOW_HEADERS      = process.env.CORS_ALLOW_HEADERS || "Content-Type, Accept";
const CORS_MAX_AGE            = "86400";
const DEBUG_SSE_LOG           = process.env.DEBUG_SSE_LOG === "1";

if (!OPENAI_API_KEY) console.error("[assistant] Missing OPENAI_API_KEY");
if (!OPENAI_ASSISTANT_ID) console.warn("[assistant] OPENAI_ASSISTANT_ID not set — will use fallback system instructions.");
if (!OPENAI_VECTOR_STORE_ID) console.warn("[assistant] OPENAI_VECTOR_STORE_ID not set — retrieval will be disabled.");

// ---------- CORS ----------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
  res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  res.setHeader("Access-Control-Max-Age", CORS_MAX_AGE);
}
function endPreflight(res) { res.statusCode = 204; res.end(); }

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

// ---------- Assistant instructions (small cache) ----------
const INSTR_CACHE_TTL_MS = 5 * 60 * 1000;
let instrCache = { text: "", at: 0 };

async function fetchAssistantInstructions() {
  if (!OPENAI_ASSISTANT_ID) {
    return "You are Talking Care Navigator. Be concise, practical, UK-focused, and cite official guidance at the end when relevant.";
  }
  const now = Date.now();
  if (instrCache.text && now - instrCache.at < INSTR_CACHE_TTL_MS) return instrCache.text;

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
      console.warn(`[assistant] Failed to fetch assistant: ${r.status} ${errTxt}`);
      return "You are Talking Care Navigator. Be concise, practical, UK-focused, and cite official guidance at the end when relevant.";
    }
    const data = await r.json();
    const sys = (data && typeof data.instructions === "string" && data.instructions.trim()) ? data.instructions.trim() : "";
    const finalSys = sys || "You are Talking Care Navigator. Be concise, practical, UK-focused, and cite official guidance at the end when relevant.";
    instrCache = { text: finalSys, at: now };
    console.info("[assistant] Using system instructions from Assistant:", { id: OPENAI_ASSISTANT_ID, hasInstructions: !!sys });
    return finalSys;
  } catch (e) {
    console.warn("[assistant] Error fetching assistant instructions:", e?.message || e);
    return "You are Talking Care Navigator. Be concise, practical, UK-focused, and cite official guidance at the end when relevant.";
  }
}

// ---------- Grounding policy ----------
function withGroundingPolicy(sys) {
  const policy = `
CRITICAL GROUNDING POLICY:
Always search the attached document library first using the file_search tool. Use retrieved passages to ground your answer and include short verbatim quotes and paragraph or section numbers when available.
If the library does not contain sufficient material, you may broaden the search using web_search (if available), but clearly label any web sources.
If no relevant sources are found, say "No matching sources found in the library" and ask for a more specific question. Do not answer from general knowledge without sources.
End every answer with a "Sources" list containing the PDF filenames used and any URLs if web_search was required.
`.trim();
  return `${sys}\n\n${policy}`;
}

// ---------- Tools config ----------
function getToolsAndResources() {
  const tools = [];
  const tool_resources = {};

  if (OPENAI_VECTOR_STORE_ID) {
    tools.push({ type: "file_search" });
    tool_resources.file_search = { vector_store_ids: [OPENAI_VECTOR_STORE_ID] };
  }
  if (ENABLE_WEB_SEARCH) {
    tools.push({ type: "web_search" });
    // no extra config required for web_search
  }
  return { tools, tool_resources: Object.keys(tool_resources).length ? tool_resources : undefined };
}

// ---------- Build Responses request ----------
function buildResponsesRequest(userMessage, sysInstructions, extra = {}) {
  const groundedSys = withGroundingPolicy(sysInstructions);
  const { tools, tool_resources } = getToolsAndResources();

  return {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: groundedSys },
      { role: "user",   content: userMessage }
    ],
    ...(tools.length ? { tools } : {}),
    ...(tool_resources ? { tool_resources } : {}),
    text: { format: { type: "text" }, verbosity: "medium" },
    ...extra,
  };
}

// ---------- Helpers ----------
function extractTextFromResponse(resp) {
  let out = "";
  if (Array.isArray(resp?.output)) {
    for (const item of resp.output) {
      if (item?.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part?.type === "output_text" && typeof part.text === "string") out += part.text;
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
  const payload = buildResponsesRequest(userMessage, sys, { stream: false });
  const resp = await oaJson("/responses", "POST", payload);
  const text = extractTextFromResponse(resp);
  const usage = resp?.usage || null;
  return { ok: true, text, usage };
}

// ---------- Streaming (SSE passthrough) ----------
async function handleStreaming(res, userMessage) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
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

  send("start", { ok: true });
  const sys = await fetchAssistantInstructions();

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
    let errTxt = "";
    try { errTxt = await upstream.text(); } catch {}
    send("error", { ok:false, step:"responses_stream", status: upstream.status, error: errTxt || "no-body" });
    try { res.end(); } catch {}
    return;
  }

  const reader  = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8");

  // Optional: mirror key SSE events into server logs
  let logBuf = "";
  const maybeLogChunk = (chunkStr) => {
    if (!DEBUG_SSE_LOG) return;
    logBuf += chunkStr;
    const blocks = logBuf.split("\n\n");
    logBuf = blocks.pop() || "";
    for (const block of blocks) {
      const lines = block.split("\n");
      let event = "message";
      const dataLines = [];
      for (const line of lines) {
        if (!line || line.startsWith(":")) continue;
        if (line.startsWith("event:")) { event = line.slice(6).trim(); continue; }
        if (line.startsWith("data:"))  { dataLines.push(line.slice(5).trim()); continue; }
      }
      const raw = dataLines.join("\n");
      if (event === "response.output_text.delta") {
        try {
          const d = JSON.parse(raw);
          if (typeof d?.delta === "string" && d.delta.trim()) {
            console.log("[assistant][SSE][delta]", d.delta.slice(0, 200));
          }
        } catch {}
      } else if (event === "response.completed") {
        console.log("[assistant][SSE] completed");
      } else if (event === "error") {
        console.warn("[assistant][SSE] error", raw);
      }
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunkStr = decoder.decode(value, { stream: true });
      try { res.write(chunkStr); } catch {}
      maybeLogChunk(chunkStr);
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
