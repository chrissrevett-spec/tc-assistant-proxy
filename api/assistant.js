/**
 * Talking Care – Assistant proxy (Vercel Node function)
 * - Supports SSE streaming (default when no query ?stream=off)
 * - Supports JSON, non-stream fallback with ?stream=off
 * - Cleans/sanitizes OpenAI annotations so you never show raw file IDs
 *
 * Environment variables (Vercel Project-level):
 *   OPENAI_API_KEY          = sk-...
 *   OPENAI_ASSISTANT_ID     = asst_...
 *   CORS_ALLOW_ORIGIN       = https://www.talkingcare.uk          (comma-separated if multiple)
 */

const OPENAI_API_KEY       = process.env.OPENAI_API_KEY || "";
const OPENAI_ASSISTANT_ID  = process.env.OPENAI_ASSISTANT_ID || "";
const CORS_ALLOW_ORIGIN    = process.env.CORS_ALLOW_ORIGIN || "https://www.talkingcare.uk";

const ALLOWED_ORIGINS = new Set(
  CORS_ALLOW_ORIGIN.split(",")
    .map(s => s.trim())
    .filter(Boolean)
);

function pickOrigin(req) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  // default to first configured origin so CORS always returns *something* valid
  return [...ALLOWED_ORIGINS][0] || "https://www.talkingcare.uk";
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

/**
 * Helper: create a new thread (or reuse existing thread if provided).
 * Returns { thread_id }
 */
async function ensureThread(threadId) {
  if (threadId) return { thread_id: threadId };

  const r = await fetch("https://api.openai.com/v1/threads", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2"
    },
    body: JSON.stringify({})
  });

  if (!r.ok) {
    const err = await safeErr(r);
    throw new Error(`create_thread failed: ${r.status} ${err}`);
  }
  const json = await r.json();
  return { thread_id: json.id };
}

/**
 * Helper: add a user message into a thread
 */
async function addUserMessage(thread_id, userMessage) {
  const r = await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2"
    },
    body: JSON.stringify({
      role: "user",
      content: userMessage
    })
  });
  if (!r.ok) {
    const err = await safeErr(r);
    throw new Error(`add_message failed: ${r.status} ${err}`);
  }
}

/**
 * Helper: create a run
 * Returns { run_id }
 */
async function createRun(thread_id) {
  const r = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2"
    },
    body: JSON.stringify({
      assistant_id: OPENAI_ASSISTANT_ID
    })
  });
  if (!r.ok) {
    const err = await safeErr(r);
    throw new Error(`create_run failed: ${r.status} ${err}`);
  }
  const json = await r.json();
  return { run_id: json.id };
}

/**
 * Helper: wait for run to complete then read latest assistant message.
 */
async function waitRunAndFetchText(thread_id, run_id) {
  // poll until completed / requires_action / failed
  // (simple poll; you can upgrade to server->server webhooks later)
  for (;;) {
    const r = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs/${run_id}`, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2"
      }
    });
    if (!r.ok) {
      const err = await safeErr(r);
      throw new Error(`get_run failed: ${r.status} ${err}`);
    }
    const run = await r.json();
    if (run.status === "completed") break;
    if (run.status === "failed" || run.status === "expired" || run.status === "cancelled") {
      throw new Error(`run ended: ${run.status}`);
    }
    await sleep(800);
  }

  // fetch most recent assistant message
  const mr = await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages?limit=20&order=desc`, {
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "assistants=v2"
    }
  });
  if (!mr.ok) {
    const err = await safeErr(mr);
    throw new Error(`list_messages failed: ${mr.status} ${err}`);
  }
  const msgs = await mr.json();

  // find first assistant message with text content
  const assistantMsg = msgs.data.find(m => m.role === "assistant" && Array.isArray(m.content) && m.content.some(c => c.type === "text"));
  if (!assistantMsg) return { text: "", citations: [], usage: null };

  const textPart = assistantMsg.content.find(c => c.type === "text");
  const clean = cleanTextAndCites(textPart);
  return { text: clean.text, citations: clean.citations, usage: null };
}

/**
 * SSE relay: open OpenAI Run *Events* stream and forward to browser.
 * IMPORTANT: we use the REAL run_id returned by createRun().
 */
