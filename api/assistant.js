// /api/assistant.js — Vercel serverless (CommonJS)
//
// Uses your OpenAI Assistant as the source of truth for model + instructions.
// - If TCN_ASSISTANT_ID is set, we GET /v1/assistants/:id, pull .model and .instructions
// - Always send a model in /v1/responses (assistant.model or fallback TCN_MODEL)
// - If assistant.instructions exist, send them as the System message (single)
// - Upload turn -> temp vector store (wait until indexed) -> file_search tool with that store
// - No upload -> use library store if TCN_LIBRARY_VECTOR_STORE_ID is set
// - Streams SSE through; on failure, falls back to non-stream and emits SSE-compatible events
//
// Env:
// - OPENAI_API_KEY                  (required)
// - TCN_ASSISTANT_ID               (recommended; enables dynamic model/instructions)
// - TCN_LIBRARY_VECTOR_STORE_ID    (optional)
// - TCN_ALLOWED_ORIGIN             (optional; default https://www.talkingcare.uk)
// - TCN_MODEL                      (optional fallback; default gpt-4o-mini-2024-07-18)
// - TCN_SYSTEM_INSTRUCTIONS        (optional fallback if assistant has no instructions)

const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
const ASSISTANT_ID     = process.env.TCN_ASSISTANT_ID || "";
const LIBRARY_VS_ID    = process.env.TCN_LIBRARY_VECTOR_STORE_ID || "";
const ALLOWED_ORIGIN   = process.env.TCN_ALLOWED_ORIGIN || "https://www.talkingcare.uk";
const FALLBACK_MODEL   = process.env.TCN_MODEL || "gpt-4o-mini-2024-07-18";
const FALLBACK_SYS     = process.env.TCN_SYSTEM_INSTRUCTIONS || "";

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
function sseDone(res) {
  sseEvent(res, "done", "[DONE]");
  res.end();
}

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

async function getAssistant(id) {
  const r = await oi(`/v1/assistants/${id}`, { method: "GET" });
  if (!r.ok) throw new Error(`assistant GET failed: ${r.status} ${await r.text()}`);
  return await r.json(); // { id, model, instructions, tools, ... }
}

