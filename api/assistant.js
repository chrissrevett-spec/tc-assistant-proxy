// api/assistant.js
// Node/Next/Vercel serverless API route
import OpenAI from "openai";

// ---------- Helpers ----------

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function getQuery(req) {
  // Next.js / Vercel provides req.query; fallback for plain Node
  return req.query || Object.fromEntries(
    (req.url?.split("?")[1] || "")
      .split("&")
      .filter(Boolean)
      .map(kv => kv.split("=").map(decodeURIComponent))
  );
}

function parseJsonBody(req) {
  // Next.js already parses JSON body into req.body (object)
  if (req.body && typeof req.body === "object") return req.body;
  try {
    if (typeof req.body === "string") return JSON.parse(req.body);
  } catch {}
  return {};
}

const SYSTEM_PROMPT = `
You are Talking Care Navigator, created by Chris Revett at Talking Care.
Be warm, concise, and practical.

Critical behaviour rules:
1) DO NOT mention or imply “uploaded files”, “documents I see”, vector stores, or any file context unless the user’s current turn explicitly included an attachment AND the server banner says we’re answering from the attached document.
2) For casual greetings or small talk, give a short, friendly reply and do not bring up documents or file analysis.
3) If the user asks “who created you?” answer: “I was created by Chris Revett at Talking Care.”
4) If asked to cite sources, list only the file titles or web page titles provided by the tool annotations (no raw URLs).
`.trim();

function isGreeting(text = "") {
  return /^[\s]*((hi|hello|hey|hiya)(\s+there)?|good\s+(morning|afternoon|evening))[\s!\.]*$/i.test(text);
}

// Map prior chat turns into Responses API input schema
function mapHistoryToInput(history = []) {
  return history.slice(-12).map(turn => {
    const role = (turn.role === "assistant") ? "assistant" : "user";
    const type = (role === "assistant") ? "output_text" : "input_text";
    return {
      role,
      content: [{ type, text: String(turn.content || "") }]
    };
  });
}

// Build file_search tools; never return an empty vector_store_ids array
function buildTools({ uploadVectorStoreId }) {
  // IMPORTANT: this is your configured base library vector store id.
  const baseVs = process.env.TCN_LIBRARY_VECTOR_STORE_ID || "";
  const ids = [];
  if (uploadVectorStoreId) ids.push(uploadVectorStoreId);
  if (baseVs) ids.push(baseVs);

  const tools = [];
  if (ids.length) {
    tools.push({
      type: "file_search",
      vector_store_ids: ids,
      max_num_results: 20,
      ranking_options: { ranker: "auto", score_threshold: 0 }
    });
  }
  return { tools, hasFileSearch: ids.length > 0 };
}

// Create a temporary vector store from a single uploaded file id
async function createTempVectorStoreFromFile(fileId) {
  const name = `upload_${fileId.slice(-6)}_${Date.now()}`;
  // Try GA API first; fall back to beta names if project is on older SDK
  try {
    const vs = await openai.vectorStores.create({ name });
    await openai.vectorStores.files.create(vs.id, { file_id: fileId });
    return vs.id;
  } catch (e1) {
    // Fallback to beta (older SDKs)
    try {
      const vs = await openai.beta.vectorStores.create({ name });
      await openai.beta.vectorStores.files.create(vs.id, { file_id: fileId });
      return vs.id;
    } catch (e2) {
      const err = new Error(`Vector store create failed: ${e1?.message || e1}`);
      err.cause = e1;
      throw err;
    }
  }
}

// Build the Responses API payload
function buildPayload({ userMessage, history, tools, tool_choice }) {
  const input = [
    // System as first message
    { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
    // Prior conversation
    ...mapHistoryToInput(history),
    // Current user turn
    { role: "user", content: [{ type: "input_text", text: String(userMessage || "") }] }
  ];

  const payload = {
    model: "gpt-4o-mini-2024-07-18",
    input,
    // IMPORTANT: only include tools if we actually have some
    ...(tools?.length ? { tools, tool_choice } : {}),
    temperature: 1,
    text: { format: { type: "text" }, verbosity: "medium" }
  };

  return payload;
}

function sseHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
}

