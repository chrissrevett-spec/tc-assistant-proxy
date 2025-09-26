// /api/assistant.js  (Node / Vercel serverless, CommonJS)
//
// What this does:
// - CORS for your site
// - Small-talk gating (no tools on greetings)
// - If upload_file_id present => make temp vector store, attach file, wait until ready, use ONLY that VS
// - Else => use library VS (TCN_LIBRARY_VECTOR_STORE_ID)
// - Streams raw OpenAI SSE to the browser so your widget parser works
//
// Env vars used:
// - OPENAI_API_KEY                      (required)
// - TCN_LIBRARY_VECTOR_STORE_ID         (optional but recommended)
// - TCN_ALLOWED_ORIGIN                  (optional; default https://www.talkingcare.uk)
// - TCN_MODEL                           (optional; default gpt-4o-mini-2024-07-18)

const https = require("https");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LIBRARY_VS_ID = process.env.TCN_LIBRARY_VECTOR_STORE_ID || "";
const ALLOWED_ORIGIN = process.env.TCN_ALLOWED_ORIGIN || "https://www.talkingcare.uk";
const MODEL = process.env.TCN_MODEL || "gpt-4o-mini-2024-07-18";

if (!OPENAI_API_KEY) {
  console.warn("[/api/assistant] Missing OPENAI_API_KEY env var.");
}

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function isGreeting(s) {
  if (!s) return false;
  const t = s.trim().toLowerCase();
  // short casual banter & greetings
  const simple = /^(hi|hey|hello|yo|hiya|sup|howdy|oi|morning|afternoon|evening|what'?s up|whatsup|wassup|u ok\??|you ok\??|how are (you|u)\??|hiya there|hello there)!?$/i;
  // very short tokens count as greeting
  if (t.length <= 12 && simple.test(t)) return true;
  return simple.test(t);
}

function systemPrompt(uploadTurn) {
  // Keep it short; your full policy lives in the main system prompt elsewhere if you prefer.
  // Key behaviour we enforce server-side:
  return [
    "You are Talking Care Navigator. Scope: adult social care in England only.",
    "Safety: no medical/clinical/legal advice; suggest qualified professionals when asked.",
    "Evidence order: (1) attached document for THIS TURN (if present), (2) Talking Care Navigator Library, (3) external web only if needed.",
    "Never mention implementation (vector stores, IDs, tools).",
    "Strict phrasing rules:",
    "- Do NOT say 'file(s) you uploaded', 'your upload(s)', or similar.",
    "- If a file was attached THIS TURN, refer to it only as 'the attached document'.",
    "- If no file was attached THIS TURN, refer to sources as 'the Talking Care Navigator Library'.",
    "Greeting/small talk: do NOT search or cite sources; reply briefly and ask how you can help.",
    uploadTurn
      ? "A file is attached for this user turn. Base the answer ONLY on the attached document. Do NOT use the library or external sources for this turn."
      : "No file is attached this turn. You may consult the Talking Care Navigator Library if relevant, but do not mention documents unless the user asks a content question."
  ].join("\n");
}

function jsonSSE(res, event, obj) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function endSSE(res) {
  res.write("event: done\n");
  res.write("data: [DONE]\n\n");
  res.end();
}

// ---- OpenAI REST helpers (no SDK) ----

async function openaiFetch(path, { method = "GET", headers = {}, body, stream = false } = {}) {
  const url = `https://api.openai.com${path}`;
  const baseHeaders = {
    "Authorization": `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json"
  };
  const finalHeaders = stream
    ? { ...baseHeaders, ...headers, "Accept": "text/event-stream" }
    : { ...baseHeaders, ...headers };

  return fetch(url, {
    method,
    headers: finalHeaders,
    body: body ? JSON.stringify(body) : undefined,
    // ensure Node uses http/1.1 to keep SSE happy
    dispatcher: new https.Agent({ keepAlive: true })
  });
}

async function createTempVectorStore(name = "TCN temp store") {
  const r = await openaiFetch("/v1/vector_stores", {
    method: "POST",
    body: { name }
  });
  if (!r.ok) throw new Error(`create vector store failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  return data.id;
}

async function addFileToVectorStore(vectorStoreId, fileId) {
  const r = await openaiFetch(`/v1/vector_stores/${vectorStoreId}/files`, {
    method: "POST",
    body: { file_id: fileId }
  });
  if (!r.ok) throw new Error(`add file failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  return { vsFileId: data.id };
}

async function waitForVSFileReady(vectorStoreId, vsFileId, { timeoutMs = 30000, pollMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const r = await openaiFetch(`/v1/vector_stores/${vectorStoreId}/files/${vsFileId}`, { method: "GET" });
    if (!r.ok) throw new Error(`poll vs file failed: ${r.status} ${await r.text()}`);
    const d = await r.json();
    lastStatus = d.status || "";
    if (lastStatus === "completed") return;
    if (lastStatus === "failed") throw new Error(`vector store file indexing failed`);
    await new Promise(res => setTimeout(res, pollMs));
  }
  throw new Error(`vector store file not ready in time (last status: ${lastStatus})`);
}

function mapHistoryToInput(history = []) {
  // Map prior turns to Responses "input" format.
  // user => input_text; assistant => output_text
  const arr = [];
  for (const turn of history) {
    if (!turn || !turn.role || !turn.content) continue;
    const text = String(turn.content);
    if (!text) continue;
    if (turn.role === "user") {
      arr.push({ role: "user", content: [{ type: "input_text", text }] });
    } else if (turn.role === "assistant") {
      arr.push({ role: "assistant", content: [{ type: "output_text", text }] });
    }
  }
  return arr;
}

module.exports = async (req, res) => {
  setCORS(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST, OPTIONS");
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  try {
    // Parse query (for ?stream=on)
    let streaming = false;
    try {
      const url = new URL(req.url, "http://localhost");
      streaming = url.searchParams.get("stream") === "on";
    } catch {}

    // Parse JSON body (do NOT read twice)
    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on("data", (c) => chunks.push(c));
      req.on("end", resolve);
      req.on("error", reject);
    });
    const raw = Buffer.concat(chunks).toString("utf8") || "{}";
    const { userMessage, history, upload_file_id } = JSON.parse(raw);

    if (!userMessage || typeof userMessage !== "string") {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Missing userMessage" }));
      return;
    }

    const greeting = isGreeting(userMessage);

    // Build Responses input
    const uploadTurn = !!upload_file_id;
    const input = [
      { role: "system", content: [{ type: "input_text", text: systemPrompt(uploadTurn) }] },
      ...mapHistoryToInput(history || []),
      { role: "user", content: [{ type: "input_text", text: userMessage }] }
    ];

    // Decide tools & tool_choice
    let tools = [];
    let tool_choice = "none";
    let vector_store_ids = [];

    let tempVectorStoreId = null;

    if (!greeting) {
      if (uploadTurn) {
        // Build temp store only for THIS TURN
        tempVectorStoreId = await createTempVectorStore("TCN temp – this turn");
        const { vsFileId } = await addFileToVectorStore(tempVectorStoreId, upload_file_id);
        // If streaming to client, announce readiness phases
        if (streaming) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
            "Access-Control-Allow-Headers": "Content-Type, Authorization"
          });
          jsonSSE(res, "start", { ok: true });
          jsonSSE(res, "info", { note: "temp_vector_store_created", id: tempVectorStoreId });
        }

        await waitForVSFileReady(tempVectorStoreId, vsFileId);
        if (streaming) {
          jsonSSE(res, "info", { note: "temp_vector_store_ready", id: tempVectorStoreId });
        }

        vector_store_ids = [tempVectorStoreId];
        tools = [{ type: "file_search", vector_store_ids }];
        tool_choice = "auto";
      } else if (LIBRARY_VS_ID) {
        vector_store_ids = [LIBRARY_VS_ID];
        tools = [{ type: "file_search", vector_store_ids }];
        tool_choice = "auto";
      } else {
        // No tools if no library id configured
        tools = [];
        tool_choice = "none";
      }
    } else {
      // Greeting => hard disable tools
      tools = [];
      tool_choice = "none";
    }

    // Prepare payload
    const payloadBase = {
      model: MODEL,
      input,
      temperature: 1.0,
      tool_choice,
      tools,
      text: { format: { type: "text" }, verbosity: "medium" },
      store: true,
      top_p: 1.0,
      truncation: "disabled"
    };

    if (!streaming) {
      // Non-streaming JSON
      const r = await openaiFetch("/v1/responses", {
        method: "POST",
        body: payloadBase,
        stream: false
      });

      const txt = await r.text();
      if (!r.ok) {
        res.statusCode = r.status;
        res.end(JSON.stringify({ error: `OpenAI request failed: ${txt}` }));
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(txt);
      return;
    }

    // Streaming path — if we didn't already send headers (uploadTurn branch),
    // do it now. (If uploadTurn, headers were sent earlier to emit 'start'/'info'.)
    if (!res.headersSent) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      });
      jsonSSE(res, "start", { ok: true });
    }

    // Now call OpenAI with stream=true and pipe SSE through as-is
    const openaiResp = await openaiFetch("/v1/responses", {
      method: "POST",
      body: { ...payloadBase, stream: true },
      stream: true
    });

    if (!openaiResp.ok || !openaiResp.body) {
      const errTxt = await openaiResp.text().catch(() => "");
      jsonSSE(res, "error", { message: `OpenAI stream failed: ${errTxt || `HTTP ${openaiResp.status}`}` });
      endSSE(res);
      return;
    }

    // Pipe OpenAI SSE to client
    const reader = openaiResp.body.getReader();
    const decoder = new TextDecoder();

    try {
      // forward OpenAI SSE chunks
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          res.write(decoder.decode(value));
        }
      }
    } catch (e) {
      jsonSSE(res, "error", { message: String(e && e.message || e) });
    } finally {
      endSSE(res);
    }
  } catch (err) {
    console.error("assistant error:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      setCORS(res);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: (err && err.message) || String(err) }));
      return;
    }
    try {
      jsonSSE(res, "error", { message: (err && err.message) || String(err) });
      endSSE(res);
    } catch {}
  }
};
