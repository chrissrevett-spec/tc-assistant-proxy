// File: api/assistant.js
//
// Requirements (Vercel project-level env vars):
// - OPENAI_API_KEY        = sk-... (required)
// - OPENAI_ASSISTANT_ID   = asst_... (required)
// - CORS_ALLOW_ORIGIN     = https://www.talkingcare.uk (comma-separated list OK)
//
// Runtime: "nodejs" (do NOT use edge). In vercel.json don't set unsupported nodejs22.x.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ASSISTANT_ID   = process.env.OPENAI_ASSISTANT_ID || "";

function parseAllowedOrigins() {
  const raw = (process.env.CORS_ALLOW_ORIGIN || "").trim();
  if (!raw) return new Set(["https://www.talkingcare.uk"]);
  return new Set(raw.split(",").map(s => s.trim()).filter(Boolean));
}
const ALLOWED = parseAllowedOrigins();

function pickOrigin(req) {
  const origin = req.headers.origin || "";
  if (ALLOWED.has(origin)) return origin;
  // Fallback to first allowed origin to avoid reflecting arbitrary origins.
  return [...ALLOWED][0] || "https://www.talkingcare.uk";
}

function setCors(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function endPreflight(res) {
  res.statusCode = 204;
  res.end();
}

function bad(res, code, msg) {
  res.status(code).json({ ok: false, error: msg });
}

async function createThreadIfNeeded(threadId) {
  if (threadId) return threadId;
  const r = await fetch("https://api.openai.com/v1/threads", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({}),
  });
  if (!r.ok) throw new Error(`create_thread failed: ${r.status}`);
  const j = await r.json();
  return j.id; // thread_xxx
}

async function addUserMessage(threadId, userMessage) {
  const r = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({
      role: "user",
      content: userMessage,
    }),
  });
  if (!r.ok) throw new Error(`add_message failed: ${r.status}`);
  return r.json();
}

async function createRun(threadId) {
  const r = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({
      assistant_id: ASSISTANT_ID,
    }),
  });
  if (!r.ok) throw new Error(`create_run failed: ${r.status}`);
  return r.json(); // returns { id: "run_..." , ... }
}

async function getRun(threadId, runId) {
  const r = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "assistants=v2",
    },
  });
  if (!r.ok) throw new Error(`get_run failed: ${r.status}`);
  return r.json();
}

async function listMessages(threadId, limit = 10) {
  const r = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages?limit=${limit}`, {
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "assistants=v2",
    },
  });
  if (!r.ok) throw new Error(`list_messages failed: ${r.status}`);
  return r.json(); // { data: [ ... messages ... ] }
}

function extractTextAndCitations(messages) {
  // Collapse assistant messages to plain text; collect simple "citations" if any
  let text = "";
  const citations = [];

  for (const m of (messages?.data || [])) {
    if (m.role !== "assistant") continue;
    for (const c of (m.content || [])) {
      if (c.type === "text") {
        text += c.text?.value || "";
        // Scrape annotations into simple objects if present
        const anns = c.text?.annotations || [];
        for (const a of anns) {
          if (a.file_path?.file_id) {
            citations.push({ type: "file_path", file_id: a.file_path.file_id, path: a.file_path.path });
          } else if (a.file_citation?.file_id) {
            citations.push({ type: "file", file_id: a.file_citation.file_id });
          } else if (a.url) {
            citations.push({ type: "url", url: a.url });
          }
        }
        text += "\n";
      }
    }
  }
  return { text: text.trim(), citations };
}

async function streamRunToClient(res, threadId) {
  // OpenAI SSE stream: POST /runs/stream (NOT /runs/{run_id}/stream)
  const r = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/stream`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({
      assistant_id: ASSISTANT_ID,
    }),
  });

  if (!r.ok || !r.body) {
    const bodyText = await r.text().catch(() => "");
    throw new Error(`runs/stream failed: ${r.status} ${bodyText}`);
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder("utf-8");

  // We proxy *as-is* (OpenAI already formats as SSE events)
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    res.write(chunk);
  }
}

export default async function handler(req, res) {
  const origin = pickOrigin(req);
  setCors(res, origin);

  if (req.method === "OPTIONS") {
    return endPreflight(res);
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return bad(res, 405, "Method Not Allowed");
  }

  // Basic guardrails
  if (!OPENAI_API_KEY) return bad(res, 500, "Missing OPENAI_API_KEY");
  if (!ASSISTANT_ID)   return bad(res, 500, "Missing OPENAI_ASSISTANT_ID");

  // Parse body safely
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { userMessage = "", threadId = null } = body;
  const mode = (req.query?.stream || "").toString().toLowerCase(); // "on" or "" (off)

  try {
    // 1) Create/resolve thread
    const tid = await createThreadIfNeeded(threadId);

    // 2) Echo early SSE header if streaming
    if (mode === "on") {
      // Prepare SSE response
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept",
      });

      // Tell client the thread we're using
      res.write(`event: start\n`);
      res.write(`data: ${JSON.stringify({ ok: true, thread_id: tid })}\n\n`);

      // 3) Add the user message
      await addUserMessage(tid, userMessage);

      // 4) Pipe OpenAI SSE directly
      try {
        await streamRunToClient(res, tid);
      } catch (err) {
        // Emit an error event that the frontend understands
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ ok: false, step: "create_run_stream", error: String(err?.message || err) })}\n\n`);
      }

      // 5) Final marker for client
      res.write(`event: done\n`);
      res.write(`data: [DONE]\n\n`);
      res.end();
      return;
    }

    // ---- Non-streaming path (polling) ----
    // Add user message
    await addUserMessage(tid, userMessage);

    // Create run
    const run = await createRun(tid);

    // Poll until completed/failed/cancelled with a hard timeout
    const tStart = Date.now();
    let status = run.status;
    let last;

    while (!["completed", "failed", "cancelled", "expired"].includes(status)) {
      if (Date.now() - tStart > 90000) throw new Error("Run timeout after 90s");
      await new Promise(r => setTimeout(r, 1000));
      last = await getRun(tid, run.id);
      status = last.status;
    }

    if (status !== "completed") {
      return res.status(500).json({ ok: false, error: `Run status: ${status}`, thread_id: tid });
    }

    // Fetch recent messages and extract the latest assistant text
    const msgs = await listMessages(tid, 10);
    const { text, citations } = extractTextAndCitations(msgs);

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      ok: true,
      text: text || "(no assistant text)",
      thread_id: tid,
      citations,
      usage: null, // (the REST path doesn't return token usage here)
    });

  } catch (err) {
    console.error("Assistant API Error:", err);
    return res
      .status(500)
      .setHeader("Content-Type", "application/json; charset=utf-8")
      .json({ ok: false, error: "Internal Server Error" });
  }
}
