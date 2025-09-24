// /api/assistant.js
//
// Retrieval-first + optional web + rolling context + per-turn file attachments
//
// Required env vars
//  - OPENAI_API_KEY
//  - OPENAI_ASSISTANT_ID
//  - OPENAI_VECTOR_STORE_ID
//
// Optional
//  - OPENAI_MODEL (default: gpt-4o-mini)
//  - OPENAI_ENABLE_WEB_SEARCH ("1" to allow web fallback)
//  - CORS_ALLOW_ORIGIN (default: https://tc-assistant-proxy.vercel.app)
//  - DEBUG_SSE_LOG ("1" to mirror deltas/tool calls to logs)

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
if (!OPENAI_ASSISTANT_ID) console.warn("[assistant] OPENAI_ASSISTANT_ID not set — using fallback system instructions.");
if (!OPENAI_VECTOR_STORE_ID) console.error("[assistant] Missing OPENAI_VECTOR_STORE_ID — retrieval cannot run with /responses+file_search");

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
      "OpenAI-Beta": "assistants=v2",
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
Search the document library first using the file_search tool and base your answer on those documents.
Only if no relevant passages are found may you consider other enabled tools (e.g., web_search). Clearly separate any web sources in the final "Sources" list.
Do not include inline URLs, bracketed numbers like [1], or footnotes inside the body. Only list sources once at the end under "Sources".
Prefer short verbatim quotes for key definitions and include paragraph or section numbers where available.
If nothing relevant is found in the library, say exactly: "No matching sources found in the library."
Never answer purely from general knowledge without sources.
`.trim();
  return `${sys}\n\n${policy}`;
}

// ---------- Tools config ----------
function getTools() {
  const tools = [{
    type: "file_search",
    vector_store_ids: [OPENAI_VECTOR_STORE_ID],
  }];
  if (ENABLE_WEB_SEARCH) tools.push({ type: "web_search" });
  return tools;
}

// ---------- History trimming ----------
function normalizeHistory(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const m of raw) {
    if (!m || typeof m.content !== "string") continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    out.push({ role: m.role, content: m.content });
  }
  return out;
}
function trimHistoryByChars(hist, maxChars = 8000) {
  let acc = 0;
  const rev = [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const c = hist[i]?.content || "";
    acc += c.length;
    rev.push(hist[i]);
    if (acc >= maxChars) break;
  }
  return rev.reverse();
}

// ---------- Build Responses request with optional attachments ----------
function buildResponsesRequest(historyArr, userMessage, sysInstructions, fileIds = [], extra = {}) {
  const groundedSys = withGroundingPolicy(sysInstructions);
  const tools = getTools();

  const input = [{ role: "system", content: groundedSys }];
  for (const m of historyArr) input.push(m);

  // Attach files to THIS user turn so file_search can read them
  if (userMessage) {
    const attachments = (fileIds || []).map(id => ({
      file_id: id,
      tools: [{ type: "file_search" }]
    }));
    input.push({
      role: "user",
      content: userMessage,
      ...(attachments.length ? { attachments } : {})
    });
  }

  return {
    model: OPENAI_MODEL,
    input,
    tools,
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
async function handleNonStreaming(userMessage, history, fileIds) {
  const sys = await fetchAssistantInstructions();
  const payload = buildResponsesRequest(history, userMessage, sys, fileIds, { stream: false });
  const resp = await oaJson("/responses", "POST", payload);
  const text = extractTextFromResponse(resp);
  const usage = resp?.usage || null;
  return { ok: true, text, usage };
}

// ---------- Streaming (SSE passthrough) ----------
async function handleStreaming(res, userMessage, history, fileIds) {
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
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify(buildResponsesRequest(history, userMessage, sys, fileIds, { stream: true })),
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
      } else if (event.startsWith("response.tool_call")) {
        try {
          const d = JSON.parse(raw);
          const name = d?.name || d?.tool?.name || d?.data?.name || "(unknown)";
          console.log("[assistant][SSE][tool_call]", event, name);
        } catch {
          console.log("[assistant][SSE][tool_call]", event);
        }
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
    // client aborted / network issue
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
    const clientHistory = normalizeHistory(body.history || []);
    const trimmedHistory = trimHistoryByChars(clientHistory, 8000);
    const fileIds = Array.isArray(body.fileIds) ? body.fileIds.filter(s => typeof s === "string" && s.trim()) : [];
    const mode = (req.query.stream || "off").toString();

    if (!userMessage) {
      return res.status(400).json({ ok:false, error: "Missing userMessage" });
    }
    if (!OPENAI_VECTOR_STORE_ID) {
      return res.status(500).json({ ok:false, error: "Server misconfig: OPENAI_VECTOR_STORE_ID not set" });
    }

    if (mode === "on") {
      return await handleStreaming(res, userMessage, trimmedHistory, fileIds);
    } else {
      const out = await handleNonStreaming(userMessage, trimmedHistory, fileIds);
      return res.status(200).json(out);
    }
  } catch (err) {
    console.error("assistant handler error:", err);
    try {
      return res.status(500).json({ ok:false, error: "Internal Server Error" });
    } catch {}
  }
}
