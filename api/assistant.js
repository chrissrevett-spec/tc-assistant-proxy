// api/assistant.js
export const config = { runtime: "nodejs" };

/**
 * Streaming SSE proxy to OpenAI Responses API with strict turn logic:
 * - If body.upload_file_id is present => create a TEMP vector store and use ONLY that store.
 * - Else => use ONLY the permanent library vector store (TCN_LIBRARY_VECTOR_STORE_ID).
 * - Never combine temp + library in the same turn.
 * - On upload turns, we also push an `info` event so the widget can show the green banner.
 */

const OAI = "https://api.openai.com/v1";
const MODEL = process.env.TCN_MODEL || "gpt-4o-mini-2024-07-18";
const LIBRARY_STORE_ID = process.env.TCN_LIBRARY_VECTOR_STORE_ID;
const INGEST_TIMEOUT_MS = Number(process.env.TCN_INGEST_TIMEOUT_MS || 60000);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  });

  const writeSSE = (event, dataObj) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(dataObj)}\n\n`);
    } catch {
      /* ignore */
    }
  };

  // Read JSON body
  let body;
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch (e) {
    writeSSE("error", { error: "Invalid JSON" });
    res.end();
    return;
  }

  const { userMessage, history = [], upload_file_id } = body || {};
  if (!userMessage || typeof userMessage !== "string") {
    writeSSE("error", { error: "Missing userMessage" });
    res.end();
    return;
  }

  writeSSE("start", { ok: true });

  // Build conversation input for Responses API
  const input = [];

  // System instructions (base)
  const SYSTEM_BASE = [
    "You are Talking Care Navigator (TCN), an expert assistant for adult social care in England.",
    "Scope: CQC standards/regulations and relevant guidance (England only).",
    "Do not provide medical/clinical/legal advice. If asked, advise contacting a qualified professional or hello@talkingcare.uk.",
    "Never advise on avoiding regulations; promote compliance and best practice.",
    "If query suggests abuse/neglect/safeguarding: advise escalation per safeguarding policy/local authority or emergency services.",
    "Do not request or process personal/sensitive data about service users or staff.",
    "Prefer primary sources (legislation.gov.uk, CQC/DHSC/NICE originals).",
    "Tone: plain UK English, clear steps/bullets where helpful, neutral and professional.",
    "Refer to the knowledge corpus as the 'Talking Care Navigator Library'.",
    "Do NOT say 'files you uploaded', 'uploads', or address the end user as the bot creator.",
    "If asked 'who created you?', say: 'I was created by Chris Revett at Talking Care.'",
    "If the answer cannot be found in your sources, say so rather than speculating.",
  ].join(" ");

  // History into input
  input.push({ role: "system", content: [{ type: "text", text: SYSTEM_BASE }] });
  for (const m of history) {
    if (!m || !m.role || !m.content) continue;
    input.push({ role: m.role, content: [{ type: "text", text: String(m.content) }] });
  }

  // Add the current user message
  input.push({ role: "user", content: [{ type: "text", text: userMessage }] });

  // Per-turn tool selection
  let tools = [];
  let extraSystem = "";

  let tempStoreId = null;
  const isUploadTurn = Boolean(upload_file_id);

  try {
    if (isUploadTurn) {
      // --- UPLOAD TURN: temp vector store ONLY ---
      // 1) Create temp store
      const vsResp = await fetch(`${OAI}/vector_stores`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: `tcn-temp-${Date.now()}` }),
      });
      if (!vsResp.ok) {
        const t = await vsResp.text().catch(() => "");
        throw new Error(`Temp store create failed: ${t || vsResp.status}`);
      }
      const vs = await vsResp.json();
      tempStoreId = vs.id;

      // 2) Attach the uploaded file to the temp store
      const addFileResp = await fetch(`${OAI}/vector_stores/${tempStoreId}/files`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file_id: upload_file_id }),
      });
      if (!addFileResp.ok) {
        const t = await addFileResp.text().catch(() => "");
        throw new Error(`Adding file to temp store failed: ${t || addFileResp.status}`);
      }
      const added = await addFileResp.json();
      const fileId = added?.file?.id || upload_file_id;

      // 3) Poll indexing status (until completed or timeout)
      const deadline = Date.now() + INGEST_TIMEOUT_MS;
      let status = "in_progress";
      let lastError = null;
      while (Date.now() < deadline) {
        const st = await fetch(`${OAI}/vector_stores/${tempStoreId}/files/${fileId}`, {
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        });
        if (!st.ok) {
          const t = await st.text().catch(() => "");
          throw new Error(`Status check failed: ${t || st.status}`);
        }
        const info = await st.json();
        status = info?.status || "in_progress";
        lastError = info?.last_error || null;
        if (status === "completed") break;
        if (status === "failed" || status === "cancelled") {
          throw new Error(lastError?.message || `Indexing ${status}`);
        }
        await sleep(800);
      }
      if (status !== "completed") {
        throw new Error("Indexing timeout");
      }

      // 4) Inform the UI that temp store is ready
      writeSSE("info", { note: "temp_vector_store_ready", id: tempStoreId });

      tools = [{ type: "file_search", vector_store_ids: [tempStoreId] }];

      // Per-turn hard rule for uploads
      extraSystem =
        "For this turn, answer ONLY from the attached document. " +
        "Do not use any external or library sources. " +
        "Do not say 'files you uploaded' or refer to uploads; if you must refer to the source, call it 'the attached document'. " +
        "If the answer is not in the attached document, say you can't find it in the attached document.";
    } else {
      // --- LIBRARY TURN: library store ONLY ---
      if (!LIBRARY_STORE_ID) {
        writeSSE("error", { error: "Missing TCN_LIBRARY_VECTOR_STORE_ID" });
        res.end();
        return;
      }
      tools = [{ type: "file_search", vector_store_ids: [LIBRARY_STORE_ID] }];

      extraSystem =
        "Use the Talking Care Navigator Library only. " +
        "Do not reference uploads. " +
        "Refer to sources as legislation/guidance names or 'the Talking Care Navigator Library' when appropriate.";
    }

    // Inject per-turn rule
    input.unshift({ role: "system", content: [{ type: "text", text: extraSystem }] });

    // --- Call OpenAI Responses API (streaming) ---
    const oaiReq = {
      model: MODEL,
      input,
      tools,
      stream: true,
      temperature: 0.4,
      tool_choice: "auto",
      parallel_tool_calls: true,
      store: true,
      text: { verbosity: "medium", format: { type: "text" } },
    };

    const r = await fetch(`${OAI}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(oaiReq),
    });

    if (!r.ok || !r.body) {
      const txt = await r.text().catch(() => "");
      writeSSE("error", { error: `OpenAI request failed: ${txt || r.status}` });
      res.end();
      return;
    }

    // Pipe OpenAI SSE stream straight through to the client
    const reader = r.body.getReader();
    const decoder = new TextDecoder("utf-8");
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value));
    }
  } catch (err) {
    // Tell the widget about temp store failure if this was an upload turn
    if (isUploadTurn) {
      writeSSE("info", {
        note: "temp_vector_store_failed",
        error: err?.message || "We couldn't prepare your document for search.",
      });
    } else {
      writeSSE("error", { error: err?.message || "Server error" });
    }
  } finally {
    // Graceful termination for SSE
    res.write("event: done\ndata: [DONE]\n\n");
    res.end();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
