// /api/assistant.js
//
// Retrieval-first with file_search, rolling history, attachments prioritized.
// Uses tool_resources so BOTH the permanent vector store and per-turn attachments are searchable.

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
if (!OPENAI_VECTOR_STORE_ID) console.error("[assistant] Missing OPENAI_VECTOR_STORE_ID");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
  res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  res.setHeader("Access-Control-Max-Age", CORS_MAX_AGE);
}
function endPreflight(res) { res.statusCode = 204; res.end(); }

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const t = (data || "").trim();
      if (!t) return resolve({});
      try { resolve(JSON.parse(t)); } catch { resolve({}); }
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

function withGroundingPolicy(sys) {
  const policy = `
CRITICAL GROUNDING POLICY:
If the user attached files in this turn, SEARCH THE ATTACHED FILES FIRST using file_search and ground your answer in them. Cite them by filename.
Use the document library (vector store) to supplement only if the attachments are insufficient or off topic.
Only list sources once at the end under "Sources" (no inline links or [1] style refs).
Prefer short verbatim quotes with paragraph/section numbers when available.
If nothing relevant is found in the library or attachments, reply: "No matching sources found in the library."
Never answer purely from general knowledge without sources.
`.trim();
  return `${sys}\n\n${policy}`;
}

// Only declare the tool type; attach permanent store via tool_resources
function getTools() {
  const tools = [{ type: "file_search" }];
  if (ENABLE_WEB_SEARCH) tools.push({ type: "web_search" });
  return tools;
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

function buildResponsesRequest(historyArr, userMessage, sysInstructions, fileIds = [], attachmentsMeta = [], extra = {}) {
  const groundedSys = withGroundingPolicy(sysInstructions);
  const tools = getTools();

  const input = [{ role: "system", content: groundedSys }];

  // If attachments present, add a tiny system preface to bias retrieval
  if (Array.isArray(attachmentsMeta) && attachmentsMeta.length) {
    const names = attachmentsMeta.map(a => a?.name).filter(Boolean).join(", ");
    input.push({
      role: "system",
      content: `User attached files for this turn: ${names}. Search these attachments first; supplement with the library only if needed, and cite them by filename.`
    });
  }

  for (const m of historyArr) input.push(m);

  if (userMessage) {
    const hasAttachments = Array.isArray(fileIds) && fileIds.length > 0;
    const attachments = (fileIds || []).map(id => ({
      file_id: id,
      tools: [{ type: "file_search" }]
    }));

    if (hasAttachments) {
      input.push({
        role: "user",
        content: [{ type: "input_text", text: userMessage }],
        attachments
      });
    } else {
      input.push({ role: "user", content: userMessage });
    }
  }

  return {
    model: OPENAI_MODEL,
    input,
    tools,
    // Give the file_search tool access to your permanent vector store as well
    tool_resources: { file_search: { vector_store_ids: [OPENAI_VECTOR_STORE_ID] } },
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

async function handleNonStreaming(userMessage, history, fileIds, attachmentsMeta) {
  const sys = await fetchAssistantInstructions();
  const payload = buildResponsesRequest(history, userMessage, sys, fileIds, attachmentsMeta, { stream: false });
  const resp = await oaJson("/responses", "POST", payload);
  const text = extractTextFromResponse(resp);
  const usage = resp?.usage || null;
  return { ok: true, text, usage };
}

async function handleStreaming(res, userMessage, history, fileIds, attachmentsMeta) {
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
    body: JSON.stringify(buildResponsesRequest(history, userMessage, sys, fileIds, attachmentsMeta, { stream: true })),
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
        console.log("[assistant][SSE][tool_call]", event);
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
  } finally {
    send("done", "[DONE]");
    try { res.end(); } catch {}
  }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return endPreflight(res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok:false, error: "Method Not Allowed" });
  }

  try {
    const body = await readBody(req);
    const userMessage    = (body.userMessage || "").toString().trim();
    const clientHistory  = normalizeHistory(body.history || []);
    const trimmedHistory = trimHistoryByChars(clientHistory, 8000);
    const fileIds        = Array.isArray(body.fileIds) ? body.fileIds.filter(id => typeof id === "string" && id) : [];
    const attachmentsMeta= Array.isArray(body.attachments) ? body.attachments.filter(a => a && a.id && a.name) : [];
    const mode           = (req.query.stream || "off").toString();

    if (!userMessage) return res.status(400).json({ ok:false, error: "Missing userMessage" });
    if (!OPENAI_VECTOR_STORE_ID) return res.status(500).json({ ok:false, error: "Server misconfig: OPENAI_VECTOR_STORE_ID not set" });

    if (mode === "on") {
      return await handleStreaming(res, userMessage, trimmedHistory, fileIds, attachmentsMeta);
    } else {
      const out = await handleNonStreaming(userMessage, trimmedHistory, fileIds, attachmentsMeta);
      return res.status(200).json(out);
    }
  } catch (err) {
    console.error("assistant handler error:", err);
    try { return res.status(500).json({ ok:false, error: "Internal Server Error" }); } catch {}
  }
}
