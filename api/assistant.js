// /api/assistant.js — Vercel serverless (CommonJS)
//
// Adds a dynamic intent gate before calling OpenAI:
// - Catches greetings/identity/capability/process/privacy/comparison/"what files?" / "document store" probes
// - Returns UK-English canned replies with NO file/library/tool mentions
// - Skips OpenAI + vector store for those intents
//
// For content questions, falls through to your normal pipeline:
// - Optionally fetches Assistant (v2) and appends its instructions after a small UK-English shim
// - Upload turn -> create temp vector store and use file_search
// - Otherwise optionally include library vector store
// - Streams SSE to the client
//
// Env:
// - OPENAI_API_KEY               (required)
// - TCN_ASSISTANT_ID             (required) asst_... (used to fetch live instructions/model)
// - TCN_LIBRARY_VECTOR_STORE_ID  (optional; library store id)
// - TCN_ALLOWED_ORIGIN           (optional; default https://www.talkingcare.uk)
// - TCN_MODEL                    (optional fallback; default gpt-4o-mini-2024-07-18)

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID   = process.env.TCN_ASSISTANT_ID || "";
const LIBRARY_VS_ID  = process.env.TCN_LIBRARY_VECTOR_STORE_ID || "";
const ALLOWED_ORIGIN = process.env.TCN_ALLOWED_ORIGIN || "https://www.talkingcare.uk";
const FALLBACK_MODEL = process.env.TCN_MODEL || "gpt-4o-mini-2024-07-18";

// In-memory cache for assistant (10 min)
let ASSISTANT_CACHE = { at: 0, data: null };
const ASSISTANT_TTL_MS = 10 * 60 * 1000;

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ---- SSE helpers ----
function sseHead(res) {
  if (res.headersSent) return;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
}
function sseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}
function sseDone(res) { sseEvent(res, "done", "[DONE]"); res.end(); }

