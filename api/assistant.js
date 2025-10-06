// /api/assistant.js — Vercel serverless (CommonJS)
//
// Intent gate + tool gating + streaming sanitizer + tool usage telemetry
// Privacy-safe uploads: per-turn temp vector store + cleanup (and belt-and-braces removal from library if needed)
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
function sseDone(res) { sseEvent(res, "done", "[DONE]"); try { res.end(); } catch {} }

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
async function createTempVS(name = "TCN temp (this turn)") {
  const r = await oi("/v1/vector_stores", { method: "POST", body: { name } });
  if (!r.ok) throw new Error(`create vector store failed: ${r.status} ${await r.text()}`);
  const d = await r.json(); return d.id;
}
async function addFileToVS(vsId, fileId) {
  const r = await oi(`/v1/vector_stores/${vsId}/files`, { method: "POST", body: { file_id: fileId } });
  if (!r.ok) throw new Error(`add file failed: ${r.status} ${await r.text()}`);
  const d = await r.json(); return d.id; // vector_store_file.id
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

// Best-effort: if upload leaked into library store, detach it.
async function detachFromLibraryIfPresent(fileId) {
  if (!LIBRARY_VS_ID || !fileId) return;
  try {
    // page through library VS files to find the VS-file id that references this file
    let after = null;
    while (true) {
      const path = `/v1/vector_stores/${LIBRARY_VS_ID}/files` + (after ? `?after=${encodeURIComponent(after)}` : "");
      const r = await oi(path, { method: "GET" });
      if (!r.ok) break;
      const d = await r.json();
      const items = Array.isArray(d?.data) ? d.data : [];
      const hit = items.find(x => (x && (x.file_id === fileId || x.id === fileId)));
      if (hit && hit.id) {
        await oi(`/v1/vector_stores/${LIBRARY_VS_ID}/files/${hit.id}`, { method: "DELETE" });
        break;
      }
      if (!d?.has_more || !items.length) break;
      after = items[items.length - 1].id;
    }
  } catch {}
}

// Cleanup helpers
async function deleteVS(vsId) {
  if (!vsId) return;
  try { await oi(`/v1/vector_stores/${vsId}`, { method: "DELETE" }); } catch {}
}
async function deleteFile(fileId) {
  if (!fileId) return;
  try { await oi(`/v1/files/${fileId}`, { method: "DELETE" }); } catch {}
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

// ---- Low-signal / nonsense detector
function isLowSignal(message) {
  const t = (message || "").trim();
  if (!t) return true;
  if (/^[\s\/\?\.\!\,\-\_\|\*\+\=\(\)\[\]\{\}:;~`'"]+$/.test(t)) return true;
  const letters = (t.replace(/[^a-zA-Z]/g, "") || "");
  if (letters.length <= 2) return true;
  if (/(.)\1{3,}/.test(t)) return true; // waaa, ppppp...
  return false;
}

// ---- Intent gate (server-side)
function classifyIntent(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return "greeting";
  if (isLowSignal(t)) return "greeting";

  // greetings / small talk
  if (/^(hi|hello|hey|hiya|howdy|yo|yoyo|oi(?:\s+oi)?|sup|wass?up|wazz+up|whazz+up|what(?:'|’)?s up|whatsup)\b/.test(t)) return "greeting";
  if (/^good (morning|afternoon|evening)\b/.test(t)) return "greeting";
  if (/(are|r)\s*(you|u)\s*ok(ay)?\??$/.test(t)) return "greeting";
  if (/\bhow('?|’)?s it going\b|\bhow are (you|u)\b/.test(t)) return "greeting";

  // identity / creator / purpose / capability
  if (/\bwho (are|r) (you|u)\b/.test(t)) return "who";
  if (/\bwho (made|created|built) (you|u|this)\b|\bwho owns (you|this)\b|\bowner\b/.test(t)) return "creator";
  if (/\bwhat (is|’s|'s) your (purpose|goal|mission|objective|role)\b|\bwhy (were you created|do you exist)\b|\bprime directive\b/.test(t)) return "purpose";

  // privacy/data handling
  if (/\b(what happens to)\s+my\s+(data|information|info)\b/.test(t)) return "privacy";
  if (/\b(what|how)\s+(do|will)\s+(you|u)\s+(do|use|handle)\s+(with )?my\s+(data|information|info)\b|\bdata\s+(policy|privacy)\b|\bprivacy\b/.test(t)) return "privacy";

  // --- TECH / BUILD / ARCHITECTURE / WHITE-LABEL / INTEGRATIONS (broadened) ---
  if (
    // how it's built / underlying tech
    /\b(how (?:is|was) (?:this|it) (?:built|made)|how did (?:you|they) build (?:this|it)|what(?:'|’)?s (?:the )?tech(?:nology)? stack|what (?:tech|technology|stack) (?:do|does) (?:you|it) use|what model(?:s)? (?:do you|does it) use|which (?:gpt|model)|are you (?:chatgpt|gpt)|do you use (?:openai|gpt)|under the hood|architecture|how does the ai work|what powers (?:this|you))\b/i
      .test(t)
    ||
    // build/replicate one yourself
    /\bhow (?:do|can) i (?:make|build|create|set ?up|spin ?up|replicate|clone|copy)\b.*\b(this|one of these|something like this|a (?:tool|assistant|bot|chatbot|navigator))\b/i
      .test(t)
    ||
    // ask us to build one / bespoke versions
    /\b(?:can (?:you|u) (?:build|make|create|set ?up|develop)(?: me| us)? (?:one|this)|we (?:want|need) (?:a|our own) (?:version|one) (?:of )?(?:this|like this)|bespoke|custom|white[- ]?label(?:ling)?)\b/i
      .test(t)
    ||
    // integrations & implementation-y signals
    /\b(integrations?|integrate|api|webhooks?|embed|squarespace|sharepoint|microsoft teams|teams|slack)\b/i
      .test(t)
  ) return "tech_sales";

  // capability
  if (/\bwhat do (you|u) do\b|\bwhat('?|’)?s your (role|job|function|capabilities?)\b/.test(t)) return "capability";
  if (/\bwhat can (you|u) do\b|\bhow can (you|u) help\b|\bexamples? of (how|what) (you|u) can do\b|\bwhat can u even do\b/.test(t)) return "capability";

  // process
  if (/\bhow (does|do) (this|it) work\b|\bhow (do|to) (i|we) (use|work with) (you|this)\b|\bcan i upload\b|\bhow to upload\b/.test(t)) return "process";

  // comparison
  if (/\bwhy (should|would) i use (this|you) (instead of|over) (chatgpt|chat gpt|gpt|openai)\b/.test(t)) return "comparison";
  if (/\bwhy (is|are) (this|you) (better|different) (than|to) (chatgpt|chat gpt|gpt|openai)\b/.test(t)) return "comparison";
  if (/\b(compare|difference|vs\.?|versus)\b.*\b(chatgpt|chat gpt|gpt|openai)\b/.test(t)) return "comparison";

  // inventory probes
  if (/\bwhat files\??$|\bi haven'?t uploaded any\b|\bno (files|documents) uploaded\b/.test(t)) return "no_files";
  if (/\b(document|doc) store\b|\bwhat (files|documents).* (do you have|are in (your|the) (library|store))\b/.test(t)) return "inventory";

  // appearance/meta & preferences
  if (/\bwhat do you look like\b|\bappearance\b/.test(t)) return "appearance";
  if (/\bdo (you|u) like\b|\bwhat('?|’)?s your favourite\b|\bfavorite\b/.test(t)) return "preference";

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
      return "For privacy information, see https://www.talkingcare.uk/privacy.";
    case "comparison":
      return "I’m focused on adult social care in England and prioritise practical, regulation-aligned guidance for providers and staff.";
    case "no_files":
      return "Understood — I’ll only refer to an attached document if you add one. How can I help today?";
    case "inventory":
      return "I don’t list or inventory documents. If you add an attached document for this turn, I can refer to it, and I can also use the Talking Care Navigator Library where appropriate. How can I help today?";
    case "appearance":
      return "I don’t have a physical appearance. How may I assist you today?";
    case "preference":
      return "I don’t have personal preferences. How may I assist you today?";
    // --- NEW ---
    case "tech_sales":
      return [
        "Here’s the short version: I use OpenAI’s models under the hood. Talking Care configures and safeguards the experience for adult social care in England.",
        "",
        "If you’re exploring a bespoke version — for example tailored content, your organisation’s policies or integrations — please get in touch and we’ll happily discuss options: https://www.talkingcare.uk/contact",
      ].join("\n");
    default:
      return null;
  }
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
    "Meta/greetings (hi/hello/how are you/who are you/who created you/what can you do):",
    "- Do NOT run search or cite sources.",
    "- Do NOT mention documents, files, uploads, a library, sources, or tooling.",
    "- Keep it brief and helpful. Preferred greeting: “Hello! How may I assist you today?”",
    "",
    `Upload for THIS user turn: ${uploadTurn ? "YES" : "NO"}.`,
    "- If NO: you must NOT refer to uploads, files or documents being uploaded.",
    "- If YES and you need to reference it: call it “the attached document” (never “your upload” / “file you uploaded”).",
    "",
    "When you use the Talking Care Navigator Library or an attached document to answer, add a final section titled “Sources:” and list the document titles you relied on. Once you start a “Sources:” section, do not remove it.",
    "Never list or enumerate filenames as an inventory. Provide only the minimal citations needed for the answer.",
  ].join("\n");
}

// ---- Streaming sanitizer with state (per request)
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
    if (/^\s*sources?\s*:\s*$/im.test(s) || /\bSources:\s*$/i.test(s)) {
      state.inSources = true; state.suppressList = false;
    }
    if (/^\s*sources?\s*:/im.test(s)) {
      state.inSources = true; state.suppressList = false;
    }
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
        lines[i] = "• [document omitted]"; continue;
      }
      if (/[.!?]\s*$/.test(L) || /^\s*$/.test(L)) { state.suppressList = false; }
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

module.exports = async (req, res) => {
  setCORS(res);

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") {
    res.statusCode = 405; res.setHeader("Allow", "POST, OPTIONS");
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }
  if (!OPENAI_API_KEY) { res.statusCode = 500; return res.end(JSON.stringify({ error: "Missing OPENAI_API_KEY" })); }

  // Book-keeping for cleanup even if something fails mid-flight
  let tempVS = null;
  let tempVSFileId = null; // vector_store_file.id in temp store
  let upload_file_id = null; // original file id from /api/upload
  let uploadTurn = false;
  let wantStream = false;

  try {
    // Parse query (?stream=on)
    try { const u = new URL(req.url, "http://localhost"); wantStream = u.searchParams.get("stream") === "on"; } catch {}

    // Parse body
    const bodyBuf = await new Promise((resolve, reject) => {
      const chunks = []; req.on("data", c => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
    const parsed = JSON.parse(bodyBuf.toString("utf8") || "{}");
    const { userMessage, history, upload_file_id: bodyUploadId } = parsed;
    if (!userMessage || typeof userMessage !== "string") {
      res.statusCode = 400; return res.end(JSON.stringify({ error: "Missing userMessage" }));
    }

    upload_file_id = bodyUploadId || null;
    uploadTurn = !!upload_file_id;

    // ---- INTENT GATE
    const intent = classifyIntent(userMessage);
    const canned = intent ? cannedReply(intent) : null;

    if (canned) {
      if (wantStream) {
        if (!res.headersSent) { sseHead(res); sseEvent(res, "start", { ok: true }); }
        sseEvent(res, "info", { note: "canned_reply", intent, used_assistant: false, used_tools: false });
        sseEvent(res, "response.output_text.delta", { delta: canned });
        sseEvent(res, "response.completed", { done: true });
        return sseDone(res);
      } else {
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({
          id: `resp_${Math.random().toString(36).slice(2)}`,
          object: "response",
          model: "canned",
          status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: canned }] }]
        }));
      }
    }

    // --- Content path: fetch Assistant + build prompt
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

    // Build system message
    const shim = buildPolicyShim(uploadTurn);
    const systemText = [shim, asstText].filter(Boolean).join("\n\n");

    // Build input
    const input = [];
    if (systemText) input.push({ role: "system", content: [{ type: "input_text", text: systemText }] });
    input.push(...mapHistory(history || []));
    input.push({ role: "user", content: [{ type: "input_text", text: userMessage }] });

    // Tool wiring:
    // - If upload this turn: create temp VS, attach upload to it, and ONLY use temp VS.
    // - Else: use library VS if configured.
    let tools = [];
    const libraryCandidate = !!LIBRARY_VS_ID;

    if (uploadTurn) {
      // Strict isolation: we will (a) attach to a brand-new VS, (b) ensure not present in library, (c) clean up later.
      tempVS = await createTempVS("TCN temp (this turn)");
      const vsFileId = await addFileToVS(tempVS, upload_file_id);
      tempVSFileId = vsFileId;
      if (wantStream) { if (!res.headersSent) sseHead(res); sseEvent(res, "start", { ok: true }); sseEvent(res, "info", { note: "temp_vector_store_created", id: tempVS }); }
      await waitVSFileReady(tempVS, vsFileId);
      if (wantStream) sseEvent(res, "info", { note: "temp_vector_store_ready", id: tempVS });

      // Proactively detach from library if some other path attached it there.
      await detachFromLibraryIfPresent(upload_file_id);

      tools = [{ type: "file_search", vector_store_ids: [tempVS] }];
      if (wantStream && !res.headersSent) { sseHead(res); sseEvent(res, "start", { ok: true }); }
    } else if (LIBRARY_VS_ID) {
      tools = [{ type: "file_search", vector_store_ids: [LIBRARY_VS_ID] }];
      if (wantStream && !res.headersSent) { sseHead(res); sseEvent(res, "start", { ok: true }); }
    } else {
      if (wantStream && !res.headersSent) { sseHead(res); sseEvent(res, "start", { ok: true }); }
    }

    const payload = {
      model: resolvedModel,
      input,
      tools,
      tool_choice: tools.length ? "auto" : "none",
      temperature: 0.5,
      text: { format: { type: "text" }, verbosity: "medium" },
      top_p: 1,
      truncation: "disabled",
      store: false // IMPORTANT: do not persist the response object
    };

    // Debug info
    sseEvent(res, "info", {
      note: "resolved_prompt",
      using_assistant: usingAssistant,
      assistant_id: usingAssistant ? ASSISTANT_ID : null,
      assistant_name: usingAssistant && assistant ? assistant.name || null : null,
      system_len: systemText.length || 0,
      model: resolvedModel,
      tools_enabled: tools.length > 0,
      upload_turn: uploadTurn,
      library_candidate: libraryCandidate,
      temp_vs: tempVS || null,
      sanitizer: true
    });

    // ---- Request to OpenAI + stream with sanitizer & telemetry
    const sanitizer = makeSanitizer({ uploadTurn });
    let usedFileSearch = false;

    let streamResp;
    try {
      streamResp = await oi("/v1/responses", { method: "POST", body: { ...payload, stream: true }, stream: true });
    } catch (e) {
      // Fallback to non-stream and emit via SSE
      const r2 = await oi("/v1/responses", { method: "POST", body: payload, stream: false });
      const txt2 = await r2.text();
      if (!r2.ok) {
        sseEvent(res, "error", { message: `OpenAI stream init failed: ${String(e?.message || e)}; fallback also failed: ${txt2}` });
        // Cleanup even on failure
        try {
          if (uploadTurn) {
            await detachFromLibraryIfPresent(upload_file_id);
            await deleteVS(tempVS);
            await deleteFile(upload_file_id);
            sseEvent(res, "info", { note: "cleanup_done_on_error", temp_vs_deleted: !!tempVS, file_deleted: !!upload_file_id });
          }
        } catch {}
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
      // Cleanup after non-stream path
      try {
        if (uploadTurn) {
          await detachFromLibraryIfPresent(upload_file_id);
          await deleteVS(tempVS);
          await deleteFile(upload_file_id);
          sseEvent(res, "info", { note: "cleanup_done_nonstream", temp_vs_deleted: !!tempVS, file_deleted: !!upload_file_id });
        }
      } catch {}
      sseEvent(res, "response.completed", { done: true });
      return sseDone(res);
    }

    if (!streamResp.ok || !streamResp.body) {
      const errTxt = await (streamResp && streamResp.text ? streamResp.text().catch(() => "") : "");
      sseEvent(res, "error", { message: `OpenAI stream failed: ${errTxt || `HTTP ${streamResp && streamResp.status}`}` });
      // Cleanup even on failure
      try {
        if (uploadTurn) {
          await detachFromLibraryIfPresent(upload_file_id);
          await deleteVS(tempVS);
          await deleteFile(upload_file_id);
          sseEvent(res, "info", { note: "cleanup_done_on_error", temp_vs_deleted: !!tempVS, file_deleted: !!upload_file_id });
        }
      } catch {}
      return sseDone(res);
    }

    // Proxy SSE with filtering of *text* deltas only; also detect tool use
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
        buffer = blocks.pop(); // keep last partial

        for (const block of blocks) {
          const lines = block.split("\n");
          let event = "message";
          const dataLines = [];
          for (const line of lines) {
            if (!line) continue;
            if (line.startsWith(":")) continue;
            if (line.startsWith("event:")) { event = line.slice(6).trim(); continue; }
            if (line.startsWith("data:"))  { dataLines.push(line.slice(5).trim()); continue; }
          }
          const raw = dataLines.join("\n");

          // crude detection of file_search tool usage for telemetry
          if (/tool/i.test(event) && /file_search/i.test(raw)) usedFileSearch = true;
          if (/file_search/i.test(raw) && /(tool_call|tool_result)/i.test(event)) usedFileSearch = true;

          if (event.endsWith(".delta")) {
            let obj;
            try { obj = JSON.parse(raw); } catch { obj = null; }
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
            forward(event, raw); // forward non-text events untouched
          }
        }
      }
    } catch (e) {
      sseEvent(res, "error", { message: `Stream error: ${String(e?.message || e)}` });
    } finally {
      // Emit telemetry + cleanup (always)
      try {
        sseEvent(res, "info", {
          note: "tools_summary",
          used_file_search: !!usedFileSearch,
          library_candidate: libraryCandidate,
          upload_turn: uploadTurn
        });

        // Strict cleanup for upload turns
        if (uploadTurn) {
          await detachFromLibraryIfPresent(upload_file_id); // if any stray attach happened
          await deleteVS(tempVS);
          await deleteFile(upload_file_id);
          sseEvent(res, "info", {
            note: "cleanup_done",
            temp_vs_deleted: !!tempVS,
            file_deleted: !!upload_file_id
          });
        }

        sseEvent(res, "response.completed", { done: true });
        sseDone(res);
      } catch {
        // even if cleanup throws, we still finish the SSE
        try { sseEvent(res, "response.completed", { done: true }); } catch {}
        sseDone(res);
      }
    }
  } catch (err) {
    console.error("assistant error:", err);
    if (!res.headersSent) {
      res.statusCode = 500; setCORS(res);
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: (err && err.message) || String(err) }));
    }
    try {
      sseEvent(res, "error", { message: (err && err.message) || String(err) });
    } catch {}
    try {
      // Cleanup even on outer catch
      if (uploadTurn) {
        await detachFromLibraryIfPresent(upload_file_id);
        await deleteVS(tempVS);
        await deleteFile(upload_file_id);
        sseEvent(res, "info", { note: "cleanup_done_on_outer_error", temp_vs_deleted: !!tempVS, file_deleted: !!upload_file_id });
      }
    } catch {}
    try { sseDone(res); } catch {}
  }
};