async function relayRunEvents(res, thread_id, run_id) {
  // 200 + SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });

  // tell the client which thread_id we’re using
  sendSSE(res, "start", { ok: true, thread_id });

  const url = `https://api.openai.com/v1/threads/${thread_id}/runs/${run_id}/events`;
  const r = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "assistants=v2",
      "Accept": "text/event-stream"
    }
  });

  if (!r.ok || !r.body) {
    const err = await safeErr(r);
    sendSSE(res, "error", { ok: false, step: "create_run_stream", error: `runs/stream failed: ${r.status} ${err}` });
    sendSSE(res, "done", "[DONE]");
    res.end();
    return;
  }

  // Relay the raw SSE lines, but we can pass them through as-is.
  // OpenAI events already use names like:
  //   thread.message.delta
  //   thread.message.completed
  //   thread.run.completed
  const reader = r.body.getReader();
  const decoder = new TextDecoder("utf-8");

  try {
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const blocks = buf.split("\n\n");
      buf = blocks.pop() || "";

      for (const block of blocks) {
        const lines = block.split("\n");
        let event = null;
        let data = "";

        for (const line of lines) {
          if (line.startsWith("event:")) {
            event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            data += line.slice(5).trim();
          }
        }

        // Forward as-is to the browser
        if (data === "[DONE]") {
          sendSSE(res, "done", "[DONE]");
        } else {
          // Pass through original OpenAI event names, so your frontend keeps working
          res.write(`event: ${event || "message"}\n`);
          res.write(`data: ${data}\n\n`);
        }
      }
    }
  } catch (e) {
    // Client disconnected or stream broken — just end politely
  }

  sendSSE(res, "done", "[DONE]");
  res.end();
}

function sendSSE(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function safeErr(r) {
  try {
    const t = await r.text();
    return t || `${r.status} ${r.statusText}`;
  } catch {
    return `${r.status} ${r.statusText}`;
  }
}

/**
 * Clean OpenAI text annotations:
 * - Strip raw file IDs (file_...) from being shown to users
 * - Return a small citations array you can render safely
 */
function cleanTextAndCites(textPart) {
  const citations = [];
  let text = textPart?.text?.value || "";

  const anns = textPart?.text?.annotations || [];
  for (const a of anns) {
    // Remove the exact range from text (OpenAI often includes citation markers)
    if (a?.start_index != null && a?.end_index != null) {
      const before = text.slice(0, a.start_index);
      const after  = text.slice(a.end_index);
      text = before + after;
    }

    // Build a user-safe citation object
    if (a?.url) {
      citations.push({ type: "url", url: a.url });
    } else if (a?.file_path?.file_id) {
      // If Assistant returned a *path* from your uploaded file, show its path label
      citations.push({
        type: "file_path",
        label: a.file_path.path || "uploaded document"
      });
    } else if (a?.file_citation?.file_id) {
      // Hide raw file_id; show a generic label
      citations.push({ type: "file", label: "uploaded document" });
    }
  }

  // dedupe + cap
  const key = c => (c.type === "url" ? `u:${c.url}` : `l:${c.label || c.type}`);
  const seen = new Set();
  const safeCites = [];
  for (const c of citations) {
    const k = key(c);
    if (seen.has(k)) continue;
    seen.add(k);
    safeCites.push(c);
    if (safeCites.length >= 5) break;
  }
  return { text: text.trim(), citations: safeCites };
}

export default async function handler(req, res) {
  const origin = pickOrigin(req);
  setCors(res, origin);

  // Preflight
  if (req.method === "OPTIONS") return endPreflight(res);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // Guard env
  if (!OPENAI_API_KEY || !OPENAI_ASSISTANT_ID) {
    return res.status(500).json({ ok: false, error: "Missing OPENAI_API_KEY or OPENAI_ASSISTANT_ID" });
  }

  // Parse payload
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const userMessage = String(body.userMessage || "").trim();
  const clientThread = body.threadId ? String(body.threadId) : null;

  // Decide mode: streaming vs non-streaming
  const url = new URL(req.url, "http://localhost");
  const streamParam = url.searchParams.get("stream");
  const doStream = streamParam !== "off"; // default = streaming when called without ?stream=off

  try {
    // 1) Ensure thread
    const { thread_id } = await ensureThread(clientThread);

    // 2) If the request included content, push it as a message
    if (userMessage) {
      await addUserMessage(thread_id, userMessage);
    }

    // 3a) Non-stream: create run, wait, fetch assistant text, sanitize
    if (!doStream) {
      const { run_id } = await createRun(thread_id);
      const { text, citations, usage } = await waitRunAndFetchText(thread_id, run_id);
      return res.status(200).json({
        ok: true,
        text: text || "I didn’t find anything to say there.",
        thread_id,
        citations,
        usage: usage || null
      });
    }

    // 3b) Streaming: create run, then open OpenAI events stream and relay
    const { run_id } = await createRun(thread_id);
    await relayRunEvents(res, thread_id, run_id);
    // NOTE: relayRunEvents handles response end on its own
  } catch (err) {
    console.error("assistant proxy error:", err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: "Assistant proxy error" });
    }
  }
}