// ---- OpenAI REST (no SDK) ----
async function oi(path, { method = "GET", body, headers, stream = false } = {}) {
  const url = `https://api.openai.com${path}`;
  const h = {
    "Authorization": `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    ...(stream ? { "Accept": "text/event-stream" } : {}),
    ...(headers || {}),
  };
  const resp = await fetch(url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  return resp;
}

// ---- Assistant fetch (v2) ----
async function fetchAssistant() {
  if (!ASSISTANT_ID) return null;
  const now = Date.now();
  if (ASSISTANT_CACHE.data && (now - ASSISTANT_CACHE.at) < ASSISTANT_TTL_MS) return ASSISTANT_CACHE.data;
  const r = await oi(`/v1/assistants/${ASSISTANT_ID}`, {
    method: "GET",
    headers: { "OpenAI-Beta": "assistants=v2" }
  });
  if (!r.ok) throw new Error(`assistant fetch failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  ASSISTANT_CACHE = { at: now, data };
  return data;
}

// ---- Vector store helpers ----
async function createTempVS(name = "TCN temp store") {
  const r = await oi("/v1/vector_stores", { method: "POST", body: { name } });
  if (!r.ok) throw new Error(`create vector store failed: ${r.status} ${await r.text()}`);
  const d = await r.json(); return d.id;
}
async function addFileToVS(vsId, fileId) {
  const r = await oi(`/v1/vector_stores/${vsId}/files`, { method: "POST", body: { file_id: fileId } });
  if (!r.ok) throw new Error(`add file failed: ${r.status} ${await r.text()}`);
  const d = await r.json(); return d.id;
}
async function waitVSFileReady(vsId, vsFileId, { timeoutMs = 30000, pollMs = 900 } = {}) {
  const deadline = Date.now() + timeoutMs; let last = "";
  while (Date.now() < deadline) {
    const r = await oi(`/v1/vector_stores/${vsId}/files/${vsFileId}`, { method: "GET" });
    if (!r.ok) throw new Error(`poll vs file failed: ${r.status} ${await r.text()}`);
    const d = await r.json(); last = d.status;
    if (last === "completed") return;
    if (last === "failed") throw new Error("vector store indexing failed");
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error(`vector store file not ready (last: ${last || "unknown"})`);
}

// ---- map client history -> Responses input messages
function mapHistory(history = []) {
  const arr = [];
  for (const t of history) {
    if (!t || !t.role || !t.content) continue;
    const text = String(t.content); if (!text) continue;
    if (t.role === "user") arr.push({ role: "user", content: [{ type: "input_text", text }] });
    else if (t.role === "assistant") arr.push({ role: "assistant", content: [{ type: "output_text", text }] });
  }
  return arr;
}

// ---- Dynamic policy shim (overrides conflicts)
function buildPolicyShim(uploadTurn) {
  return [
    "PRIORITY SHIM — Apply these rules first. If any other instruction conflicts with this shim, this shim wins.",
    "",
    "Language & style:",
    "- Use UK English spelling, punctuation and grammar.",
    "",
    "Identity & attribution:",
    "- You are Talking Care Navigator (TCN), a support tool for adult social care in England.",
    "- If asked who created/built/owns you: reply exactly “I was created by Chris Revett at Talking Care.”",
    "- If asked who you are: start with “I am Talking Care Navigator…”",
    "- Only if specifically asked about technology: you may add “I use OpenAI’s models under the hood.”",
    "",
    "Meta/greetings (e.g., hi/hello/how are you?/who are you?/who created you?/what can you do?):",
    "- Do NOT run search or cite sources.",
    "- Do NOT mention documents, files, uploads, a library, sources, or tooling.",
    "- Keep it brief and helpful. Preferred greeting: “Hello! How may I assist you today?”",
    "",
    `Upload for THIS user turn: ${uploadTurn ? "YES" : "NO"}.`,
    "- If NO: you must NOT refer to any uploads, files or documents being uploaded.",
    "- If YES: if you need to reference it, call it “the attached document” (never “your upload” / “file you uploaded”).",
  ].join("\n");
}

// ---- Intent gate (server-side)
function classifyIntent(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return null;

  // greetings / small talk
  if (/^(hi|hello|hey|hiya|howdy|yo|good (morning|afternoon|evening))\b/.test(t)) return "greeting";
  if (/(are|r)\s*(you|u)\s*ok(ay)?\??$/.test(t)) return "greeting";
  if (/\b(you|u)\s*ok(ay)?\??$/.test(t)) return "greeting";
  if (/\bhow('?|’)?s it going\b|\bhow are (you|u)\b/.test(t)) return "greeting";

  // identity / creator / purpose / capability
  if (/\bwho (are|r) (you|u)\b/.test(t)) return "who";
  if (/\bwho (made|created|built) (you|u)\b|\bwho owns you\b|\bowner\b/.test(t)) return "creator";
  if (/\bwhat (is|’s|'s) your (purpose|goal|mission|objective|role)\b|\bwhy (were you created|do you exist)\b|\bprime directive\b/.test(t)) return "purpose";

  // NEW: capability expressions
  if (/\bwhat do (you|u) do\b|\bwhat('?|’)?s your (role|job|function|capabilities?)\b/.test(t)) return "capability";
  if (/\bwhat can (you|u) do\b|\bhow can (you|u) help\b|\bexamples? of (how|what) (you|u) can do\b|\bwhat can u even do\b/.test(t)) return "capability";

  // process / “how does this work”
  if (/\bhow (does|do) (this|it) work\b|\bhow (do|to) (i|we) (use|work with) (you|this)\b|\bcan i upload\b|\bhow to upload\b/.test(t)) return "process";

  // privacy / data handling
  if (/\b(what|how) (do|will) (you|u) (do|use|handle) (with )?my data\b|\bdata (policy|privacy)\b|\bprivacy\b/.test(t)) return "privacy";

  // comparison to ChatGPT / others
  if (/\bwhy (should|would) i use (this|you) (instead of|over) (chatgpt|chat gpt|gpt|openai)\b/.test(t)) return "comparison";
  if (/\bwhy (is|are) (this|you) (better|different) (than|to) (chatgpt|chat gpt|gpt|openai)\b/.test(t)) return "comparison";
  if (/\b(compare|difference|vs\.?|versus)\b.*\b(chatgpt|chat gpt|gpt|openai)\b/.test(t)) return "comparison";

  // “what files?” / inventory probes
  if (/\bwhat files\??$|\bi haven'?t uploaded any\b|\bno (files|documents) uploaded\b/.test(t)) return "no_files";

  // explicit “document store / library contents” inventory questions
  if (/\b(document|doc) store\b|\bwhat (files|documents).*\b(do you have|are in (your|the) (library|store))\b/.test(t)) return "inventory";

  return null;
}

function cannedReply(kind) {
  switch (kind) {
    case "greeting":
      return "Hello! How may I assist you today?";
    case "who":
      return "I am Talking Care Navigator, here to help with adult social care in England. How may I assist you today?";
    case "creator":
      return "I was created by Chris Revett at Talking Care. How may I assist you today?";
    case "purpose":
      return "My purpose is to provide practical, regulation-aligned guidance for adult social care in England. How may I assist you today?";
    case "capability":
      return [
        "I can help with:",
        "• Clear explanations of regulations and guidance (England).",
        "• Practical checklists and step-by-step actions.",
        "• Summaries and plain-English clarifications.",
        "• Drafting notes for audits, supervision and everyday good practice.",
        "• Signposting when specialist or legal advice is needed.",
      ].join("\n");
    case "process":
      return "Ask questions in plain English. If needed, attach a document for that turn and I’ll base my answer on the attached document.";
    case "privacy":
      return "I don’t need personal data to help. Please avoid sharing names or sensitive details. For privacy information, see https://www.talkingcare.uk/privacy.";
    case "comparison":
      return "I’m focused on adult social care in England and prioritise practical, regulation-aligned guidance for providers and staff.";
    case "no_files":
      return "Understood — I’ll only refer to an attached document if you add one. How can I help today?";
    case "inventory":
      return "I don’t maintain a personal document store for you. I only use (a) the attached document for this turn, if you add one, and (b) the Talking Care Navigator Library. I don’t list or inventory documents. How can I help today?";
    default:
      return null;
  }
}

module.exports = async (req, res) => {
  setCORS(res);

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") {
    res.statusCode = 405; res.setHeader("Allow", "POST, OPTIONS");
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }
  if (!OPENAI_API_KEY) { res.statusCode = 500; return res.end(JSON.stringify({ error: "Missing OPENAI_API_KEY" })); }

  try {
    // Parse query (?stream=on)
    let wantStream = false;
    try { const u = new URL(req.url, "http://localhost"); wantStream = u.searchParams.get("stream") === "on"; } catch {}

    // Parse body
    const bodyBuf = await new Promise((resolve, reject) => {
      const chunks = []; req.on("data", c => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
    const { userMessage, history, upload_file_id } = JSON.parse(bodyBuf.toString("utf8") || "{}");
    if (!userMessage || typeof userMessage !== "string") {
      res.statusCode = 400; return res.end(JSON.stringify({ error: "Missing userMessage" }));
    }

    const uploadTurn = !!upload_file_id;

    // ---- INTENT GATE: return canned replies for meta/process etc., ignore uploads
    const intent = classifyIntent(userMessage);
    const canned = intent ? cannedReply(intent) : null;
    if (canned) {
      if (wantStream) {
        if (!res.headersSent) { sseHead(res); sseEvent(res, "start", { ok: true }); }
        sseEvent(res, "info", {
          note: "canned_reply",
          intent,
          used_assistant: false,
          used_tools: false
        });
        sseEvent(res, "response.output_text.delta", { delta: canned });
        sseEvent(res, "response.completed", { done: true });
        return sseDone(res);
      } else {
        // Minimal shape similar to Responses API (enough for debugging)
        return res.end(JSON.stringify({
          id: `resp_${Math.random().toString(36).slice(2)}`,
          object: "response",
          model: "canned",
          status: "completed",
          output: [{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: canned }]
          }]
        }));
      }
    }

    // --- Fetch Assistant + resolve model/instructions (content questions only)
    let assistant = null, asstText = "", resolvedModel = FALLBACK_MODEL;
    let usingAssistant = false;

    try {
      assistant = await fetchAssistant();
      if (assistant && typeof assistant.instructions === "string" && assistant.instructions.trim().length) {
        asstText = assistant.instructions.trim();
        usingAssistant = true;
      }
      if (assistant && typeof assistant.model === "string" && assistant.model.trim()) {
        resolvedModel = assistant.model.trim();
      }
    } catch {
      usingAssistant = false; asstText = "";
    }

    // Build system message: shim + assistant instructions
    const shim = buildPolicyShim(uploadTurn);
    const systemText = [shim, asstText].filter(Boolean).join("\n\n");

    // Build input
    const input = [];
    if (systemText) input.push({ role: "system", content: [{ type: "input_text", text: systemText }] });
    input.push(...mapHistory(history || []));
    input.push({ role: "user", content: [{ type: "input_text", text: userMessage }] });

    // Tools (vector stores)
    let tools = [];
    let tempVS = null;

    if (uploadTurn) {
      tempVS = await createTempVS("TCN temp (this turn)");
      const vsFileId = await addFileToVS(tempVS, upload_file_id);
      if (wantStream) { sseHead(res); sseEvent(res, "start", { ok: true }); sseEvent(res, "info", { note: "temp_vector_store_created", id: tempVS }); }
      await waitVSFileReady(tempVS, vsFileId);
      if (wantStream) sseEvent(res, "info", { note: "temp_vector_store_ready", id: tempVS });
      tools = [{ type: "file_search", vector_store_ids: [tempVS] }];
    } else if (LIBRARY_VS_ID) {
      tools = [{ type: "file_search", vector_store_ids: [LIBRARY_VS_ID] }];
      if (wantStream && !res.headersSent) { sseHead(res); sseEvent(res, "start", { ok: true }); }
    } else {
      if (wantStream && !res.headersSent) { sseHead(res); sseEvent(res, "start", { ok: true }); }
    }

    // Payload (slightly lower temp for tighter compliance)
    const payload = {
      model: resolvedModel,
      input,
      tools,
      tool_choice: "auto",
      temperature: 0.6,     // was 1.0
      text: { format: { type: "text" }, verbosity: "medium" },
      top_p: 1,
      truncation: "disabled",
      store: true
    };

    // Debug info
    sseEvent(res, "info", {
      note: "resolved_prompt",
      using_assistant: usingAssistant,
      assistant_id: usingAssistant ? ASSISTANT_ID : null,
      assistant_name: usingAssistant && assistant ? assistant.name || null : null,
      system_len: systemText.length || 0,
      model: resolvedModel
    });

    // Non-stream
    if (!wantStream) {
      const r = await oi("/v1/responses", { method: "POST", body: payload, stream: false });
      const txt = await r.text();
      if (!r.ok) { res.statusCode = r.status; return res.end(JSON.stringify({ error: `OpenAI request failed: ${txt}` })); }
      res.setHeader("Content-Type", "application/json");
      return res.end(txt);
    }

    // Stream
    let streamResp;
    try {
      streamResp = await oi("/v1/responses", { method: "POST", body: { ...payload, stream: true }, stream: true });
    } catch (e) {
      // Fallback to non-stream and emit via SSE
      const r2 = await oi("/v1/responses", { method: "POST", body: payload, stream: false });
      const txt2 = await r2.text();
      if (!r2.ok) { sseEvent(res, "error", { message: `OpenAI stream init failed: ${String(e?.message || e)}; fallback also failed: ${txt2}` }); sseDone(res); return; }
      try {
        const obj = JSON.parse(txt2);
        const out = (obj?.output || []).find(o => o.type === "message");
        const text = (out?.content || []).map(c => c.type === "output_text" ? (c.text || "") : "").join("");
        sseEvent(res, "response.output_text.delta", { delta: text || "" });
      } catch {}
      sseEvent(res, "response.completed", { done: true });
      return sseDone(res);
    }

    if (!streamResp.ok || !streamResp.body) {
      const errTxt = await (streamResp && streamResp.text ? streamResp.text().catch(() => "") : "");
      sseEvent(res, "error", { message: `OpenAI stream failed: ${errTxt || `HTTP ${streamResp && streamResp.status}`}` });
      return sseDone(res);
    }

    const reader = streamResp.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) res.write(decoder.decode(value));
      }
    } catch (e) {
      sseEvent(res, "error", { message: `Stream error: ${String(e?.message || e)}` });
    } finally {
      sseEvent(res, "response.completed", { done: true });
      sseDone(res);
    }
  } catch (err) {
    console.error("assistant error:", err);
    if (!res.headersSent) {
      res.statusCode = 500; setCORS(res);
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: (err && err.message) || String(err) }));
    }
    try { sseEvent(res, "error", { message: (err && err.message) || String(err) }); sseDone(res); } catch {}
  }
};
