// /api/assistant.js
//
// Responses API + retrieval-first with optional per-turn uploaded file:
// - Client uploads to /api/upload (purpose=assistants) and sends upload_file_id with the next turn.
// - We create a TEMP vector store for that file and (IMPORTANT) if a file is attached,
//   we search ONLY that temp store for this turn (no permanent library, no web search).
//
// API shape (current):
// tools: [{ type: "file_search", vector_store_ids: ["vs_id", ...] }, { type: "web_search" }]
// NO "tool_resources", NO "modalities".
// text.format must be an object with type in: "text" | "json_object" | "json_schema".
// We use { type: "text" } to avoid format errors.

const OPENAI_API_KEY          = process.env.OPENAI_API_KEY;
const OPENAI_MODEL            = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_ASSISTANT_ID     = process.env.OPENAI_ASSISTANT_ID || "";
const OPENAI_VECTOR_STORE_ID  = process.env.OPENAI_VECTOR_STORE_ID || ""; // permanent library
const ENABLE_WEB_SEARCH       = process.env.OPENAI_ENABLE_WEB_SEARCH === "1";

const CORS_ALLOW_METHODS      = process.env.CORS_ALLOW_METHODS || "GET, POST, OPTIONS";
const CORS_ALLOW_HEADERS      = process.env.CORS_ALLOW_HEADERS || "Content-Type, Accept";
const CORS_MAX_AGE            = "86400";
const DEBUG_SSE_LOG           = process.env.DEBUG_SSE_LOG === "1";

// Allow both direct Vercel testing and Squarespace
const ALLOWED_ORIGINS = [
  "https://tc-assistant-proxy.vercel.app",
  "https://www.talkingcare.uk"
];

if (!OPENAI_API_KEY) console.error("[assistant] Missing OPENAI_API_KEY");
if (!OPENAI_VECTOR_STORE_ID) console.error("[assistant] Missing OPENAI_VECTOR_STORE_ID — retrieval requires a base store");

function setCors(res, origin = "") {
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
  res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  res.setHeader("Access-Control-Max-Age", CORS_MAX_Age);
}
function endPreflight(res){ res.statusCode = 204; res.end(); }

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

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
    return finalSys;
  } catch {
    return "You are Talking Care Navigator. Be concise, practical, UK-focused, and cite official guidance at the end when relevant.";
  }
}

function withGroundingPolicy(sys, fileAttached = false) {
  // Base policy for normal turns
  const policy = `
CRITICAL GROUNDING POLICY:
Search the document library first using the file_search tool and base your answer on those documents.
Only if no relevant passages are found may you consider other enabled tools (e.g., web_search). Clearly separate any web sources in the final "Sources" list.
Do not include inline URLs, bracketed numbers like [1], or footnotes inside the body. Only list sources once at the end under "Sources".
Prefer short verbatim quotes for key definitions and include paragraph or section numbers where available.
If nothing relevant is found in the library, say exactly: "No matching sources found in the library."
Never answer purely from general knowledge without sources.
`.trim();

  // Tighter rule for upload turns:
  // We will attach ONLY the temp store as a tool on these turns, so the instruction aligns with capabilities.
  const uploadRule = fileAttached ? `
For this turn, ONLY use the uploaded document via file_search. Do not consult the permanent library and do not use web search.
If the uploaded document does not contain the answer, say exactly: "No matching sources found in the uploaded document."
`.trim() : "";

  return [sys, policy, uploadRule].filter(Boolean).join("\n\n");
}

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

