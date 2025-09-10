// /api/assistant.js
// Node runtime on Vercel (NOT edge). Make sure vercel.json sets runtime: "nodejs" for api/*.
//
// Env you need (Project-level):
// - OPENAI_API_KEY            (required)
// - OPENAI_ASSISTANT_ID       (required)
// - CORS_ALLOW_ORIGIN         (optional; default https://www.talkingcare.uk)

const OPENAI_API = "https://api.openai.com/v1";
const ASSISTANTS_BETA = "assistants=v2";

const ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN || "https://www.talkingcare.uk";
const API_KEY = process.env.OPENAI_API_KEY || "";
const ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || "";

function setCORS(req, res) {
  const origin = req.headers.origin || "";
  const allow = origin && origin === ALLOW_ORIGIN ? origin : ALLOW_ORIGIN;
  res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function endPreflight(res) {
  res.statusCode = 204;
  res.end();
}

function bad(res, code, error) {
  res.status(code).json({ ok: false, error });
}

async function oaFetch(path, opts = {}) {
  const headers = {
    "Authorization": `Bearer ${API_KEY}`,
    "OpenAI-Beta": ASSISTANTS_BETA,
    ...(opts.headers || {})
  };
  const r = await fetch(`${OPENAI_API}${path}`, { ...opts, headers });
  return r;
}

async function oaJson(path, opts = {}) {
  const r = await oaFetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {})
    }
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`${opts.method || "GET"} ${OPENAI_API}${path} failed: ${r.status} ${text}`);
  }
  return r.json();
}

function isRunTerminal(status) {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "expired"
  );
}

async function waitForRun(threadId, runId, timeoutMs = 60000, pollMs = 1100) {
  const start = Date.now();
  // Poll until run is terminal or timed out
  // We keep it simple & robust.
  while (true) {
    const run = await oaJson(`/threads/${threadId}/runs/${runId}`, { method: "GET" });
    if (isRunTerminal(run.status)) return run;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Run timeout after ${timeoutMs}ms (status: ${run.status})`);
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
}

// Get last assistant message text (merge parts)
function extractLastAssistantText(messages) {
  for (const msg of (messages.data || [])) {
    if (msg.role === "assistant") {
      let text = "";
      for (const p of (msg.content || [])) {
        if (p.type === "text" && p.text?.value) text += p.text.value;
      }
      return text || "";
    }
  }
  return "";
}

// Remove the raw “file file-xxxxx” dump from our JSON result.
// We simply don’t return a separate citations array anymore.
// If the assistant inserted inline bracketed citations, you’ll still see those in `text`.
function stripCitationsForClient() {
  return []; // intentionally empty
}

// STREAMING: pipe OpenAI SSE directly to client
async function streamRunToClient({ res, threadId, instructions }) {
  // Create run with stream=true -> OpenAI returns SSE directly in this single response.
  const r = await oaFetch(`/threads/${threadId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      assistant_id: ASSISTANT_ID,
      // Optional: pass short per-run instructions if you need (we forward from client)
      ...(instructions ? { instructions } : {}),
      stream: true
    })
  });

  // Forward OpenAI SSE headers
  res.writeHead(r.status, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
  });

  if (!r.ok || !r.body) {
    const text = await r.text().catch(() => "");
    // Emit a single error event in SSE format
    res.write(`event: error\n`);
    res.write(`data: ${JSON.stringify({ ok: false, step: "create_run_stream", error: text || `HTTP ${r.status}` })}\n\n`);
    res.write(`event: done\n`);
    res.write(`data: [DONE]\n\n`);
    res.end();
    return;
  }

  // Optionally notify client of thread id up-front
  res.write(`event: start\n`);
  res.write(`data: ${JSON.stringify({ ok: true, thread_id: threadId })}\n\n`);

  // Pipe chunks as-is
  const reader = r.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
  } catch (err) {
    // Best-effort error event (stream may have ended already)
    try {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ ok: false, step: "stream_forward", error: String(err && err.message || err) })}\n\n`);
    } catch {}
  } finally {
    // Finish the SSE stream
    try {
      res.write(`event: done\n`);
      res.write(`data: [DONE]\n\n`);
    } catch {}
    res.end();
  }
}

export default async function handler(req, res) {
  setCORS(req, res);

  if (req.method === "OPTIONS") return endPreflight(res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return bad(res, 405, "Method Not Allowed");
  }

  if (!API_KEY || !ASSISTANT_ID) {
    return bad(res, 500, "Server is missing OPENAI_API_KEY or OPENAI_ASSISTANT_ID");
  }

  try {
    // Some browsers (or your site JS) may send text/plain; parse safely
    let bodyRaw = req.body;
    if (typeof bodyRaw !== "object") {
      try { bodyRaw = JSON.parse(bodyRaw || "{}"); } catch { bodyRaw = {}; }
    }

    const { userMessage = "", threadId = null, instructions = "" } = bodyRaw;
    const streamFlag = String((req.query?.stream || "off")).toLowerCase();

    // 1) Create or reuse thread
    let tid = threadId;
    if (!tid) {
      // Create a new thread first; you can also create a combined run in one call, but
      // we keep a clear sequence to match your existing client logic.
      const t = await oaJson(`/threads`, { method: "POST", body: JSON.stringify({}) });
      tid = t.id;
    }

    // 2) Add user message to thread
    if (userMessage && streamFlag !== "none") {
      // Guard: If a previous run is somehow still active, OpenAI rejects new messages.
      // You already handle clearing thread client-side on error; here we simply add message.
      await oaJson(`/threads/${tid}/messages`, {
        method: "POST",
        body: JSON.stringify({ role: "user", content: userMessage })
      });
    }

    // 3) STREAMING mode — single request with stream=true (no /events)
    if (streamFlag === "on" || streamFlag === "true") {
      return await streamRunToClient({ res, threadId: tid, instructions });
    }

    // 4) NON-STREAMING mode — create run, poll, fetch last message
    const run = await oaJson(`/threads/${tid}/runs`, {
      method: "POST",
      body: JSON.stringify({
        assistant_id: ASSISTANT_ID,
        ...(instructions ? { instructions } : {})
      })
    });

    const finalRun = await waitForRun(tid, run.id, 60000, 1100);

    if (finalRun.status !== "completed") {
      return res.status(500).json({
        ok: false,
        step: "run_wait",
        error: `Run ended with status: ${finalRun.status}`,
        thread_id: tid,
      });
    }

    // Get last assistant message
    const msgs = await oaJson(`/threads/${tid}/messages?limit=10&order=desc`, { method: "GET" });
    const text = extractLastAssistantText(msgs);
    const citations = stripCitationsForClient();

    return res.status(200).json({
      ok: true,
      text: text || "Done.",
      thread_id: tid,
      citations,
      usage: null // (usage from Assistants is not always present per message)
    });

  } catch (err) {
    // Handle "active run" specifically so your client can clear the thread and retry
    const msg = String(err?.message || err || "");
    if (msg.includes("active run")) {
      return res.status(409).json({
        ok: false,
        busy: true,
        error: "Thread has an active run; please retry with a new thread.",
      });
    }
    console.error("assistant handler error:", err);
    return res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
}
