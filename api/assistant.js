// api/assistant.js
//
// Modes
//   POST /api/assistant?stream=off  -> JSON { ok, text, citations, usage, thread_id }
//   POST /api/assistant?stream=on   -> SSE (events forwarded from OpenAI)
//
/* Env:
   OPENAI_API_KEY          (required)
   OPENAI_ASSISTANT_ID     (required)
   CORS_ALLOW_ORIGIN       (comma-separated list, e.g. "https://www.talkingcare.uk,https://tc-assistant-proxy.vercel.app")
*/

const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const ASSISTANT_ID    = process.env.OPENAI_ASSISTANT_ID;
const CORS_LIST_RAW   = (process.env.CORS_ALLOW_ORIGIN || "https://www.talkingcare.uk,https://tc-assistant-proxy.vercel.app").trim();

if (!OPENAI_API_KEY || !ASSISTANT_ID) {
  console.error("Missing OPENAI_API_KEY and/or OPENAI_ASSISTANT_ID");
}

// --- CORS helpers ---
const CORS_SET = new Set(
  CORS_LIST_RAW
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);

function pickOrigin(req) {
  const o = req.headers.origin || "";
  return CORS_SET.has(o) ? o : Array.from(CORS_SET)[0] || "*";
}

function setCors(req, res) {
  const origin = pickOrigin(req);
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

// --- body reader (Squarespace/Firefox sometimes send text/plain) ---
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;

  return await new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", c => (data += c));
    req.on("end", () => {
      const t = (data || "").trim();
      if (!t) return resolve({});
      try {
        if (t.startsWith("{") || t.startsWith("[")) return resolve(JSON.parse(t));
        // Fallback: raw -> treat as userMessage
        return resolve({ userMessage: t });
      } catch {
        return resolve({});
      }
    });
    req.on("error", reject);
  });
}

// --- minimal OpenAI JSON caller ---
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

// Optional: sanitize annotations so UI never shows "file file-xxxx"
function stripFileIdsFromAnnotations(annotations) {
  const out = [];
  for (const a of annotations || []) {
    if (a.url) out.push({ type: "url", url: a.url });
    else if (a.file_path?.path) out.push({ type: "file_path", path: a.file_path.path });
  }
  return out;
}

// --- non-streaming path ---
async function nonStreamingFlow(userMessage, threadId) {
  let thread_id = threadId || (await oaJson("/threads", "POST", {})).id;

  // add user message (handle “active run” race)
  try {
    await oaJson(`/threads/${thread_id}/messages`, "POST", { role: "user", content: userMessage });
  } catch (e) {
    const msg = String(e.message || "");
    if (msg.includes("while a run") || msg.includes("active run")) {
      thread_id = (await oaJson("/threads", "POST", {})).id;
      await oaJson(`/threads/${thread_id}/messages`, "POST", { role: "user", content: userMessage });
    } else {
      throw e;
    }
  }

  // run
  const run = await oaJson(`/threads/${thread_id}/runs`, "POST", { assistant_id: ASSISTANT_ID });
  const run_id = run.id;

  // poll
  const start = Date.now();
  let status = run.status;
  while (!["completed", "failed", "cancelled", "expired"].includes(status)) {
    await new Promise(r => setTimeout(r, 600));
    const cur = await oaJson(`/threads/${thread_id}/runs/${run_id}`, "GET");
    status = cur.status;
    if (Date.now() - start > 120000) throw new Error("Run timed out");
  }
  if (status !== "completed") throw new Error(`Run did not complete (status=${status})`);

  // get latest assistant message
  const msgs = await oaJson(`/threads/${thread_id}/messages?limit=10`, "GET");
  const firstAssist = (msgs.data || []).find(m => m.role === "assistant");

  let text = "No text.";
  let citations = [];
  if (firstAssist?.content?.length) {
    const tc = firstAssist.content.find(c => c.type === "text");
    if (tc?.text?.value) {
      text = tc.text.value;
      citations = stripFileIdsFromAnnotations(tc.text.annotations);
    }
  }

  const usage = (await oaJson(`/threads/${thread_id}/runs/${run_id}`, "GET")).usage || null;

  return { text, citations, usage, thread_id };
}