// ---------- Route Handler ----------

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const query = getQuery(req);
  const streamRequested =
    String(query.stream || "").toLowerCase() === "on" ||
    String(query.stream || "").toLowerCase() === "true";

  const body = parseJsonBody(req);
  const userMessage = String(body.userMessage || "");
  const history = Array.isArray(body.history) ? body.history : [];
  const uploadFileId = body.upload_file_id || null;

  // If greeting, suppress file_search entirely
  const greeting = isGreeting(userMessage);

  // If a file id was provided this turn, build a one-off vector store
  let tempVectorStoreId = null;
  if (uploadFileId) {
    try {
      tempVectorStoreId = await createTempVectorStoreFromFile(uploadFileId);
    } catch (err) {
      if (streamRequested) {
        // For stream, we announce the failure but continue with no file_search
        sseHeaders(res);
        res.write(`event: start\n`);
        res.write(`data: ${JSON.stringify({ ok: true })}\n\n`);
        res.write(`event: info\n`);
        res.write(`data: ${JSON.stringify({ note: "temp_vector_store_failed", error: err?.message || String(err) })}\n\n`);
        // Fall through to continue streaming a normal (no tools) response
      } else {
        // Non-stream: return a friendly error, but not a 500
        return res.status(200).json({
          error: { message: "We couldn't prepare your document for search this time. You can still ask a question without the file." }
        });
      }
    }
  }

  // Build tools with safe guarding (no empty vector_store_ids)
  const { tools } = greeting
    ? { tools: [] }
    : buildTools({ uploadVectorStoreId: tempVectorStoreId });

  const tool_choice = tools.length ? "auto" : "none";

  // -------- Non-Streaming Path --------
  if (!streamRequested) {
    try {
      const payload = buildPayload({ userMessage, history, tools, tool_choice });
      const resp = await openai.responses.create(payload);
      return res.status(200).json(resp);
    } catch (err) {
      const payload = {
        error: `OpenAI request failed: ${safeStringify(err?.response?.data || err)}`,
      };
      return res.status(200).json(payload); // keep 200 so client UI shows it in-chat
    }
  }

  // -------- Streaming Path (SSE) --------
  try {
    sseHeaders(res);

    // Start event (client has a watchdog for this)
    res.write(`event: start\n`);
    res.write(`data: ${JSON.stringify({ ok: true })}\n\n`);

    // If we have a temp VS, announce it for the UI (green badge, etc)
    if (tempVectorStoreId) {
      res.write(`event: info\n`);
      res.write(`data: ${JSON.stringify({ note: "temp_vector_store_ready", id: tempVectorStoreId })}\n\n`);
    }

    // Build payload for streaming
    const payload = buildPayload({ userMessage, history, tools, tool_choice });

    // Call the REST endpoint directly with stream=true and pipe its SSE to client
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ...payload, stream: true })
    });

    if (!upstream.ok || !upstream.body) {
      let errTxt = "";
      try { errTxt = await upstream.text(); } catch {}
      const errorData = errTxt ? safeParse(errTxt) : { message: `HTTP ${upstream.status}` };
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify(errorData)}\n\n`);
      res.write(`event: done\n`);
      res.write(`data: [DONE]\n\n`);
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const encoder = new TextDecoder("utf-8");

    // Pipe all upstream SSE chunks through unchanged
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkStr = encoder.decode(value, { stream: true });
      // We simply forward upstream SSE lines as-is
      res.write(chunkStr);
    }

    // Ensure a closing done event if upstream omitted it
    res.write(`event: done\n`);
    res.write(`data: [DONE]\n\n`);
    res.end();
  } catch (err) {
    // Surface any server-side error as an SSE error event
    sseHeaders(res);
    res.write(`event: error\n`);
    res.write(`data: ${JSON.stringify({
      message: err?.message || "Stream failed",
      code: err?.code || err?.response?.status || "stream_error"
    })}\n\n`);
    res.write(`event: done\n`);
    res.write(`data: [DONE]\n\n`);
    res.end();
  }
}

// ---------- Small utils ----------

function safeStringify(obj) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}
function safeParse(txt) {
  try { return JSON.parse(txt); } catch { return { message: txt }; }
}
