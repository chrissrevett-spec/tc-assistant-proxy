// api/assistant.js
// Node (serverless) runtime on Vercel, CommonJS style.
// Requires: "openai" in dependencies and OPENAI_API_KEY set.
// Optional library store: TCN_LIBRARY_VECTOR_STORE_ID

const OpenAI = require("openai");

// ---------- CORS ----------
const ALLOWED_ORIGINS = new Set([
  "https://www.talkingcare.uk",
  "https://talkingcare.uk",
  "http://localhost:5173",
  "http://localhost:3000",
]);

function getOrigin(req) {
  const o = req.headers.origin || "";
  return ALLOWED_ORIGINS.has(o) ? o : undefined;
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "https://www.talkingcare.uk",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function sendJSON(res, origin, status, obj) {
  const h = {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(origin),
  };
  res.writeHead(status, h);
  res.end(JSON.stringify(obj));
}

function startSSE(res, origin) {
  const h = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    ...corsHeaders(origin),
  };
  res.writeHead(200, h);
  // Helpful initial ping
  res.write(`event: start\ndata: ${JSON.stringify({ ok: true })}\n\n`);
}

function sseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

// ---------- Helpers ----------
function isGreeting(txt = "") {
  const t = String(txt).trim().toLowerCase();
  return /^(hi|hello|hey|yo|morning|good morning|good afternoon|good evening)\b/.test(t);
}

function clampHistory(raw = [], maxTurns = 10) {
  // raw is [{role:'user'|'assistant', content:'...'}]
  // Keep last N turns
  if (!Array.isArray(raw)) return [];
  return raw.slice(Math.max(0, raw.length - maxTurns));
}

function toResponsesInput(systemText, hist, userText) {
  const input = [];

  if (systemText) {
    input.push({
      role: "system",
      content: [{ type: "input_text", text: systemText }],
    });
  }

  for (const m of hist) {
    if (!m || !m.role || !m.content) continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    input.push({
      role,
      content: [{ type: "input_text", text: String(m.content) }],
    });
  }

  input.push({
    role: "user",
    content: [{ type: "input_text", text: String(userText || "") }],
  });

  return input;
}

async function waitForIndexing(openai, vectorStoreId, fileId, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const f = await openai.vectorStores.files.retrieve(vectorStoreId, fileId);
    if (f.status === "completed" || f.status === "processed") return true;
    if (f.status === "failed") throw new Error("File indexing failed");
    await new Promise((r) => setTimeout(r, 800));
  }
  // Timed out – still allow, model might be able to reference partial index, but warn
  return false;
}

// ---------- System Prompt ----------
const BASE_SYSTEM_PROMPT = `
You are Talking Care Navigator, created by Chris Revett and Talking Care.
Tone: warm, concise, practical. Avoid hedging.

File etiquette:
- Do NOT mention documents, uploads, "files you've uploaded", vector stores, or "the library" unless the user explicitly asks about documents or attaches a file in THIS turn.
- If a user uploads a file in this turn, answer ONLY from that file; say if something isn't in it.
- For casual greetings ("hi", "hello"), respond briefly and do not bring up documents.

If asked "who created you?" or similar, answer: "I was created by Chris Revett and Talking Care."

Always keep answers UK adult social care–focused when relevant.
`.trim();