// --- streaming path (SSE pipe-through) ---
async function streamingFlow(req, res, userMessage, threadId) {
  let closed = false;
  const safeWrite = (chunk) => {
    if (closed) return;
    try { res.write(chunk); } catch { /* ignore broken pipe */ }
  };

  // prepare SSE headers first
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": pickOrigin(req),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
  });

  // abort if client disconnects
  const controller = new AbortController();
  const onClose = () => {
    closed = true;
    try { controller.abort(); } catch {}
    try { res.end(); } catch {}
  };
  req.on("close", onClose);
  req.on("aborted", onClose);

  // create/retry thread + message
  let thread_id = threadId || (await oaJson("/threads", "POST", {})).id;
  try {
    await oaJson(`/threads/${thread_id}/messages`, "POST", { role: "user", content: userMessage });
  } catch (e) {
    const msg = String(e.message || "");
    if (msg.includes("while a run") || msg.includes("active run")) {
      thread_id = (await oaJson("/threads", "POST", {})).id;
      await oaJson(`/threads/${thread_id}/messages`, "POST", { role: "user", content: userMessage });
    } else {
      // early error to client
      safeWrite(`event: error\n`);
      safeWrite(`data: ${JSON.stringify({ ok:false, step:"add_message", error: msg })}\n\n`);
      safeWrite(`event: done\n`);
      safeWrite(`data: [DONE]\n\n`);
      return;
    }
  }

  // tell client thread id
  safeWrite(`event: start\n`);
  safeWrite(`data: ${JSON.stringify({ ok:true, thread_id })}\n\n`);

  // start run with stream:true, Accept SSE
  const upstream = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({ assistant_id: ASSISTANT_ID, stream: true }),
    signal: controller.signal,
  }).catch(err => ({ ok: false, error: err }));

  if (!upstream || !upstream.ok || !upstream.body) {
    const errTxt = upstream?.error ? String(upstream.error) : await upstream.text().catch(() => "");
    safeWrite(`event: error\n`);
    safeWrite(`data: ${JSON.stringify({ ok:false, step:"create_run_stream", error: errTxt || "upstream_failed" })}\n\n`);
    safeWrite(`event: done\n`);
    safeWrite(`data: [DONE]\n\n`);
    return;
  }

  // pipe bytes as-is; clients will parse OpenAI's event names:
  // e.g. "thread.message.delta", "response.completed", etc.
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8");
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // Important: write the raw chunk; it's already in SSE format
      safeWrite(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    // client closed or upstream aborted; just stop
  } finally {
    safeWrite(`event: done\n`);
    safeWrite(`data: [DONE]\n\n`);
    try { res.end(); } catch {}
    closed = true;
  }
}

// --- handler ---
export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return endPreflight(res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok:false, error: "Method Not Allowed" });
  }

  try {
    const body = await readBody(req);
    const userMessage = (body.userMessage || "").toString();
    const threadId = body.threadId || null;
    const streamFlag = (req.query.stream || "off").toString(); // "on" | "off"

    if (!userMessage) {
      return res.status(400).json({ ok:false, error: "Missing userMessage" });
    }

    if (streamFlag === "on") {
      return await streamingFlow(req, res, userMessage, threadId);
    } else {
      const result = await nonStreamingFlow(userMessage, threadId);
      return res.status(200).json({ ok:true, ...result });
    }
  } catch (err) {
    console.error("assistant handler error:", err);
    // if not already streaming, reply JSON
    try {
      return res.status(500).json({ ok:false, error: "Internal Server Error" });
    } catch { /* already streaming */ }
  }
}
