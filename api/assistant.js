/**
 * /api/assistant.js
 * ------------------------------------------------------------
 * - Responses API (streaming via SSE)
 * - Optional per-turn temp vector store when a file is attached
 * - Tool gating: disables file/web search for greetings/small-talk
 * - Maps history to proper content types (user: input_text, assistant: output_text)
 * - Adds strong phrasing guardrails to avoid "files you've uploaded" wording
 *
 * ENV:
 *   OPENAI_API_KEY                (required)
 *   OPENAI_MODEL                  (optional; default gpt-4o-mini-2024-07-18)
 *   PERMANENT_VECTOR_STORE_ID     (optional; your long-lived library VS)
 */

export const config = {
  api: {
    bodyParser: false, // we read the stream ourselves for SSE; we'll JSON-parse manually
  },
};

const OPENAI_API_BASE = "https://api.openai.com/v1";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini-2024-07-18";

// -----------------------------
// Utilities
// -----------------------------
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sseWrite(res, event, objOrString) {
  if (event) res.write(`event: ${event}\n`);
  if (objOrString !== undefined) {
    const data =
      typeof objOrString === "string"
        ? objOrString
        : JSON.stringify(objOrString);
    res.write(`data: ${data}\n\n`);
  } else {
    res.write(`\n`);
  }
}

function allowCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

// -----------------------------
// Guardrails: greetings/small talk
// -----------------------------
const GREETING_RE =
  /^\s*(hi|hello|hey|hiya|yo|good\s+(morning|afternoon|evening)|afternoon|morning)\b/i;
const SMALL_TALK_RE =
  /\b(how are you|who (are|made|created) you|who built you|what can you do|your name|help|hello there)\b/i;

function shouldUseTools(userText, hasUploadThisTurn) {
  if (hasUploadThisTurn) return true;
  const t = (userText || "").trim();
  if (GREETING_RE.test(t)) return false;
  if (SMALL_TALK_RE.test(t)) return false;
  return true;
}

// -----------------------------
// System instructions
// -----------------------------
const SYSTEM_PROMPT = `
Internal Instructions: Adult social care best practice assistant (Talking Care Navigator)

You are an expert assistant for Care Quality Commission (CQC) standards/regulations and related policies, frameworks, guidance and legislation for adult social care services in England.

Important phrasing rules:
- Never say "files you uploaded", "your uploads", or address the user as the creator.
- Refer to all documents collectively as the "Talking Care Navigator Library".
- Only on the same turn that a user has attached a file, you may refer to it once as "the attached document".
- For simple greetings or small talk, do not mention the library or any documents unless the user asks about them.

Scope and boundaries:
- Only provide guidance relevant to adult social care in England.
- If a task is unrelated, give a light-touch response and explain it is outside your remit.
- Do not give medical, clinical, or legal advice. Direct users to a suitably qualified professional or hello@talkingcare.uk.
- Do not provide strategies to avoid or work around regulations. Promote compliance and best practice.
- If asked about Scotland, Wales, or Northern Ireland, explain frameworks differ and are outside your remit.

Safety and compliance:
- If a query suggests abuse, neglect, or safeguarding risk, advise immediate escalation per safeguarding policy and contacting the local authority safeguarding team (or emergency services if urgent).
- Do not request or process personal or sensitive information about service users or staff.
- Users remain responsible for their own compliance. Do not guarantee compliance.

Source use and referencing:
- Document-first. Prefer primary sources (legislation.gov.uk, CQC/DHSC/NICE originals).
- If you use the internet, say so and note content may not be authoritative.
- If combining sources, distinguish library vs external.
- Flag if a referenced item may be an older version.
- If the user attached files in this turn, treat them as primary sources and cite them as such.

Tone and communication:
- Use plain UK English. Neutral, professional, helpful.
- Provide step-by-step or bullet guidance where possible.
- Adjust framing for directors (strategic), managers (operational compliance), support workers (clear practical steps).
- When greeted (e.g., "Hi/hello/hey"), respond in kind and ask: "How may I assist you today?"

Operational guardrails:
- If the answer cannot be found in your sources, say so.
- Use the internet only after internal sources; say when you do this.
- Do not create or advise on contracts, legal submissions, or tribunal appeals; recommend human/legal support.
- For grey areas or matters needing professional judgment, direct to hello@talkingcare.uk.
- Note where frameworks are being replaced/updated.

Attribution:
- If asked who created you, respond: "I was created by Chris Revett at Talking Care."

Reminder:
- Avoid any phrasing that implies the user is the system creator or has uploaded files; use the terms above instead.
`.trim();

