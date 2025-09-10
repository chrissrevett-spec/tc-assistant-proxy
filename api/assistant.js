// api/assistant.js
//
// Modes:
//   - Non-streaming  : POST /api/assistant?stream=off  -> JSON { ok, text, citations, usage, thread_id }
//   - Streaming (SSE): POST /api/assistant?stream=on   -> raw SSE passthrough from OpenAI
//
// Notes:
// - CORS allows Squarespace and your Vercel widget host.
// - Handles “active run” races by switching to a fresh thread.
// - SSE piping is robust: no double writes, closes on client abort, sends 'done'.

const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;
const ASSISTANT_ID        = process.env.OPENAI_ASSISTANT_ID;
const CORS_ALLOW_ORIGIN   = process.env.CORS_ALLOW_ORIGIN || "https://www.talkingcare.uk";
const CORS_EXTRA_ORIGINS  = (process.env.CORS_EXTRA_ORIGINS || "https://tc-assistant-proxy.vercel.app").split(",").map(s => s.trim()).filter(Boolean);

if (!OPENAI_API_KEY || !ASSISTANT_ID) {
  console.error("Missing OPENAI_API_KEY or OPENAI_ASSISTANT_ID");
}

// ---------- CORS ----------
function allowedOrigin(req) {
  const o = req.headers.origin || "";
  if (!o) return CORS_ALLOW_ORIGIN;
  if (o === CORS_ALLOW_ORIGIN) return o;
  if (CORS_EXTRA_ORIGINS.includes(o)) return o;
  return CORS_ALLOW_ORIGIN;
}
function setCors(req, res) {
  const origin = allowedOrigin(req);
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
}
function endPreflight(res) { res.status(204).end(); }

// ---------- helpers ----------
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const t = (data || "").trim();
      if (!t) return resolve({});
      try {
        if (t.startsWith("{") || t.startsWith("[")) return resolve(JSON.parse(t));
      } catch {}
      // treat as raw text payload
      resolve({ userMessage: t });
    });
    req.on("error", () => resolve({}));
  });
}

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
    const err = await r.text().catch(() => "");
    throw new Error(`${method} ${path} -> ${r.status} ${err}`);
  }
  return r.json();
}

function stripFileIdsFromAnnotations(annotations) {
  const out = [];
  for (const a of annotations || []) {
    if (a.url) out.push({ type: "url", url: a.url });
    else if (a.file_path?.path) out.push({ type: "file_path", path: a.file_path.path });
  }
  return out;
}

// ---------- non-streaming ----------
async function nonStreamingFlow(userMessage, existingThreadId) {
  let thread_id = existingThreadId || (await oaJson("/threads", "POST", {})).id;

  try {
    await oaJson(`/threads/${thread_id}/messages`, "POST", {
      role: "user",
      content: userMessage,
    });
  } catch (e) {
    const msg = String(e.message || "");
    if (msg.includes("active run")) {
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

  let run_id = run.id;
  let status = run.status;

  const start = Date.now();
  const deadlineMs = 90_000;
  let wait = 400;

  while (!["completed", "failed", "cancelled", "expired"].includes(status)) {
    await new Promise(r => setTimeout(r, wait));
    const cur = await oaJson(`/threads/${thread_id}/runs/${run_id}`, "GET");
    status = cur.status;
    wait = Math.min(1200, wait + 200);
    if (Date.now() - start > deadlineMs) throw new Error("Run timed out");
  }
  if (status !== "completed") throw new Error(`Run status=${status}`);

  const msgs = await oaJson(`/threads/${thread_id}/messages?limit=10`, "GET");
  const firstAssist = (msgs.data || []).find(m => m.role === "assistant");
  let text = "";
  let citations = [];
  if (firstAssist?.content?.length) {
    const tc = firstAssist.content.find(c => c.type === "text");
    if (tc?.text?.value) {
      text = tc.text.value;
      citations = stripFileIdsFromAnnotations(tc.text.annotations);
    }
  }
  const usageWrap = await oaJson(`/threads/${thread_id}/runs/${run_id}`, "GET");
  const usage = usageWrap?.usage || null;

  return { text, citations, usage, thread_id };
}

// ---------- streaming ----------
async function streamingFlow(req, res, userMessage, existingThreadId) {
  if (!userMessage || !userMessage.trim()) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Inform client we can’t proceed
    safeWrite(res, `event: error\n`);
    safeWrite(res, `data: ${JSON.stringify({ ok:false, error:"Missing userMessage" })}\n\n`);
    return endStream(res);
  }

  let thread_id = existingThreadId || (await oaJson("/threads", "POST", {})).id;

  try {
    await oaJson(`/threads/${thread_id}/messages`, "POST", {
      role: "user",
      content: userMessage,
    });
  } catch (e) {
    const msg = String(e.message || "");
    if (msg.includes("active run")) {
      thread_id = (await oaJson("/threads", "POST", {})).id;
      await oaJson(`/threads/${thread_id}/messages`, "POST", {
        role: "user",
        content: userMessage,
      });
    } else {
      throw e;
    }
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Emit start with thread id
  safeWrite(res, `event: start\n`);
  safeWrite(res, `data: ${JSON.stringify({ ok:true, thread_id })}\n\n`);

  const upstream = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({ assistant_id: ASSISTANT_ID, stream: true }),
  });

  if (!upstream.ok || !upstream.body) {
    const errTxt = await upstream.text().catch(() => "");
    safeWrite(res, `event: error\n`);
    safeWrite(res, `data: ${JSON.stringify({ ok:false, step:"create_run_stream", error: errTxt || upstream.status })}\n\n`);
    return endStream(res);
  }

  // Close our stream if the client disconnects
  const onClose = () => { try { upstream.body?.cancel(); } catch {} };
  req.on("close", onClose);
  req.on("aborted", onClose);

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8");
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      // Pipe OpenAI SSE bytes as-is so your client can parse all event types.
      safeWrite(res, chunk);
    }
  } catch {
    // ignore network aborts
  } finally {
    safeWrite(res, `event: done\n`);
    safeWrite(res, `data: [DONE]\n\n`);
    endStream(res);
  }
}

function safeWrite(res, data) {
  if (!res.writableEnded && !res.headersSent) {
    try { res.write(data); } catch {}
    return;
  }
  if (!res.writableEnded) {
    try { res.write(data); } catch {}
  }
}
function endStream(res) {
  if (!res.writableEnded) {
    try { res.end(); } catch {}
  }
}

// ---------- handler ----------
export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return endPreflight(res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok:false, error: "Method Not Allowed" });
  }

  try {
    const q = await readBody(req);
    // Defensive: block empty auto-fires
    const userMessage = (q.userMessage ?? "").toString();
    const threadId    = q.threadId || null;
    const mode        = (req.query.stream || "off").toString(); // "on" | "off"

    if (mode === "on") {
      return await streamingFlow(req, res, userMessage, threadId);
    }

    if (!userMessage.trim()) {
      return res.status(400).json({ ok:false, error: "Missing userMessage" });
    }

    const { text, citations, usage, thread_id } =
      await nonStreamingFlow(userMessage, threadId);

    return res.status(200).json({ ok:true, text, citations, usage, thread_id });

  } catch (err) {
    console.error("assistant handler error:", err);
    if (!res.headersSent) {
      return res.status(500).json({ ok:false, error: "Internal Server Error" });
    }
    // if streaming already started, let it drop
  }
}
