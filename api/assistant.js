/**
 * Talking Care Navigator — single endpoint
 * - Streaming (default)
 * - Non-stream (?stream=off)
 *
 * Requires env vars on Vercel:
 *   OPENAI_API_KEY
 *   OPENAI_ASSISTANT_ID   (your Assistant ID)
 */

const { corsHeaders, send, ok, noContent, bad, fail } = require("./_cors");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ASSISTANT_ID   = process.env.OPENAI_ASSISTANT_ID || "";

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

async function createThread() {
  const r = await fetch("https://api.openai.com/v1/threads", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({}),
  });
  if (!r.ok) throw new Error(`createThread: ${r.status} ${await r.text()}`);
  return (await r.json()).id;
}

async function addMessage(threadId, text) {
  const r = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({
      role: "user",
      content: text,
    }),
  });
  if (!r.ok) throw new Error(`addMessage: ${r.status} ${await r.text()}`);
}

async function createRun(threadId) {
  const r = await fetch("https://api.openai.com/v1/threads/runs", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({
      assistant_id: ASSISTANT_ID,
      thread_id: threadId,
    }),
  });
  if (!r.ok) throw new Error(`createRun: ${r.status} ${await r.text()}`);
  return await r.json();
}

async function getLatestMessage(threadId) {
  const r = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages?limit=1&order=desc`, {
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "assistants=v2",
    },
  });
  if (!r.ok) throw new Error(`getMessages: ${r.status} ${await r.text()}`);
  const j = await r.json();
  const msg = (j.data && j.data[0]) || null;
  if (!msg) return { text: "" };
  // Extract plain text
  let text = "";
  for (const p of msg.content || []) {
    if (p.type === "text" && p.text?.value) text += p.text.value;
  }
  return { text, raw: msg };
}

async function pollRunUntilDone(threadId, runId, timeoutMs = 120000) {
  const start = Date.now();
  while (true) {
    const r = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2",
      },
    });
    if (!r.ok) throw new Error(`getRun: ${r.status} ${await r.text()}`);
    const run = await r.json();
    if (run.status === "completed") return run;
    if (run.status === "failed" || run.status === "cancelled" || run.status === "expired") {
      throw new Error(`run status: ${run.status} ${run.last_error ? JSON.stringify(run.last_error) : ""}`);
    }
    if (Date.now() - start > timeoutMs) throw new Error("run timeout");
    await new Promise(res => setTimeout(res, 800));
  }
}

function writeSSEHead(res) {
  // CORS + SSE headers
  const headers = corsHeaders({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
  });
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.statusCode = 200;
  res.flushHeaders?.();
}
function sseSend(res, evt, data) {
  res.write(`event: ${evt}\n`);
  if (typeof data === "string") res.write(`data: ${data}\n\n`);
  else res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function sseDone(res) { res.write("data: [DONE]\n\n"); res.end(); }

module.exports = async (req, res) => {
  // Always handle OPTIONS quickly to avoid 500 on preflight
  if (req.method === "OPTIONS") return noContent(res);
  if (req.method !== "POST")    return send(res, 405, "Method Not Allowed");

  // Basic env checks (still return CORS on error)
  if (!OPENAI_API_KEY) return fail(res, "Missing OPENAI_API_KEY");
  if (!ASSISTANT_ID)   return fail(res, "Missing OPENAI_ASSISTANT_ID");

  // Decide stream vs non-stream
  const url = new URL(req.url, `http://${req.headers.host}`);
  const noStream = url.searchParams.get("stream") === "off";

  let body;
  try {
    body = await readBody(req);
  } catch {
    return bad(res, "Invalid JSON body");
  }
  const userMessage = (body && body.userMessage ? String(body.userMessage) : "").trim();
  if (!userMessage) return bad(res, "userMessage is required");

  let threadId = body && body.threadId ? String(body.threadId) : null;

  // If the last run is still active, the API will reject. We don’t try to add messages during an active run.
  // Client-side you already reset the thread on “active run” errors; here we’ll just bubble up the message.

  // NON-STREAM (JSON) — run and poll then return one JSON object
  if (noStream) {
    try {
      if (!threadId) threadId = await createThread();
      await addMessage(threadId, userMessage);
      const run = await createRun(threadId);
      await pollRunUntilDone(threadId, run.id);
      const latest = await getLatestMessage(threadId);
      return ok(res, {
        ok: true,
        thread_id: threadId,
        text: latest.text || "",
        citations: [],
        usage: null,
      });
    } catch (e) {
      return fail(res, String(e && e.message ? e.message : e));
    }
  }

  // STREAM — create/run then proxy SSE from the Run stream endpoint
  try {
    if (!threadId) threadId = await createThread();
    await addMessage(threadId, userMessage);

    // We’ll stream by polling messages (simple & robust) to avoid function crashes on stream pipe;
    // still emits SSE so your widget renders tokens progressively.
    writeSSEHead(res);
    sseSend(res, "start", { ok: true, thread_id: threadId });

    // Kick off the run
    const run = await createRun(threadId);

    // Poll while emitting partial deltas by re-reading the latest message
    let lastText = "";
    let done = false;
    const start = Date.now();

    while (!done) {
      // Check run status
      const rs = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${run.id}`, {
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2",
        },
      });
      if (!rs.ok) throw new Error(`getRun(stream): ${rs.status} ${await rs.text()}`);
      const runState = await rs.json();
      done = runState.status === "completed";

      // Fetch latest message text and emit the delta
      const { text } = await getLatestMessage(threadId);
      if (text && text !== lastText) {
        const delta = text.slice(lastText.length);
        if (delta) sseSend(res, "thread.message.delta", { delta: { content: [{ type: "output_text_delta", text: delta }] } });
        lastText = text;
      }

      if (done) break;
      if (Date.now() - start > 120000) throw new Error("stream timeout");
      await new Promise(r => setTimeout(r, 700));
    }

    // Completed — send final message + done
    sseSend(res, "thread.message.completed", {
      role: "assistant",
      content: [{ type: "text", text: { value: lastText, annotations: [] } }],
      thread_id: threadId,
    });
    sseSend(res, "thread.run.completed", { usage: null, thread_id: threadId });
    sseDone(res);
  } catch (e) {
    // Ensure we still respond with CORS headers on errors
    try {
      // If headers were already sent for SSE, send an error event
      if (res.headersSent) {
        sseSend(res, "error", { message: String(e && e.message ? e.message : e) });
        return sseDone(res);
      }
    } catch {}
    return fail(res, String(e && e.message ? e.message : e));
  }
};
