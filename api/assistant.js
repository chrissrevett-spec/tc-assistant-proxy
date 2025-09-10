// File: api/assistant.js
//
// One endpoint, two modes:
//   - Non-streaming  : POST /api/assistant?stream=off   -> JSON { ok, text, citations, usage, thread_id }
//   - Streaming (SSE): POST /api/assistant?stream=on    -> proxies OpenAI SSE straight to the browser
//
// Key points:
// - Creates the Run with {stream:true} and pipes OpenAI's SSE bytes through unchanged.
// - CORS is strict to your Squarespace origin.
// - Handles "active run" race by switching to a fresh thread transparently.
// - Avoids write-after-end with guards and abort wiring.
// - Hides raw file_ids (no more "📄 file-xxxx" in non-streaming).

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
  if (req.body && typeof req.body === "object") return req.body;

  return await new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      const t = (data || "").trim();
      if (!t) return resolve({});
      try {
        if (t.startsWith("{") || t.startsWith("[")) resolve(JSON.parse(t));
        else resolve({ userMessage: t });
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

async function oaJson(path, method, body, abortSignal) {
  const r = await fetch(`https://api.openai.com/v1${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: abortSignal,
  });
  if (!r.ok) {
    const errTxt = await r.text().catch(() => "");
    throw new Error(`${method} https://api.openai.com/v1${path} failed: ${r.status} ${errTxt}`);
  }
  return r.json();
}

function stripFileIdsFromAnnotations(annotations) {
  const out = [];
  for (const a of annotations || []) {
    if (a.url) out.push({ type: "url", url: a.url });
    else if (a.file_path?.file_id && a.file_path?.path) {
      out.push({ type: "file_path", path: a.file_path.path });
    }
    // drop raw file_citation.file_id to avoid "file file-xxxx"
  }
  return out;
}

async function nonStreamingFlow(userMessage, threadId) {
  let thread_id = threadId || (await oaJson("/threads", "POST", {})).id;

  try {
    await oaJson(`/threads/${thread_id}/messages`, "POST", {
      role: "user",
      content: userMessage,
    });
  } catch (e) {
    const msg = String(e.message || "");
    if (msg.includes("while a run") || msg.includes("active run")) {
      thread_id = (await oaJson("/threads", "POST", {})).id;
      await oaJson(`/threads/${thread_id}/messages`, "POST", {
        role: "user",
        content: userMessage,
      });
    } else {
      throw e;
    }
  }

  const run = await oaJson(`/threads/${thread_id}/runs`, "POST", {
    assistant_id: ASSISTANT_ID,
  });

  let status = run.status;
  let run_id = run.id;
  const started = Date.now();

  while (!["completed", "failed", "cancelled", "expired"].includes(status)) {
    await new Promise((r) => setTimeout(r, 600));
    const cur = await oaJson(`/threads/${thread_id}/runs/${run_id}`, "GET");
    status = cur.status;
    if (Date.now() - started > 120000) throw new Error("Run timed out");
  }

  if (status !== "completed") {
    throw new Error(`Run did not complete (status=${status})`);
  }

  // Get most recent assistant message
  const msgs = await oaJson(`/threads/${thread_id}/messages?limit=20`, "GET");
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

  usage = (await oaJson(`/threads/${thread_id}/runs/${run_id}`, "GET")).usage || null;

  return { text, citations, usage, thread_id };
}

async function streamingFlow(req, res, userMessage, threadId) {
  let closed = false;
  const safeWrite = (chunk) => {
    if (closed || res.writableEnded || res.destroyed) return;
    try { res.write(chunk); } catch {}
  };
  const safeEnd = () => {
    if (closed) return;
    closed = true;
    try { res.end(); } catch {}
  };

  // Abort wiring: if client disconnects, cancel upstream
  const upstreamAbort = new AbortController();
  req.on?.("close", () => { upstreamAbort.abort(); safeEnd(); });

  // Prepare thread and message
  let thread_id = threadId || (await oaJson("/threads", "POST", {}, upstreamAbort.signal)).id;

  try {
    await oaJson(`/threads/${thread_id}/messages`, "POST", {
      role: "user",
      content: userMessage,
    }, upstreamAbort.signal);
  } catch (e) {
    const msg = String(e.message || "");
    if (msg.includes("while a run") || msg.includes("active run")) {
      thread_id = (await oaJson("/threads", "POST", {}, upstreamAbort.signal)).id;
      await oaJson(`/threads/${thread_id}/messages`, "POST", {
        role: "user",
        content: userMessage,
      }, upstreamAbort.signal);
    } else {
      throw e;
    }
  }

  // Start SSE to browser
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": CORS_ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
  });

  const sendEvent = (event, data) => {
    safeWrite(`event: ${event}\n`);
    safeWrite(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
  };

  // Let the client know the thread id we settled on
  sendEvent("start", { ok: true, thread_id });

  // Create run with stream:true and pipe bytes through
  const upstream = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({ assistant_id: ASSISTANT_ID, stream: true }),
    signal: upstreamAbort.signal,
  });

  if (!upstream.ok || !upstream.body) {
    const errTxt = await upstream.text().catch(() => "");
    sendEvent("error", { ok: false, step: "create_run_stream", error: errTxt || upstream.status });
    return safeEnd();
  }

  const reader  = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8");

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // IMPORTANT: forward OpenAI SSE frames verbatim so the browser sees
      // event names like "thread.message.delta", "response.completed", etc.
      safeWrite(decoder.decode(value, { stream: true }));
    }
  } catch {
    // client aborted or upstream closed abruptly
  } finally {
    sendEvent("done", "[DONE]");
    safeEnd();
  }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return endPreflight(res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const q = await readBody(req);
    const userMessage = (q.userMessage || "").toString();
    const threadId    = q.threadId || null;
    const mode        = (req.query.stream || "off").toString(); // "on" | "off"

    if (!userMessage) {
      return res.status(400).json({ ok:false, error: "Missing userMessage" });
    }

    if (mode === "on") {
      return await streamingFlow(req, res, userMessage, threadId);
    } else {
      const { text, citations, usage, thread_id } = await nonStreamingFlow(userMessage, threadId);
      return res.status(200).json({ ok:true, text, citations, usage, thread_id });
    }
  } catch (err) {
    console.error("assistant handler error:", err);
    try {
      return res.status(500).json({ ok:false, error: "Internal Server Error" });
    } catch {
      // If we were already streaming, the client just sees the stream end.
    }
  }
}