// ---------- Handler ----------
module.exports = async function handler(req, res) {
  const origin = getOrigin(req);

  // CORS preflight
  if (req.method === "OPTIONS") {
    const h = corsHeaders(origin);
    res.writeHead(204, h);
    return res.end();
  }

  if (req.method !== "POST") {
    return sendJSON(res, origin, 405, { error: "Method not allowed" });
  }

  // Parse body safely
  let body;
  try {
    body = typeof req.body === "object" && req.body
      ? req.body
      : JSON.parse(req.body || "{}");
  } catch {
    body = {};
  }

  const { userMessage, history: rawHistory, upload_file_id } = body || {};
  if (!userMessage || typeof userMessage !== "string") {
    return sendJSON(res, origin, 400, { error: "Missing userMessage (string)" });
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const libraryVS = (process.env.TCN_LIBRARY_VECTOR_STORE_ID || "").trim() || null;

  const greeting = isGreeting(userMessage);
  const history = clampHistory(rawHistory, 10);

  // Decide tools
  const tools = [];
  let tool_choice = "none";

  // If user uploaded a file this turn: build a temp store and ONLY use that
  let tempVS = null;
  if (upload_file_id) {
    try {
      tempVS = await openai.vectorStores.create({ name: "TCN temp upload" });
      await openai.vectorStores.files.create(tempVS.id, { file_id: upload_file_id });

      // **Block** until indexed (best effort)
      try {
        await waitForIndexing(openai, tempVS.id, upload_file_id, 35000);
      } catch (e) {
        // We'll still proceed; model might still search partial index
      }

      tools.push({ type: "file_search", vector_store_ids: [tempVS.id] });
      tool_choice = "auto";
    } catch (e) {
      // Let client know (SSE info); for JSON path we'll include info in error
      if (req.url.includes("stream=on")) {
        startSSE(res, origin);
        sseEvent(res, "info", { note: "temp_vector_store_failed", error: e?.message || String(e) });
        sseEvent(res, "done", "[DONE]");
        return res.end();
      }
      return sendJSON(res, origin, 500, { error: `Upload indexing failed: ${e?.message || e}` });
    }
  } else if (!greeting && libraryVS) {
    // General queries: use library only (NOT on greeting)
    tools.push({ type: "file_search", vector_store_ids: [libraryVS] });
    tool_choice = "auto";
  }

  // Build system prompt variants
  let systemPrompt = BASE_SYSTEM_PROMPT;
  if (upload_file_id) {
    systemPrompt += `\n\nYou MUST base your answer only on the attached document for this turn. If something isn't stated, say so.`;
  } else if (greeting) {
    systemPrompt += `\n\nUser greeted. Respond briefly and do not reference documents.`;
  } else {
    systemPrompt += `\n\nDo not mention any documents unless the user specifically asks about them.`;
  }

  const input = toResponsesInput(systemPrompt, history, userMessage);

  const payload = {
    model: "gpt-4o-mini-2024-07-18",
    input,
    text: { format: { type: "text" }, verbosity: "medium" },
    temperature: 1,
    tools,
    tool_choice,
  };

  const wantsStream = /\bstream=on\b/i.test(req.url || "");

  // STREAMING path
  if (wantsStream) {
    try {
      startSSE(res, origin);

      // If we created a temp store, let the client know (they show a banner)
      if (upload_file_id && tempVS) {
        sseEvent(res, "info", { note: "temp_vector_store_ready", id: tempVS.id });
      }

      const stream = await openai.responses.stream(payload);

      // Proxy OpenAI SSE directly to client
      const readable = stream.toReadableStream();
      readable.on("data", (chunk) => {
        // chunk is already SSE-formatted by the SDK
        res.write(chunk);
      });
      readable.on("end", () => {
        try {
          sseEvent(res, "done", "[DONE]");
        } finally {
          res.end();
        }
      });
      readable.on("error", (err) => {
        sseEvent(res, "error", { message: err?.message || String(err) });
        try { sseEvent(res, "done", "[DONE]"); } catch {}
        res.end();
      });

      return;
    } catch (err) {
      // Fallback error in SSE
      try {
        startSSE(res, origin);
      } catch {}
      sseEvent(res, "error", { message: `OpenAI stream failed: ${err?.message || String(err)}` });
      sseEvent(res, "done", "[DONE]");
      return res.end();
    }
  }

  // NON-STREAM path (simple JSON)
  try {
    const r = await openai.responses.create(payload);
    return sendJSON(res, origin, 200, r);
  } catch (err) {
    return sendJSON(res, origin, 500, { error: `OpenAI request failed: ${err?.message || String(err)}` });
  }
};
