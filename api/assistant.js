// api/assistant.js
//
// One endpoint that supports both modes:
//   - Non-streaming  : POST /api/assistant?stream=off   -> JSON { text, citations, usage, thread_id }
//   - Streaming (SSE): POST /api/assistant?stream=on    -> proxies OpenAI SSE as-is
//
// Notes:
// - Fixes earlier issues by creating the Run with stream:true and piping the SSE directly.
// - Adds robust CORS for Squarespace (Firefox sometimes posts with text/plain).
// - Handles "active run" race by retrying with a fresh thread if needed.
// - Hides raw file_ids in non-streaming response (we omit them; you can keep URLs only).

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID   = process.env.OPENAI_ASSISTANT_ID; // required
const CORS_ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN || "https://www.talkingcare.uk";

if (!OPENAI_API_KEY || !ASSISTANT_ID) {
  console.error("Missing required env: OPENAI_API_KEY and/or OPENAI_ASSISTANT_ID");
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function endPreflight(res) {
  res.statusCode = 204;
  res.end();
}

async function readBody(req) {
  // Squarespace/Firefox sometimes send text/plain; handle both JSON and text
  if (typeof req.body === "object" && req.body !== null) return req.body;

  return await new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      const t = (data || "").trim();
      if (!t) return resolve({});
      try {
        // If it looks like JSON, parse; otherwise treat as raw text
        if (t.startsWith("{") || t.startsWith("[")) resolve(JSON.parse(t));
        else resolve({ userMessage: t });
      } catch (e) {
        resolve({}); // don’t crash on parse errors
      }
    });
    req.on("error", reject);
  });
}

// Minimal helper to call OpenAI JSON endpoints
async function oaJson(path, method, body) {
  const r = await fetch(`https://api.openai.com/v1${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const errTxt = await r.text().catch(() => "");
    throw new Error(`${method} https://api.openai.com/v1${path} failed: ${r.status} ${errTxt}`);
  }
  return r.json();
}

function stripFileIdsFromAnnotations(annotations) {
  // You can customize how citations are shown. Here we only pass URL/file_path paths out.
  const out = [];
  for (const a of annotations || []) {
    if (a.url) out.push({ type: "url", url: a.url });
    else if (a.file_path?.file_id && a.file_path?.path) {
      out.push({ type: "file_path", path: a.file_path.path });
    }
    // We intentionally drop raw { file_citation: { file_id } } to avoid “file file-xxxx” in UI
  }
  return out;
}

async function nonStreamingFlow(userMessage, threadId) {
  // Make or reuse a thread
  let thread_id = threadId || (await oaJson("/threads", "POST", {})).id;

  // Try to add message; if an active run blocks us, create a fresh thread
  try {
    await oaJson(`/threads/${thread_id}/messages`, "POST", {
      role: "user",
      content: userMessage,
    });
  } catch (e) {
    if (String(e.message).includes("while a run") || String(e.message).includes("active run")) {
      thread_id = (await oaJson("/threads", "POST", {})).id;
      await oaJson(`/threads/${thread_id}/messages`, "POST", {
        role: "user",
        content: userMessage,
      });
    } else {
      throw e;
    }
  }

  // Create run (non-stream)
  const run = await oaJson(`/threads/${thread_id}/runs`, "POST", {
    assistant_id: ASSISTANT_ID,
  });

  // Poll until completed/failed
  let status = run.status;
  let run_id = run.id;
  const started = Date.now();
  while (!["completed", "failed", "cancelled", "expired"].includes(status)) {
    await new Promise((r) => setTimeout(r, 600));
    const cur = await oaJson(`/threads/${thread_id}/runs/${run_id}`, "GET");
    status = cur.status;
    if (Date.now() - started > 120000) {
      throw new Error("Run timed out");
    }
  }

  if (status !== "completed") {
    throw new Error(`Run did not complete (status=${status})`);
  }

  // Fetch latest assistant message
  const msgs = await oaJson(`/threads/${thread_id}/messages?limit=10`, "GET");
  // Find the newest assistant message
  const firstAssist = (msgs.data || []).find((m) => m.role === "assistant");
  let text = "No text.";
  let citations = [];
  let usage = null;

  if (firstAssist?.content?.length) {
    const tc = firstAssist.content.find((c) => c.type === "text");
    if (tc?.text?.value) {
      text = tc.text.value;
      citations = stripFileIdsFromAnnotations(tc.text.annotations);
    }
  }

  // Runs usage is still per-run; fetch it to expose token usage if you want
  usage = (await oaJson(`/threads/${thread_id}/runs/${run_id}`, "GET")).usage || null;

  return { text, citations, usage, thread_id };
}

async function streamingFlow(req, res, userMessage, threadId) {
  // Create or reuse thread (safe against “active run” block because we’ll create the run immediately)
  let thread_id = threadId || (await oaJson("/threads", "POST", {})).id;

  // Add the user message (if this 400s due to an active run, fall back to a fresh thread)
  try {
    await oaJson(`/threads/${thread_id}/messages`, "POST", {
      role: "user",
      content: userMessage,
    });
  } catch (e) {
    if (String(e.message).includes("while a run") || String(e.message).includes("active run")) {
      thread_id = (await oaJson("/threads", "POST", {})).id;
      await oaJson(`/threads/${thread_id}/messages`, "POST", {
        role: "user",
        content: userMessage,
      });
    } else {
      throw e;
    }
  }

  // Tell the browser we’re streaming SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": CORS_ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
  });

  // Small helper to forward an SSE block to the client
  const forward = (raw) => {
    try { res.write(raw); } catch { /* ignore broken pipe */ }
  };

  // Emit a start event to give the client the new thread id
  try {
    res.write(`event: start\n`);
    res.write(`data: ${JSON.stringify({ ok: true, thread_id })}\n\n`);
  } catch {}

  // Create the run with stream:true and pipe OpenAI’s SSE to the browser.
  const url = `https://api.openai.com/v1/threads/${thread_id}/runs`;
  const upstream = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({
      assistant_id: ASSISTANT_ID,
      stream: true,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const errTxt = await upstream.text().catch(() => "");
    forward(`event: error\n`);
    forward(`data: ${JSON.stringify({ ok:false, step:"create_run_stream", error: errTxt || upstream.status })}\n\n`);
    try { res.end(); } catch {}
    return;
  }

  // Pipe bytes through without parsing (so event names like "thread.message.delta" stay intact)
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8");

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      forward(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    // Client aborted or network hiccup
  } finally {
    try {
      forward(`event: done\n`);
      forward(`data: [DONE]\n\n`);
      res.end();
    } catch {}
  }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return endPreflight(res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok:false, error: "Method Not Allowed" });
  }

  try {
    const q = await readBody(req);
    const userMessage = (q.userMessage || "").toString();
    const threadId = q.threadId || null;
    const mode = (req.query.stream || "off").toString(); // "on" or "off"

    if (!userMessage) {
      return res.status(400).json({ ok:false, error: "Missing userMessage" });
    }

    if (mode === "on") {
      return await streamingFlow(req, res, userMessage, threadId);
    } else {
      const { text, citations, usage, thread_id } =
        await nonStreamingFlow(userMessage, threadId);
      return res.status(200).json({ ok:true, text, citations, usage, thread_id });
    }
  } catch (err) {
    console.error("assistant handler error:", err);
    // Return JSON error for both modes if we haven’t started SSE yet
    try {
      res.status(500).json({ ok:false, error: "Internal Server Error" });
    } catch {
      // If we were already streaming, the client will just see the stream end.
    }
  }
}
