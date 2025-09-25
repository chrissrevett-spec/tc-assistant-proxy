// api/assistant.js
export const config = { runtime: "nodejs" };

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

  const sse = (event, data) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {}
  };

  // Parse body
  let body;
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    sse("error", { error: "Invalid JSON" });
    res.end();
    return;
  }

  const { userMessage, history = [], upload_file_id } = body || {};
  if (!userMessage || typeof userMessage !== "string") {
    sse("error", { error: "Missing userMessage" });
    res.end();
    return;
  }

  sse("start", { ok: true });

  // Base system policy
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
    "If the answer cannot be found in your sources, say so rather than speculating."
  ].join(" ");

  // Build Responses API input
  const input = [];

  // Add per-turn routing instruction first (filled below)
  let extraSystem = "";

  // Add base system
  input.push({
    role: "system",
    content: [{ type: "input_text", text: SYSTEM_BASE }],
  });

  // Add prior turns — IMPORTANT: map content type by role
  for (const m of history) {
    if (!m || !m.role || m.content == null) continue;
    const role = m.role === "assistant" ? "assistant" : (m.role === "user" ? "user" : "system");
    const text = String(m.content);
    const type = role === "assistant" ? "output_text" : "input_text";
    input.push({ role, content: [{ type, text }] });
  }

  // Add current user message
  input.push({ role: "user", content: [{ type: "input_text", text: userMessage }] });

  // Tool routing
  let tools = [];
  let tempStoreId = null;
  const isUploadTurn = Boolean(upload_file_id);

  try {
    if (isUploadTurn) {
      // TEMP VECTOR STORE (upload turn only)
      const vsResp = await fetch(`${OAI}/vector_stores`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: `tcn-temp-${Date.now()}` }),
      });
      if (!vsResp.ok) throw new Error(await vsResp.text());

      const vs = await vsResp.json();
      tempStoreId = vs.id;

      // Add uploaded file to temp store
      const addFileResp = await fetch(`${OAI}/vector_stores/${tempStoreId}/files`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file_id: upload_file_id }),
      });
      if (!addFileResp.ok) throw new Error(await addFileResp.text());
      const added = await addFileResp.json();
      const addedId = added?.file?.id || upload_file_id;

      // Wait for indexing
      const deadline = Date.now() + INGEST_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const st = await fetch(`${OAI}/vector_stores/${tempStoreId}/files/${addedId}`, {
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        });
        if (!st.ok) throw new Error(await st.text());
        const info = await st.json();
        if (info?.status === "completed") break;
        if (info?.status === "failed" || info?.status === "cancelled") {
          throw new Error(info?.last_error?.message || `Indexing ${info?.status}`);
        }
        await new Promise(r => setTimeout(r, 800));
      }

      sse("info", { note: "temp_vector_store_ready", id: tempStoreId });

      tools = [{ type: "file_search", vector_store_ids: [tempStoreId] }];
      extraSystem =
        "For this turn, answer ONLY from the attached document. " +
        "Do not use external sites or the library store. " +
        "Do not say 'files you uploaded' — say 'the attached document'. " +
        "If the answer is not in the attached document, say so.";
    } else {
      // LIBRARY STORE (normal turn)
      if (!LIBRARY_STORE_ID) {
        sse("error", { error: "Missing TCN_LIBRARY_VECTOR_STORE_ID" });
        res.end();
        return;
      }
      tools = [{ type: "file_search", vector_store_ids: [LIBRARY_STORE_ID] }];
      extraSystem =
        "Use the Talking Care Navigator Library only. " +
        "Do not reference user uploads. " +
        "Refer to sources by name (e.g., the guidance title) or as 'the Talking Care Navigator Library' when appropriate.";
    }

    // Prepend the per-turn rule
    input.unshift({ role: "system", content: [{ type: "input_text", text: extraSystem }] });

    // Responses API call (stream)
    const reqBody = {
      model: MODEL,
      input,
      tools,
      stream: true,
      temperature: 0.4,
      tool_choice: "auto",
      parallel_tool_calls: true,
      store: true,
      text: { format: { type: "text" } },
    };

    const r = await fetch(`${OAI}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reqBody),
    });

    if (!r.ok || !r.body) {
      const txt = await r.text().catch(() => "");
      sse("error", { error: `OpenAI request failed: ${txt || r.status}` });
      res.end();
      return;
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder("utf-8");
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value));
    }
  } catch (err) {
    if (isUploadTurn) {
      sse("info", { note: "temp_vector_store_failed", error: err?.message || "Indexing failed." });
    } else {
      sse("error", { error: err?.message || "Server error" });
    }
  } finally {
    res.write("event: done\ndata: [DONE]\n\n");
    res.end();
  }
}
