// api/assistant.js  (CommonJS, Vercel Node serverless)
const OpenAI = require("openai");

// ---- OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- small utils
function getQuery(req) {
  if (req.query) return req.query;
  const qs = (req.url && req.url.includes("?")) ? req.url.split("?")[1] : "";
  const pairs = qs ? qs.split("&").map(kv => kv.split("=").map(decodeURIComponent)) : [];
  return Object.fromEntries(pairs);
}
async function readJson(req) {
  if (req.body) {
    if (typeof req.body === "string") {
      try { return JSON.parse(req.body); } catch { return {}; }
    }
    if (typeof req.body === "object") return req.body;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}
function sseHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
}
function safeStringify(v){ try { return JSON.stringify(v); } catch { return String(v); } }
function safeParse(v){ try { return JSON.parse(v); } catch { return { message: v }; } }

// ---- behavior
const SYSTEM_PROMPT = `
You are Talking Care Navigator, created by Chris Revett at Talking Care.
Be warm, concise, and practical.

Rules:
1) Do NOT mention “uploaded files”, “documents here”, vector stores, or similar unless this turn included an attachment (UI shows a green “Using: …” chip).
2) For greetings/small talk, reply briefly and do NOT bring up files or documents.
3) If asked “who created you?”, answer: “I was created by Chris Revett at Talking Care.”
4) When asked for sources, list only clean titles from annotations (no raw URLs).
`.trim();

function isGreeting(s = "") {
  return /^[\s]*((hi|hello|hey|hiya)(\s+there)?|good\s+(morning|afternoon|evening))[\s!\.]*$/i.test(s);
}
function mapHistory(history = []) {
  // Responses API expects assistant history entries as output_text
  return history.slice(-12).map(t => {
    const role = t.role === "assistant" ? "assistant" : "user";
    return {
      role,
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text: String(t.content || "") }]
    };
  });
}

async function createTempVectorStoreFromFile(fileId) {
  const name = `upload_${fileId.slice(-6)}_${Date.now()}`;
  // Prefer stable beta.* APIs; fall back to stable if available
  try {
    const vs = await openai.beta.vectorStores.create({ name });
    await openai.beta.vectorStores.files.create(vs.id, { file_id: fileId });
    return vs.id;
  } catch (e1) {
    try {
      const vs = await openai.vectorStores.create({ name });
      await openai.vectorStores.files.create(vs.id, { file_id: fileId });
      return vs.id;
    } catch (e2) {
      const err = new Error(e2?.message || e1?.message || "Vector store create failed");
      err.cause = e2 || e1;
      throw err;
    }
  }
}

function buildTools({ uploadVsId, greeting }) {
  if (greeting) return { tools: [], hasFileSearch: false };
  const base = (process.env.TCN_LIBRARY_VECTOR_STORE_ID || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const ids = [];
  if (uploadVsId) ids.push(uploadVsId);
  if (base.length) ids.push(...base);
  if (!ids.length) return { tools: [], hasFileSearch: false };
  return {
    tools: [{
      type: "file_search",
      vector_store_ids: ids,
      max_num_results: 20,
      ranking_options: { ranker: "auto", score_threshold: 0 }
    }],
    hasFileSearch: true
  };
}

function buildPayload({ userMessage, history, tools }) {
  const input = [
    { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
    ...mapHistory(history),
    { role: "user", content: [{ type: "input_text", text: String(userMessage || "") }] }
  ];
  const payload = {
    model: "gpt-4o-mini-2024-07-18",
    input,
    ...(tools.length ? { tools, tool_choice: "auto" } : { tool_choice: "none" }),
    temperature: 1,
    text: { format: { type: "text" }, verbosity: "medium" }
  };
  return payload;
}

// ---- handler (CommonJS export)
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const q = getQuery(req);
  const stream = String(q.stream || "").toLowerCase() === "on" || String(q.stream || "").toLowerCase() === "true";
  const body = await readJson(req);

  const userMessage  = String(body.userMessage || "");
  const history      = Array.isArray(body.history) ? body.history : [];
  const uploadFileId = body.upload_file_id || null;
  const greeting     = isGreeting(userMessage);

  // Prepare a temporary VS for this turn if we received a file_id
  let tempVsId = null, tempVsFailed = false, tempVsError = "";
  if (uploadFileId) {
    try { tempVsId = await createTempVectorStoreFromFile(uploadFileId); }
    catch (e) { tempVsFailed = true; tempVsError = e?.message || String(e); }
  }

  const { tools } = buildTools({ uploadVsId: tempVsId, greeting });

  // ---------- non-stream path ----------
  if (!stream) {
    try {
      const payload = buildPayload({ userMessage, history, tools });
      const resp = await openai.responses.create(payload);
      if (tempVsFailed) {
        return res.status(200).json({ ...resp, note: { type: "temp_vector_store_failed", message: tempVsError } });
      }
      return res.status(200).json(resp);
    } catch (err) {
      return res
        .status(200)
        .json({ error: `OpenAI request failed: ${safeStringify(err?.response?.data || err)}` });
    }
  }

  // ---------- SSE stream path ----------
  sseHeaders(res);
  // Start
  res.write(`event: start\n`);
  res.write(`data: ${JSON.stringify({ ok: true })}\n\n`);

  // Inform about temp VS status
  if (tempVsId) {
    res.write(`event: info\n`);
    res.write(`data: ${JSON.stringify({ note: "temp_vector_store_ready", id: tempVsId })}\n\n`);
  } else if (tempVsFailed) {
    res.write(`event: info\n`);
    res.write(`data: ${JSON.stringify({ note: "temp_vector_store_failed", error: tempVsError })}\n\n`);
  }

  try {
    const payload = buildPayload({ userMessage, history, tools });

    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ...payload, stream: true })
    });

    if (!upstream.ok || !upstream.body) {
      let txt = "";
      try { txt = await upstream.text(); } catch {}
      const data = txt ? safeParse(txt) : { message: `HTTP ${upstream.status}` };
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      res.write(`event: done\n`);
      res.write(`data: [DONE]\n\n`);
      return res.end();
    }

    const bodyStream = upstream.body;
    const decoder = new TextDecoder();

    if (typeof bodyStream.getReader === "function") {
      // Web Stream (Node 18+)
      const reader = bodyStream.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
    } else if (typeof bodyStream.on === "function") {
      // Node Readable
      await new Promise((resolve, reject) => {
        bodyStream.on("data", chunk => res.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        bodyStream.on("end", resolve);
        bodyStream.on("error", reject);
      });
    }

    res.write(`event: done\n`);
    res.write(`data: [DONE]\n\n`);
    res.end();
  } catch (err) {
    try {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ message: err?.message || "Stream failed", code: err?.code || "stream_error" })}\n\n`);
      res.write(`event: done\n`);
      res.write(`data: [DONE]\n\n`);
      res.end();
    } catch {
      if (!res.headersSent) {
        res.status(500).json({ error: "Stream failed to start", detail: err?.message || String(err) });
      }
    }
  }
};
