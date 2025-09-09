// api/assistant.js
//
// Assistants v2 proxy with JSON (non-stream) and SSE streaming modes.
// Requirements (Vercel Project > Settings > Environment Variables):
//   - OPENAI_API_KEY            (Required)   e.g. sk-...
//   - OPENAI_ASSISTANT_ID       (Required)   e.g. asst_...
//   - CORS_ALLOW_ORIGIN         (Optional)   default https://www.talkingcare.uk
//
// Notes:
// - STREAM mode uses the official helper endpoint:
//     POST /v1/threads/{thread_id}/runs/stream
// - JSON mode creates a run and polls until completion, then returns the last message text.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;
const DEFAULT_ORIGIN = process.env.CORS_ALLOW_ORIGIN || "https://www.talkingcare.uk";

// --- Basic CORS helpers ---
function setCors(res, origin = DEFAULT_ORIGIN) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400"); // 1 day preflight cache
}

function endPreflight(res) {
  res.statusCode = 204;
  res.end();
}

function pickOrigin(req) {
  // If you want to strictly pin, just return DEFAULT_ORIGIN.
  // If you want to allow the requesting Origin when present:
  const origin = req.headers.origin || DEFAULT_ORIGIN;
  return origin;
}

// Small helper
async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Get latest assistant text from thread
async function fetchLatestMessageText(threadId) {
  const r = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages?limit=20&order=desc`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "assistants=v2",
    },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`messages list failed ${r.status}: ${t}`);
  }
  const data = await r.json();
  for (const m of data.data || []) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === "output_text" && c.text?.value) return c.text.value;
        if (c.type === "text" && c.text?.value) return c.text.value; // older shape just in case
      }
    }
  }
  return "";
}

export default async function handler(req, res) {
  const origin = pickOrigin(req);
  setCors(res, origin);

  // OPTIONS preflight
  if (req.method === "OPTIONS") return endPreflight(res);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // Validate env
  if (!OPENAI_API_KEY || !OPENAI_ASSISTANT_ID) {
    return res.status(500).json({ ok: false, error: "Missing OPENAI_API_KEY or OPENAI_ASSISTANT_ID" });
  }

  // Parse JSON body
  const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {}); }
  catch { body = {}; }

  const userMessage = (body.userMessage || "").toString();
  let threadId = body.threadId || null;

  // Decide mode: stream=off (default JSON) vs stream (SSE)
  const url = new URL(req.url, "http://localhost");
  const streamFlag = (url.searchParams.get("stream") || "").toLowerCase();
  const wantStream = streamFlag && streamFlag !== "off";

  try {
    // Ensure we have a thread
    if (!threadId) {
      const t = await fetch("https://api.openai.com/v1/threads", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      if (!t.ok) {
        const txt = await t.text().catch(() => "");
        return res.status(502).json({ ok: false, step: "create_thread", error: txt || `thread create failed ${t.status}` });
      }
      const td = await t.json();
      threadId = td.id;
    }

    // --- STREAMING MODE ---
    if (wantStream) {
      // SSE headers (also include CORS headers)
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept",
      });

      const sse = (event, data) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
      };

      // Tell the client which thread we’re using
      sse("start", { ok: true, thread_id: threadId });

      // Correct helper endpoint — THIS is the key fix:
      // POST /v1/threads/{thread_id}/runs/stream  (Accept: text/event-stream)
      const upstream = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/stream`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2",
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          assistant_id: OPENAI_ASSISTANT_ID,
          // Use "instructions" to pass your composed prompt
          instructions: userMessage || "Reply briefly.",
        }),
      });

      if (!upstream.ok || !upstream.body) {
        const txt = await upstream.text().catch(() => "");
        sse("error", { ok: false, step: "create_run_stream", error: txt || `upstream ${upstream.status}` });
        sse("done", "[DONE]");
        return res.end();
      }

      // Pipe OpenAI SSE through unchanged so your frontend can handle
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          // The chunk from OpenAI is already SSE-formatted (event: ..., data: ...).
          // We forward as-is.
          res.write(chunk);
        }
      } catch (e) {
        // If the client disconnects, just stop
      }

      // End our stream cleanly
      sse("done", "[DONE]");
      return res.end();
    }

    // --- JSON (non-streaming) MODE ---
    // 1) Add user message to the thread (optional in v2; instructions alone also works).
    if (userMessage) {
      const addMsg = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          role: "user",
          content: userMessage,
        }),
      });
      if (!addMsg.ok) {
        const txt = await addMsg.text().catch(() => "");
        return res.status(502).json({ ok: false, step: "add_message", error: txt || `add message failed ${addMsg.status}` });
      }
    }

    // 2) Create a run
    const runResp = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        assistant_id: OPENAI_ASSISTANT_ID,
        instructions: userMessage || "",
      }),
    });
    if (!runResp.ok) {
      const txt = await runResp.text().catch(() => "");
      return res.status(502).json({ ok: false, step: "create_run", error: txt || `run create failed ${runResp.status}` });
    }
    const run = await runResp.json();

    // 3) Poll for completion
    let status = run.status;
    let guard = 0;
    while (!["completed", "failed", "cancelled", "expired"].includes(status)) {
      await sleep(700);
      guard++;
      const check = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${run.id}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2",
        },
      });
      if (!check.ok) {
        const txt = await check.text().catch(() => "");
        return res.status(502).json({ ok: false, step: "get_run", error: txt || `get run failed ${check.status}` });
      }
      const info = await check.json();
      status = info.status;
      if (guard > 180) break; // ~2 minutes safety
    }

    if (status !== "completed") {
      return res.status(502).json({ ok: false, step: "run_status", error: `Run not completed (${status})`, thread_id: threadId });
    }

    // 4) Fetch last assistant message text
    const text = await fetchLatestMessageText(threadId);

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      ok: true,
      thread_id: threadId,
      text,
      citations: [],
      usage: null,
    });

  } catch (err) {
    console.error("assistant API error:", err);
    return res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
}