async function createTempVS(name = "TCN temp store") {
  const r = await oi("/v1/vector_stores", { method: "POST", body: { name } });
  if (!r.ok) throw new Error(`create vector store failed: ${r.status} ${await r.text()}`);
  const d = await r.json();
  return d.id;
}
async function addFileToVS(vsId, fileId) {
  const r = await oi(`/v1/vector_stores/${vsId}/files`, { method: "POST", body: { file_id: fileId } });
  if (!r.ok) throw new Error(`add file failed: ${r.status} ${await r.text()}`);
  const d = await r.json();
  return d.id; // vs_file_id
}
async function waitVSFileReady(vsId, vsFileId, { timeoutMs = 30000, pollMs = 900 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const r = await oi(`/v1/vector_stores/${vsId}/files/${vsFileId}`, { method: "GET" });
    if (!r.ok) throw new Error(`poll vs file failed: ${r.status} ${await r.text()}`);
    const d = await r.json();
    last = d.status;
    if (last === "completed") return;
    if (last === "failed") throw new Error("vector store indexing failed");
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error(`vector store file not ready (last: ${last || "unknown"})`);
}

function mapHistory(history = []) {
  const arr = [];
  for (const t of history) {
    if (!t || !t.role || !t.content) continue;
    const text = String(t.content);
    if (!text) continue;
    if (t.role === "user") arr.push({ role: "user", content: [{ type: "input_text", text }] });
    else if (t.role === "assistant") arr.push({ role: "assistant", content: [{ type: "output_text", text }] });
  }
  return arr;
}

// Fallback: emit a whole reply via SSE without streaming from OpenAI
function emitSSEReply(res, text) {
  sseHead(res);
  sseEvent(res, "start", { ok: true });
  sseEvent(res, "response.output_text.delta", { delta: text });
  sseEvent(res, "response.completed", { done: true });
  sseDone(res);
}

module.exports = async (req, res) => {
  setCORS(res);

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") { res.statusCode = 405; res.setHeader("Allow", "POST, OPTIONS"); return res.end(JSON.stringify({ error: "Method not allowed" })); }
  if (!OPENAI_API_KEY) { res.statusCode = 500; return res.end(JSON.stringify({ error: "Missing OPENAI_API_KEY" })); }

  try {
    // Parse query (?stream=on)
    let wantStream = false;
    try { const u = new URL(req.url, "http://localhost"); wantStream = u.searchParams.get("stream") === "on"; } catch {}

    // Parse body
    const bodyBuf = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
    const { userMessage, history, upload_file_id } = JSON.parse(bodyBuf.toString("utf8") || "{}");
    if (!userMessage || typeof userMessage !== "string") { res.statusCode = 400; return res.end(JSON.stringify({ error: "Missing userMessage" })); }

    // Resolve model + system instructions from Assistant (with robust fallbacks)
    let resolvedModel = FALLBACK_MODEL;
    let resolvedSystem = null;
    let assistantMeta = null;

    if (ASSISTANT_ID) {
      try {
        assistantMeta = await getAssistant(ASSISTANT_ID);
        if (assistantMeta?.model && typeof assistantMeta.model === "string") resolvedModel = assistantMeta.model;
        if (assistantMeta?.instructions && typeof assistantMeta.instructions === "string" && assistantMeta.instructions.trim().length) {
          resolvedSystem = assistantMeta.instructions;
        }
      } catch (e) {
        // Fall back silently; also surface a small hint over SSE for debugging
        if (wantStream) {
          sseHead(res);
          sseEvent(res, "start", { ok: true });
          sseEvent(res, "info", { note: "assistant_fetch_failed", message: String(e?.message || e) });
        }
      }
    }
    if (!resolvedSystem && FALLBACK_SYS && FALLBACK_SYS.trim().length) {
      resolvedSystem = FALLBACK_SYS;
    }

    // Build input
    const input = [];
    if (resolvedSystem) input.push({ role: "system", content: [{ type: "input_text", text: resolvedSystem }] });
    input.push(...mapHistory(history || []));
    input.push({ role: "user", content: [{ type: "input_text", text: userMessage }] });

    // Tools (vector stores)
    const uploadTurn = !!upload_file_id;
    let tools = [];
    let tool_choice = "auto";
    let tempVS = null;

    if (uploadTurn) {
      tempVS = await createTempVS("TCN temp (this turn)");
      const vsFileId = await addFileToVS(tempVS, upload_file_id);
      if (wantStream) {
        if (!res.headersSent) { sseHead(res); sseEvent(res, "start", { ok: true }); }
        sseEvent(res, "info", { note: "temp_vector_store_created", id: tempVS });
      }
      await waitVSFileReady(tempVS, vsFileId);
      if (wantStream) sseEvent(res, "info", { note: "temp_vector_store_ready", id: tempVS });
      tools = [{ type: "file_search", vector_store_ids: [tempVS] }];
    } else if (LIBRARY_VS_ID) {
      tools = [{ type: "file_search", vector_store_ids: [LIBRARY_VS_ID] }];
    }

    // Payload for Responses — ALWAYS include model
    const payload = {
      model: resolvedModel,
      input,
      tools,
      tool_choice,
      temperature: 1,
      text: { format: { type: "text" }, verbosity: "medium" },
      top_p: 1,
      truncation: "disabled",
      store: true
    };

    // Non-stream
    if (!wantStream) {
      const r = await oi("/v1/responses", { method: "POST", body: payload, stream: false });
      const txt = await r.text();
      if (!r.ok) { res.statusCode = r.status; return res.end(JSON.stringify({ error: `OpenAI request failed: ${txt}` })); }
      res.setHeader("Content-Type", "application/json");
      return res.end(txt);
    }

    // Stream
    if (!res.headersSent) { sseHead(res); sseEvent(res, "start", { ok: true }); }
    // Emit a tiny debug crumb so you can see what was resolved
    sseEvent(res, "info", {
      note: "resolved_prompt",
      model: resolvedModel,
      system_len: resolvedSystem ? resolvedSystem.length : 0,
      used_assistant_id: ASSISTANT_ID ? true : false
    });

    let streamResp;
    try {
      streamResp = await oi("/v1/responses", { method: "POST", body: { ...payload, stream: true }, stream: true });
    } catch (e) {
      // Fallback to non-stream and emit once
      const r2 = await oi("/v1/responses", { method: "POST", body: payload, stream: false });
      const txt2 = await r2.text();
      if (!r2.ok) {
        sseEvent(res, "error", { message: `OpenAI stream init failed: ${String(e?.message || e)}; fallback also failed: ${txt2}` });
        sseDone(res);
        return;
      }
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
      res.statusCode = 500;
      setCORS(res);
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: (err && err.message) || String(err) }));
    }
    try { sseEvent(res, "error", { message: (err && err.message) || String(err) }); sseDone(res); } catch {}
  }
};
