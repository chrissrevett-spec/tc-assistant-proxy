// /api/assistant.js
//
// Retrieval-first via file_search (vector store on tool), rolling history,
// and per-turn attachments on the user message. No tool_resources.

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
If the user attached files in this turn, SEARCH THE ATTACHED FILES FIRST using file_search and ground your answer in them (cite by filename).
Use the document library (vector store) to supplement only if attachments are insufficient or off-topic.
List sources once at the end under "Sources" (no inline links or [1] refs).
Prefer short verbatim quotes with paragraph/section numbers when available.
If nothing relevant is found in the library, reply: "No matching sources found in the library."
Never answer purely from general knowledge without sources.
`.trim();
  return `${sys}\n\n${policy}`;
}

// Tool declaration with vector_store_ids on the tool (works in your tenant)
function getTools() {
  const tools = [{
    type: "file_search",
    vector_store_ids: [OPENAI_VECTOR_STORE_ID],
  }];
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
    if (hasAttachments) {
      const attachments = fileIds.map(id => ({
        file_id: id,
        tools: [{ type: "file_search" }]
      }));
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