// -----------------------------
// Vector store helpers
// -----------------------------
async function createVectorStore(name) {
  const r = await fetch(`${OPENAI_API_BASE}/vector_stores`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
    // Node 18+ needs duplex for streamed requests with a body;
    // here it's small, but we add it for consistency across Node versions.
    duplex: "half",
  });
  if (!r.ok) throw new Error(`VS create failed: ${await r.text()}`);
  return r.json();
}

async function addFileToVectorStore(vsId, fileId) {
  const r = await fetch(`${OPENAI_API_BASE}/vector_stores/${vsId}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file_id: fileId }),
    duplex: "half",
  });
  if (!r.ok) throw new Error(`VS add file failed: ${await r.text()}`);
  return r.json();
}

async function getVectorStoreFile(vsId, vsFileId) {
  const r = await fetch(
    `${OPENAI_API_BASE}/vector_stores/${vsId}/files/${vsFileId}`,
    {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    }
  );
  if (!r.ok) throw new Error(`VS file status failed: ${await r.text()}`);
  return r.json();
}

async function waitForFileIndexed(vsId, vsFileId, timeoutMs = 120000) {
  const start = Date.now();
  while (true) {
    const f = await getVectorStoreFile(vsId, vsFileId);
    if (f.status === "completed") return f;
    if (f.status === "failed" || f.status === "cancelled") {
      throw new Error(`Vector store indexing ${f.status}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("Vector store indexing timeout");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// -----------------------------
// Input mapping for Responses API
// -----------------------------
function mapHistoryToInput(history = []) {
  // history: [{role:'user'|'assistant', content:'...'}, ...]
  const input = [];

  // System first
  input.push({
    role: "system",
    content: [{ type: "input_text", text: SYSTEM_PROMPT }],
  });

  for (const turn of history) {
    if (!turn || !turn.role || !turn.content) continue;
    if (turn.role === "user") {
      input.push({
        role: "user",
        content: [{ type: "input_text", text: String(turn.content) }],
      });
    } else if (turn.role === "assistant") {
      // IMPORTANT: assistant history must be output_text (or refusal)
      input.push({
        role: "assistant",
        content: [{ type: "output_text", text: String(turn.content) }],
      });
    }
  }

  return input;
}

// -----------------------------
// Build tool config
// -----------------------------
function buildToolConfig(userText, tempVectorStoreId) {
  const storeIds = [];
  if (tempVectorStoreId) storeIds.push(tempVectorStoreId);
  if (process.env.PERMANENT_VECTOR_STORE_ID) {
    storeIds.push(process.env.PERMANENT_VECTOR_STORE_ID);
  }

  const allowTools = shouldUseTools(userText, Boolean(tempVectorStoreId));

  const tools = allowTools
    ? [
        { type: "file_search", vector_store_ids: storeIds, max_num_results: 20 },
        { type: "web_search" },
      ]
    : [];

  const tool_choice = allowTools ? "auto" : "none";
  return { tools, tool_choice };
}

// -----------------------------
// Main handler
// -----------------------------
export default async function handler(req, res) {
  if (allowCors(req, res)) return;
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!process.env.OPENAI_API_KEY) {
    res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    return;
  }

  // Parse body (we disabled the Next bodyParser above)
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.status(400).json({ error: `Invalid JSON: ${e?.message || e}` });
    return;
  }

  const { userMessage, history, upload_file_id } = body || {};
  const text = (userMessage || "").toString();

  // Decide if streaming
  const url = new URL(req.url, `http://${req.headers.host}`);
  const streamOn = url.searchParams.get("stream") === "on";

  if (!streamOn) {
    // Non-streaming (rare in your widget, but kept for completeness)
    try {
      const result = await runOnce({ text, history, uploadFileId: upload_file_id });
      res.status(200).json(result);
    } catch (e) {
      res.status(500).json({ error: e?.message || String(e) });
    }
    return;
  }

  // Streaming SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Let client know we’re alive
  sseWrite(res, "start", { ok: true });

  let tempVSId = null;

  // If a file was attached THIS TURN, build a temp vector store for it
  if (upload_file_id) {
    try {
      const vs = await createVectorStore("tcn-upload-turn");
      tempVSId = vs.id;
      // add the file to this VS
      const vsFile = await addFileToVectorStore(tempVSId, upload_file_id);
      // let UI know we created the temp VS
      sseWrite(res, "info", { note: "temp_vector_store_ready", id: tempVSId });
      // Wait until indexed (so search works immediately)
      await waitForFileIndexed(tempVSId, vsFile.id);
    } catch (e) {
      sseWrite(res, "info", {
        note: "temp_vector_store_failed",
        error: e?.message || String(e),
      });
      // Continue without temp VS
      tempVSId = null;
    }
  }

  // Build Responses payload
  const input = mapHistoryToInput(history);
  input.push({
    role: "user",
    content: [{ type: "input_text", text }],
  });

  const { tools, tool_choice } = buildToolConfig(text, tempVSId);

  const payload = {
    model: MODEL,
    input,
    tools,
    tool_choice,
    text: { format: { type: "text" } },
    temperature: 1.0,
    store: true,
    service_tier: "auto",
    parallel_tool_calls: true,
  };

  let upstream;
  try {
    upstream = await fetch(`${OPENAI_API_BASE}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
      duplex: "half",
    });
  } catch (e) {
    sseWrite(res, "error", {
      error: `OpenAI request failed to send: ${e?.message || e}`,
    });
    res.end();
    return;
  }

  if (!upstream.ok || !upstream.body) {
    let details = "";
    try {
      details = await upstream.text();
    } catch (_) {}
    sseWrite(res, "error", {
      error: `OpenAI request failed: ${details || `HTTP ${upstream.status}`}`,
    });
    res.end();
    return;
  }

  try {
    // Pipe OpenAI SSE frames straight through to the client
    for await (const chunk of upstream.body) {
      res.write(chunk);
    }
  } catch (e) {
    // network interruptions etc.
    sseWrite(res, "error", { error: e?.message || String(e) });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

// -----------------------------
// Non-streaming helper (optional path)
// -----------------------------
async function runOnce({ text, history, uploadFileId }) {
  let tempVSId = null;

  if (uploadFileId) {
    const vs = await createVectorStore("tcn-upload-turn");
    tempVSId = vs.id;
    const vsFile = await addFileToVectorStore(tempVSId, uploadFileId);
    await waitForFileIndexed(tempVSId, vsFile.id);
  }

  const input = mapHistoryToInput(history);
  input.push({ role: "user", content: [{ type: "input_text", text }] });

  const { tools, tool_choice } = buildToolConfig(text, tempVSId);

  const payload = {
    model: MODEL,
    input,
    tools,
    tool_choice,
    text: { format: { type: "text" } },
    temperature: 1.0,
    store: true,
    service_tier: "auto",
    parallel_tool_calls: true,
  };

  const r = await fetch(`${OPENAI_API_BASE}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    duplex: "half",
  });

  if (!r.ok) throw new Error(await r.text());
  const json = await r.json();
  return json;
}
