// /api/assistant.js — Vercel serverless (CommonJS)
//
// Upload-turn is authoritative:
// - If an upload id is present in the POST body, we ALWAYS take the content path
//   (no canned reply), create a temp vector store, and instruct the model
//   to base the answer on the attached document (or say the exact "No matching..." line).
//
// Also:
// - Accepts upload_file_id OR uploadFileId OR file_id
// - Emits SSE info { upload_turn, tools_enabled } so you can verify
// - Preserves Sources: in the stream; blocks filename inventory chatter
//
// Env:
// - OPENAI_API_KEY               (required)
// - TCN_ASSISTANT_ID             (required) asst_...
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
  return fetch(url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
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
async function createTempVS(name = "TCN temp (this turn)") {
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
function buildPolicyShim({ uploadTurn }) {
  const lines = [
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
    "Meta/greetings (hi/hello/how are you/who are you/who created you/what can you do):",
    "- Do NOT run search or cite sources.",
    "- Do NOT mention documents, files, uploads, a library, sources, or tooling.",
    "- Keep it brief and helpful. Preferred greeting: “Hello! How may I assist you today?”",
    "",
    `Upload for THIS user turn: ${uploadTurn ? "YES" : "NO"}.`,
    "- If NO: do not refer to uploads, files or documents being uploaded.",
    "- If YES and you need to reference it: call it “the attached document” (never “your upload” / “file you uploaded”).",
    "",
    "When you use the Talking Care Navigator Library or an attached document to answer, add a final section titled “Sources:” and list only the document titles you relied on. Once you start a “Sources:” section, do not remove it.",
    "Never list or enumerate filenames as an inventory. Provide only the minimal citations needed."
  ];

  if (uploadTurn) {
    lines.push(
      "",
      "UPLOAD-TURN REQUIREMENT:",
      "- Treat the attached document as the primary source.",
      "- Base your answer solely on the attached document.",
      "- If the attached document has no relevant content, reply exactly: “No matching sources found in the attached document.”",
      "- Do not claim that no files are attached."
    );
  }
  return lines.join("\n");
}

// ---- Streaming sanitizer: keep Sources, block filename inventories
function makeSanitizer({ uploadTurn }) {
  const state = { suppressList: false, inSources: false };
  function neutraliseUploadPhrasing(txt) {
    let s = txt;
    const up = "(?:you(?:'|’)?ve|you have) uploaded";
    if (!uploadTurn) {
      s = s.replace(new RegExp(`\\b(files|documents)\\s+${up}\\b`, "gi"), "documents");
      s = s.replace(new RegExp(`\\b${up}\\b`, "gi"), "you add an attached document for this turn");
      s = s.replace(/\b(I|we)\s+(?:can\s+)?see\s+(?:that\s+)?(?:you(?:'|’)?ve|you have)\s+uploaded\b/gi,
                    "If you attach a document for this turn, I can refer to it");
      s = s.replace(/\b(here (are|is) (the )?(files|documents) (that )?you(?:'|’)?ve uploaded)\b/gi,
                    "I don’t list or inventory documents");
      s = s.replace(/\b(the|your)\s+uploaded\s+(files|documents)\b/gi, "documents");
      s = s.replace(/\bfiles\s+you\s+uploaded\b/gi, "documents");
    }
    if (/\b(here (are|is) (the )?(files|documents).*(uploaded|attached)|you (?:have|(?:'|’)??ve) uploaded)\b/i.test(s)) {
      state.suppressList = true;
    }
    if (/^\s*sources?\s*:/im.test(s)) { state.inSources = true; state.suppressList = false; }
    return s;
  }
  function scrubFilenameLines(s) {
    if (state.inSources) return s;
    if (!state.suppressList) return s;
    const lines = s.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (/^\s*sources?\s*:/i.test(L)) { state.inSources = true; state.suppressList = false; continue; }
      if (/^[\s\-\*\•\u2022]*.+\.(pdf|docx?|pptx?|xlsx?|xls|csv)\b/i.test(L)) {
        lines[i] = "• [document omitted]";
        continue;
      }
      if (/[.!?]\s*$/.test(L) || /^\s*$/.test(L)) state.suppressList = false;
    }
    return lines.join("\n");
  }
  return function sanitizeDeltaText(deltaText) {
    if (!deltaText) return deltaText;
    if (/^\s*sources?\s*:/im.test(deltaText)) { state.inSources = true; return deltaText; }
    let s = deltaText;
    s = neutraliseUploadPhrasing(s);
    s = scrubFilenameLines(s);
    return s;
  };
}

// ---- Simple intent gate (kept, but bypassed on upload-turn)
function isLowSignal(message) {
  const t = (message || "").trim();
  if (!t) return true;
  if (/^[\s\/\?\.\!\,\-\_\|\*\+\=\(\)\[\]\{\}:;~`'"]+$/.test(t)) return true;
  const letters = (t.replace(/[^a-zA-Z]/g, "") || "");
  if (letters.length <= 2) return true;
  if (/(.)\1{3,}/.test(t)) return true;
  return false;
}
function classifyIntent(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return "greeting";
  if (isLowSignal(t)) return "greeting";
  if (/^(hi|hello|hey|hiya|howdy|yo|good (morning|afternoon|evening))\b/.test(t)) return "greeting";
  if (/\bwho (are|r) (you|u)\b/.test(t)) return "who";
  if (/\bwho (made|created|built) (you|u)\b|\bwho owns you\b/.test(t)) return "creator";
  if (/\bwhat (is|’s|'s) your (purpose|goal|mission|objective|role)\b|\bprime directive\b/.test(t)) return "purpose";
  if (/\bwhat do (you|u) do\b|\bwhat can (you|u) do\b/.test(t)) return "capability";
  if (/\bhow (does|do) (this|it) work\b|\bcan i upload\b/.test(t)) return "process";
  if (/\bprivacy\b|\bwhat .* (do|will) you .* my data\b/.test(t)) return "privacy";
  if (/\bwhy (is|are) (this|you) (better|different) (than|to) (chatgpt|chat gpt|gpt|openai)\b/.test(t)) return "comparison";
  if (/\bwhat files\??$|\bi haven'?t uploaded any\b|\bno (files|documents) uploaded\b/.test(t)) return "no_files";
  if (/\b(document|doc) store\b|\bwhat (files|documents).* (do you have|are in (your|the) (library|store))\b/.test(t)) return "inventory";
  return null;
}
function cannedReply(kind) {
  switch (kind) {
    case "greeting":   return "Hello! How may I assist you today?";
    case "who":        return "I am Talking Care Navigator, here to help with adult social care in England. How may I assist you today?";
    case "creator":    return "I was created by Chris Revett at Talking Care. How may I assist you today?";
    case "purpose":    return "My purpose is to provide practical, regulation-aligned guidance for adult social care in England. How may I assist you today?";
    case "capability": return [
      "I can help with:",
      "• Clear explanations of regulations and guidance (England).",
      "• Practical checklists and step-by-step actions.",
      "• Summaries and plain-English clarifications.",
      "• Drafting notes for audits, supervision and everyday good practice.",
      "• Signposting when specialist or legal advice is needed.",
    ].join("\n");
    case "process":    return "Ask questions in plain English. If needed, attach a document for that turn and I’ll base my answer on the attached document.";
    case "privacy":    return "I don’t need personal data to help. Please avoid sharing names or sensitive details. For privacy information, see https://www.talkingcare.uk/privacy.";
    case "comparison": return "I’m focused on adult social care in England and prioritise practical, regulation-aligned guidance for providers and staff.";
    case "no_files":   return "Understood — I’ll only refer to an attached document if you add one. How can I help today?";
    case "inventory":  return "I don’t list or inventory documents. If you add an attached document for this turn, I can refer to it, and I can also use the Talking Care Navigator Library where appropriate. How can I help today?";
    default:           return null;
  }
}

module.exports = async (req, res) => {
  setCORS(res);

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") {
    res.statusCode = 405; res.setHeader("Allow", "POST, OPTIONS");
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }
  if (!OPENAI_API_KEY) {
    res.statusCode = 500; return res.end(JSON.stringify({ error: "Missing OPENAI_API_KEY" }));
  }

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
    const bodyJson = JSON.parse(bodyBuf.toString("utf8") || "{}");

    const userMessage = bodyJson.userMessage;
    const history = bodyJson.history || [];

    // Accept multiple field names for the upload id
    const upload_file_id =
      bodyJson.upload_file_id ||
      bodyJson.uploadFileId ||
      bodyJson.file_id ||
      null;

    if (!userMessage || typeof userMessage !== "string") {
      res.statusCode = 400; return res.end(JSON.stringify({ error: "Missing userMessage" }));
    }

    const uploadTurn = !!upload_file_id;

    // ---- INTENT GATE (BYPASS if upload present)
    let intent = null;
    let canned = null;
    if (!uploadTurn) { // only allow canned path when there's no upload for this turn
      intent = classifyIntent(userMessage);
      canned = intent ? cannedReply(intent) : null;
    }

    // ---- Start SSE for visibility
    if (wantStream && !res.headersSent) { sseHead(res); sseEvent(res, "start", { ok: true }); }

    // ---- CANNED PATH (no tools, no upload)
    if (canned) {
      sseEvent(res, "info", { note: "canned_reply", intent, used_assistant: false, used_tools: false, upload_turn: false });
      sseEvent(res, "response.output_text.delta", { delta: canned });
      sseEvent(res, "response.completed", { done: true });
      return sseDone(res);
    }

    // --- Content path: fetch Assistant + build prompt
    let assistant = null, asstText = "", resolvedModel = FALLBACK_MODEL;
    let usingAssistant = false;
    try {
      assistant = await fetchAssistant();
      if (assistant && typeof assistant.instructions === "string" && assistant.instructions.trim().length) {
        asstText = assistant.instructions.trim(); usingAssistant = true;
      }
      if (assistant && typeof assistant.model === "string" && assistant.model.trim()) {
        resolvedModel = assistant.model.trim();
      }
    } catch { usingAssistant = false; asstText = ""; }

    // Build system message
    const shim = buildPolicyShim({ uploadTurn });
    const systemText = [shim, asstText].filter(Boolean).join("\n\n");

    // Build input
    const input = [];
    if (systemText) input.push({ role: "system", content: [{ type: "input_text", text: systemText }] });
    input.push(...mapHistory(history));
    input.push({ role: "user", content: [{ type: "input_text", text: userMessage }] });

    // Tool wiring
    let tools = [];
    let tempVS = null;
    let libraryCandidate = !!LIBRARY_VS_ID;

    if (uploadTurn) {
      // Always use temp vector store on upload turns
      try {
        tempVS = await createTempVS("TCN temp (this turn)");
        const vsFileId = await addFileToVS(tempVS, upload_file_id);
        sseEvent(res, "info", { note: "temp_vector_store_created", id: tempVS });
        await waitVSFileReady(tempVS, vsFileId);
        sseEvent(res, "info", { note: "temp_vector_store_ready", id: tempVS });
        tools = [{ type: "file_search", vector_store_ids: [tempVS] }];
      } catch (e) {
        // If anything fails, still answer safely without claiming "no files"
        sseEvent(res, "error", { message: `Upload indexing failed: ${String(e?.message || e)}` });
        // fall back to library if available; otherwise no tools
        tools = LIBRARY_VS_ID ? [{ type: "file_search", vector_store_ids: [LIBRARY_VS_ID] }] : [];
        libraryCandidate = !!LIBRARY_VS_ID;
      }
    } else if (LIBRARY_VS_ID) {
      tools = [{ type: "file_search", vector_store_ids: [LIBRARY_VS_ID] }];
    }

    // Emit resolved prompt info
    sseEvent(res, "info", {
      note: "resolved_prompt",
      using_assistant: usingAssistant,
      assistant_id: usingAssistant ? ASSISTANT_ID : null,
      assistant_name: usingAssistant && assistant ? assistant.name || null : null,
      system_len: systemText.length || 0,
      model: resolvedModel,
      tools_enabled: tools.length > 0,
      upload_turn: uploadTurn,
      library_candidate: libraryCandidate
    });

    const payload = {
      model: resolvedModel,
      input,
      tools,
      tool_choice: tools.length ? "auto" : "none",
      temperature: 0.5,
      text: { format: { type: "text" }, verbosity: "medium" },
      top_p: 1,
      truncation: "disabled",
      store: true
    };

    // ---- Request + stream (with sanitizer)
    const sanitizer = makeSanitizer({ uploadTurn });
    let usedFileSearch = false;

    let streamResp;
    try {
      streamResp = await oi("/v1/responses", { method: "POST", body: { ...payload, stream: true }, stream: true });
    } catch (e) {
      // Non-stream fallback
      const r2 = await oi("/v1/responses", { method: "POST", body: payload });
      const txt2 = await r2.text();
      if (!r2.ok) {
        sseEvent(res, "error", { message: `OpenAI stream init failed: ${String(e?.message || e)}; fallback also failed: ${txt2}` });
        sseDone(res); return;
      }
      try {
        const obj = JSON.parse(txt2);
        const out = (obj?.output || []).find(o => o.type === "message");
        let text = (out?.content || []).map(c => c.type === "output_text" ? (c.text || "") : "").join("");
        text = sanitizer(text);
        sseEvent(res, "response.output_text.delta", { delta: text || "" });
      } catch {}
      sseEvent(res, "info", { note: "tools_summary", used_file_search: false, library_candidate: libraryCandidate, upload_turn: uploadTurn });
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
    let buffer = "";

    function forward(event, dataObjOrString) {
      const payload = typeof dataObjOrString === "string" ? dataObjOrString : JSON.stringify(dataObjOrString);
      res.write(`event: ${event}\n`);
      res.write(`data: ${payload}\n\n`);
    }

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\n\n/);
        buffer = blocks.pop();

        for (const block of blocks) {
          const lines = block.split(/\n/);
          let event = "message";
          const dataLines = [];
          for (const line of lines) {
            if (!line) continue;
            if (line.startsWith(":")) continue;
            if (line.startsWith("event:")) { event = line.slice(6).trim(); continue; }
            if (line.startsWith("data:"))  { dataLines.push(line.slice(5).trim()); continue; }
          }
          const raw = dataLines.join("\n");

          // crude detect file_search tool usage
          if (/tool/i.test(event) && /file_search/i.test(raw)) usedFileSearch = true;
          if (/file_search/i.test(raw) && /(tool_call|tool_result)/i.test(event)) usedFileSearch = true;

          if (event.endsWith(".delta")) {
            let obj; try { obj = JSON.parse(raw); } catch { obj = null; }
            if (obj) {
              if (typeof obj.delta === "string") {
                obj.delta = sanitizer(obj.delta);
                forward(event, obj);
              } else if (obj.delta && Array.isArray(obj.delta.content)) {
                obj.delta.content = obj.delta.content.map(c =>
                  (c && c.type && c.type.includes("output_text") && typeof c.text === "string")
                    ? { ...c, text: sanitizer(c.text) }
                    : c
                );
                forward(event, obj);
              } else if (typeof obj.text_delta === "string") {
                obj.text_delta = sanitizer(obj.text_delta);
                forward(event, obj);
              } else {
                forward(event, obj);
              }
            } else {
              forward(event, raw);
            }
          } else {
            forward(event, raw);
          }
        }
      }
    } catch (e) {
      sseEvent(res, "error", { message: `Stream error: ${String(e?.message || e)}` });
    } finally {
      sseEvent(res, "info", {
        note: "tools_summary",
        used_file_search: !!usedFileSearch,
        library_candidate: libraryCandidate,
        upload_turn: uploadTurn
      });
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