// Create a temporary vector store, add file, poll until completed.
async function createTempVectorStoreWithFile(fileId) {
  const vs = await fetch("https://api.openai.com/v1/vector_stores", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({ name: `tmp_vs_${Date.now()}` }),
  });
  if (!vs.ok) throw new Error(`vector_stores create failed: ${vs.status} ${await vs.text()}`);
  const vsData = await vs.json();
  const vsId = vsData.id;

  const added = await fetch(`https://api.openai.com/v1/vector_stores/${vsId}/files`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!added.ok) throw new Error(`vector_stores add file failed: ${added.status} ${await added.text()}`);
  const add = await added.json();
  const addId = add.id || fileId;

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const stReq = await fetch(`https://api.openai.com/v1/vector_stores/${vsId}/files/${addId}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2",
      }
    });
    if (!stReq.ok) break;
    const st = await stReq.json();
    const state = st.status || st.state || "completed";
    if (state === "completed") return vsId;
    if (state === "failed" || state === "error") throw new Error(`Vector store ingestion failed: ${state}`);
    await new Promise(r => setTimeout(r, 800));
  }
  throw new Error("Vector store ingestion timeout");
}

// Build a properly shaped Responses API request.
// IMPORTANT: If tempVectorStoreId is present, we attach ONLY that store and NO web_search.
function buildResponsesRequest(historyArr, userMessage, sysInstructions, tempVectorStoreId = null, extra = {}) {
  const uploadTurn = Boolean(tempVectorStoreId);
  const groundedSys = withGroundingPolicy(sysInstructions, uploadTurn);

  const input = [{ role: "system", content: groundedSys }];
  for (const m of historyArr) input.push(m);
  if (userMessage) input.push({ role: "user", content: userMessage });

  // Vector stores:
  const tools = [];

  if (uploadTurn) {
    // 🔒 Upload turn: ONLY the temporary store (prevents accidental hits in your permanent library)
    tools.push({ type: "file_search", vector_store_ids: [tempVectorStoreId] });
  } else {
    // Normal turns: permanent library, plus optional web_search
    tools.push({ type: "file_search", vector_store_ids: [OPENAI_VECTOR_STORE_ID].filter(Boolean) });
    if (ENABLE_WEB_SEARCH) tools.push({ type: "web_search" });
  }

  return {
    model: OPENAI_MODEL,
    input,
    tools,
    text: { format: { type: "text" }, verbosity: "medium" },
    ...extra,
  };
}

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

async function handleNonStreaming(userMessage, history, uploadFileId) {
  const sys = await fetchAssistantInstructions();
  let tempVS = null;
  if (uploadFileId) {
    try { tempVS = await createTempVectorStoreWithFile(uploadFileId); }
    catch (e) { console.warn("temp vs ingest failed (non-stream):", e?.message || e); }
  }
  const payload = buildResponsesRequest(history, userMessage, sys, tempVS, { stream: false });
  const resp = await oaJson("/responses", "POST", payload);
  const text = extractTextFromResponse(resp);
  const usage = resp?.usage || null;
  return { ok: true, text, usage };
}

async function handleStreaming(req, res, userMessage, history, uploadFileId) {
  setCors(res, req.headers.origin || "");

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(req.headers.origin || "") ? (req.headers.origin || "") : "",
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

  let tempVS = null;
  if (uploadFileId) {
    try {
      tempVS = await createTempVectorStoreWithFile(uploadFileId);
      send("info", { note: "temp_vector_store_ready", id: tempVS });
    } catch (e) {
      send("info", { note: "temp_vector_store_failed", error: String(e?.message || e) });
    }
  }

  const payload = buildResponsesRequest(history, userMessage, sys, tempVS, { stream: true });

  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok || !upstream.body) {
    let errTxt = "";
    try { errTxt = await upstream.text(); } catch {}
    send("error", { ok:false, step:"responses_stream", status: upstream.status, error: errTxt || "no-body", payload });
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
    // client aborted
  } finally {
    try { send("done", "[DONE]"); } catch {}
    try { res.end(); } catch {}
  }
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin || "");
  if (req.method === "OPTIONS") return endPreflight(res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok:false, error: "Method Not Allowed" });
  }

  try {
    const body = await readBody(req);
    const userMessage   = (body.userMessage || "").toString().trim();
    const clientHistory = normalizeHistory(body.history || []);
    const trimmedHistory= trimHistoryByChars(clientHistory, 8000);
    const uploadFileId  = (body.upload_file_id || "").toString().trim() || null;
    const mode          = (req.query.stream || "off").toString();

    if (!userMessage) {
      return res.status(400).json({ ok:false, error: "Missing userMessage" });
    }
    if (!OPENAI_VECTOR_STORE_ID) {
      return res.status(500).json({ ok:false, error: "Server misconfig: OPENAI_VECTOR_STORE_ID not set" });
    }

    if (mode === "on") {
      return await handleStreaming(req, res, userMessage, trimmedHistory, uploadFileId);
    } else {
      const out = await handleNonStreaming(userMessage, trimmedHistory, uploadFileId);
      return res.status(200).json(out);
    }
  } catch (err) {
    console.error("assistant handler error:", err);
    try {
      return res.status(500).json({ ok:false, error: "Internal Server Error", detail: String(err?.message || err) });
    } catch {}
  }
}
