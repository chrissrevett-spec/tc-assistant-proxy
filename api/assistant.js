// /api/assistant.js  — Vercel serverless (CommonJS)
//
// Goals
// - Strong CORS for your site
// - Small-talk handled locally (no model call, no tools)
// - Upload-turn: create temp vector store, attach file, wait ready, use ONLY that store
// - No-upload: use library store (TCN_LIBRARY_VECTOR_STORE_ID) when available
// - Stream OpenAI SSE to client; on any streaming error, fall back to non-stream and emit SSE-compatible events
//
// Env:
// - OPENAI_API_KEY                  (required)
// - TCN_LIBRARY_VECTOR_STORE_ID     (optional)
// - TCN_ALLOWED_ORIGIN              (optional; defaults to https://www.talkingcare.uk)
// - TCN_MODEL                       (optional; defaults to gpt-4o-mini-2024-07-18)

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LIBRARY_VS_ID = process.env.TCN_LIBRARY_VECTOR_STORE_ID || "";
const ALLOWED_ORIGIN = process.env.TCN_ALLOWED_ORIGIN || "https://www.talkingcare.uk";
const MODEL = process.env.TCN_MODEL || "gpt-4o-mini-2024-07-18";

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const GREET_RE = /^(hi|hello|hey|yo|hiya|sup|howdy|oi|morning|good\s*morning|afternoon|good\s*afternoon|evening|good\s*evening|what'?s up|whatsup|wassup|you ok\??|u ok\??|how are (you|u)\??|hello there|hiya there)[!.\s]*$/i;

function isGreeting(s) {
  if (!s) return false;
  const t = String(s).trim().toLowerCase();
  if (t.length <= 18 && GREET_RE.test(t)) return true;
  return false;
}

function systemPrompt(uploadTurn) {
  return [
    "You are Talking Care Navigator. Scope: adult social care in England only.",
    "No medical/clinical/legal advice; suggest qualified professionals instead.",
    "Evidence order: (1) attached document for THIS TURN (if present), (2) Talking Care Navigator Library, (3) external web only if still needed.",
    "Never mention implementation details (vector stores, IDs, tools).",
    "Strict phrasing:",
    "- Do NOT say 'file(s) you uploaded' or 'your upload(s)'.",
    "- If a file is attached THIS TURN, call it 'the attached document' and base the answer ONLY on it.",
    "- If no file is attached THIS TURN, you may use the 'Talking Care Navigator Library' if needed; do not mention documents for greetings/small talk.",
    uploadTurn
      ? "A file is attached for this turn. Answer ONLY from the attached document."
      : "No file is attached this turn. Do not mention documents unless answering a content question."
  ].join("\n");
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
  const resp = await fetch(url, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
    // IMPORTANT: do not pass "dispatcher" (breaks in some runtimes)
    // agent is not required; Node/undici handles keep-alive.
  });
  return resp;
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

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST, OPTIONS");
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  if (!OPENAI_API_KEY) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: "Missing OPENAI_API_KEY" }));
  }

  try {
    // Parse query (?stream=on)
    let wantStream = false;
    try {
      const u = new URL(req.url, "http://localhost");
      wantStream = u.searchParams.get("stream") === "on";
    } catch {}

    // Parse body ONCE
    const bodyBuf = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
    const { userMessage, history, upload_file_id } = JSON.parse(bodyBuf.toString("utf8") || "{}");

    if (!userMessage || typeof userMessage !== "string") {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Missing userMessage" }));
    }

    const greeting = isGreeting(userMessage);

    // Handle small-talk locally — reliable, zero tool use.
    if (greeting) {
      return emitSSEReply(res, "Hello! How may I assist you today?");
    }

    // Build input and tools
    const uploadTurn = !!upload_file_id;
    const input = [
      { role: "system", content: [{ type: "input_text", text: systemPrompt(uploadTurn) }] },
      ...mapHistory(history || []),
      { role: "user", content: [{ type: "input_text", text: userMessage }] }
    ];

    let tools = [];
    let tool_choice = "none";
    let vector_store_ids = [];
    let tempVS = null;

    if (uploadTurn) {
      // Create a temp store just for this turn
      tempVS = await createTempVS("TCN temp (this turn)");
      const vsFileId = await addFileToVS(tempVS, upload_file_id);
      if (wantStream) {
        sseHead(res);
        sseEvent(res, "start", { ok: true });
        sseEvent(res, "info", { note: "temp_vector_store_created", id: tempVS });
      }
      await waitVSFileReady(tempVS, vsFileId);
      if (wantStream) sseEvent(res, "info", { note: "temp_vector_store_ready", id: tempVS });

      vector_store_ids = [tempVS];
      tools = [{ type: "file_search", vector_store_ids }];
      tool_choice = "auto";
    } else if (LIBRARY_VS_ID) {
      vector_store_ids = [LIBRARY_VS_ID];
      tools = [{ type: "file_search", vector_store_ids }];
      tool_choice = "auto";
    }

    // Prepare Responses payload
    const payload = {
      model: MODEL,
      input,
      tools,
      tool_choice,
      temperature: 1,
      text: { format: { type: "text" }, verbosity: "medium" },
      top_p: 1,
      truncation: "disabled",
      store: true
    };

    if (!wantStream) {
      const r = await oi("/v1/responses", { method: "POST", body: payload, stream: false });
      const txt = await r.text();
      if (!r.ok) {
        res.statusCode = r.status;
        return res.end(JSON.stringify({ error: `OpenAI request failed: ${txt}` }));
      }
      res.setHeader("Content-Type", "application/json");
      return res.end(txt);
    }

    // Streaming preferred:
    // If we haven't sent SSE headers yet (no uploadTurn), send now.
    if (!res.headersSent) {
      sseHead(res);
      sseEvent(res, "start", { ok: true });
    }

    let streamResp;
    try {
      streamResp = await oi("/v1/responses", { method: "POST", body: { ...payload, stream: true }, stream: true });
    } catch (e) {
      // Network/init error -> fallback to non-stream
      const r2 = await oi("/v1/responses", { method: "POST", body: payload, stream: false });
      const txt2 = await r2.text();
      if (!r2.ok) {
        sseEvent(res, "error", { message: `OpenAI stream init failed: ${String(e?.message || e)}; fallback also failed: ${txt2}` });
        sseDone(res);
        return;
      }
      // Extract text and emit as SSE
      try {
        const obj = JSON.parse(txt2);
        const out = (obj?.output || []).find(o => o.type === "message");
        const text = (out?.content || []).map(c => c.type === "output_text" ? (c.text || "") : "").join("");
        emitSSEReply(res, text || ""); // ends the response
        return;
      } catch {
        emitSSEReply(res, ""); // ends
        return;
      }
    }

    if (!streamResp.ok || !streamResp.body) {
      const errTxt = await (streamResp && streamResp.text ? streamResp.text().catch(() => "") : "");
      sseEvent(res, "error", { message: `OpenAI stream failed: ${errTxt || `HTTP ${streamResp && streamResp.status}`}` });
      sseDone(res);
      return;
    }

    // Forward OpenAI SSE as-is
    const reader = streamResp.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) res.write(decoder.decode(value));
      }
    } catch (e) {
      // If streaming breaks mid-way, try a quick non-stream fallback to finish gracefully.
      try {
        const r3 = await oi("/v1/responses", { method: "POST", body: payload, stream: false });
        const txt3 = await r3.text();
        if (r3.ok) {
          const obj = JSON.parse(txt3);
          const out = (obj?.output || []).find(o => o.type === "message");
          const text = (out?.content || []).map(c => c.type === "output_text" ? (c.text || "") : "").join("");
          if (text) {
            sseEvent(res, "response.output_text.delta", { delta: text });
          }
        } else {
          sseEvent(res, "error", { message: `Stream error: ${String(e?.message || e)}; fallback failed: ${txt3}` });
        }
      } catch (e2) {
        sseEvent(res, "error", { message: `Stream error: ${String(e?.message || e)}; fallback error: ${String(e2?.message || e2)}` });
      } finally {
        sseEvent(res, "response.completed", { done: true });
        sseDone(res);
      }
      return;
    }

    sseEvent(res, "response.completed", { done: true });
    sseDone(res);
  } catch (err) {
    console.error("assistant error:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      setCORS(res);
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: (err && err.message) || String(err) }));
    }
    try {
      sseEvent(res, "error", { message: (err && err.message) || String(err) });
      sseDone(res);
    } catch {}
  }
};
