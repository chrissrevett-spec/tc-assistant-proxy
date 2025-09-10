// File: api/assistant.js

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID   = process.env.OPENAI_ASSISTANT_ID;
const CORS_ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN || "https://www.talkingcare.uk";

if (!OPENAI_API_KEY || !ASSISTANT_ID) {
  console.error("Missing env OPENAI_API_KEY and/or OPENAI_ASSISTANT_ID");
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
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const t = (data || "").trim();
      if (!t) return resolve({});
      try {
        if (t.startsWith("{") || t.startsWith("[")) return resolve(JSON.parse(t));
        return resolve({ userMessage: t });
      } catch {
        return resolve({});
      }
    });
    req.on("error", reject);
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
    const txt = await r.text().catch(() => "");
    throw new Error(`${method} https://api.openai.com/v1${path} failed: ${r.status} ${txt}`);
  }
  return r.json();
}

function stripFileIdsFromAnnotations(annotations) {
  const out = [];
  for (const a of annotations || []) {
    if (a.url) out.push({ type: "url", url: a.url });
    else if (a.file_path?.file_id && a.file_path?.path) out.push({ type: "file_path", path: a.file_path.path });
    // drop raw file_citation.file_id to avoid "file file-xxxx" in UI
  }
  return out;
}

function pickLatestAssistantMessage(msgs) {
  // OpenAI returns { data: [ newest first ] }
  for (const m of (msgs.data || [])) {
    if (m.role === "assistant") return m;
  }
  return null;
}

async function nonStreamingFlow(userMessage, threadId) {
  let thread_id = threadId || (await oaJson("/threads", "POST", {})).id;

  // add user message; if blocked by active run, start a new thread and retry once
  const addMsg = async (tid) =>
    oaJson(`/threads/${tid}/messages`, "POST", { role: "user", content: userMessage });

  try {
    await addMsg(thread_id);
  } catch (e) {
    const msg = String(e.message || "");
    if (msg.includes("while a run") || msg.includes("active run")) {
      thread_id = (await oaJson("/threads", "POST", {})).id;
      await addMsg(thread_id);
    } else {
      throw e;
    }
  }

  const run = await oaJson(`/threads/${thread_id}/runs`, "POST", {
    assistant_id: ASSISTANT_ID,
  });

  // poll until terminal
  const run_id = run.id;
  const started = Date.now();
  while (true) {
    const cur = await oaJson(`/threads/${thread_id}/runs/${run_id}`, "GET");
    const st = cur.status;
    if (st === "completed") break;
    if (["failed", "cancelled", "expired"].includes(st)) {
      throw new Error(`Run did not complete (status=${st})`);
    }
    if (Date.now() - started > 120000) throw new Error("Run timed out");
    await new Promise((r) => setTimeout(r, 600));
  }

  // fetch last assistant message
  const msgs = await oaJson(`/threads/${thread_id}/messages?limit=20&order=desc`, "GET");
  const last = pickLatestAssistantMessage(msgs);
  let text = "No text.";
  let citations = [];
  let usage = null;

  if (last?.content?.length) {
    // Concatenate all text parts (some tool outputs split content)
    const pieces = last.content.filter((c) => c.type === "text");
    text = pieces.map((p) => p.text?.value || "").join("\n\n").trim() || text;
    // Merge/clean annotations from all text parts
    for (const p of pieces) {
      citations.push(...stripFileIdsFromAnnotations(p.text?.annotations || []));
    }
  }

  // optional: usage info
  const finalRun = await oaJson(`/threads/${thread_id}/runs/${run_id}`, "GET");
  usage = finalRun.usage || null;

  return { text, citations, usage, thread_id };
}

async function streamingFlow(req, res, userMessage, threadId) {
  let thread_id = threadId || (await oaJson("/threads", "POST", {})).id;

  const addMsg = async (tid) =>
    oaJson(`/threads/${tid}/messages`, "POST", { role: "user", content: userMessage });

  try {
    await addMsg(thread_id);
  } catch (e) {
    const msg = String(e.message || "");
    if (msg.includes("while a run") || msg.includes("active run")) {
      thread_id = (await oaJson("/threads", "POST", {})).id;
      await addMsg(thread_id);
    } else {
      throw e;
    }
  }

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": CORS_ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
  });

  let closed = false;
  const safeWrite = (chunk) => {
    if (closed) return;
    try { res.write(chunk); } catch { /* ignore */ }
  };
  const safeEnd = () => {
    if (closed) return;
    closed = true;
    try { res.end(); } catch {}
  };

  // client disconnect handling
  req.on("close", () => {
    closed = true;
    try { controller.abort(); } catch {}
  });

  // tell client the thread id
  safeWrite(`event: start\n`);
  safeWrite(`data: ${JSON.stringify({ ok: true, thread_id })}\n\n`);

  // open OpenAI stream
  const controller = new AbortController();

  const upstream = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({
      assistant_id: ASSISTANT_ID,
      stream: true,
      // optional: you could add instructions/tool_choice here if you need
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const errTxt = await upstream.text().catch(() => "");
    safeWrite(`event: error\n`);
    safeWrite(`data: ${JSON.stringify({ ok: false, step: "create_run_stream", error: errTxt || upstream.status })}\n\n`);
    return safeEnd();
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8");

  try {
    while (!closed) {
      const { value, done } = await reader.read();
      if (done) break;
      // OpenAI already frames as SSE ("data: {...}\n\n" etc.) — pass through unchanged
      safeWrite(decoder.decode(value, { stream: true }));
    }
  } catch {
    // network/client aborts -> silently end
  } finally {
    safeWrite(`event: done\n`);
    safeWrite(`data: [DONE]\n\n`);
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
    const body = await readBody(req);
    const userMessage = (body.userMessage || "").toString();
    const threadId = body.threadId || null;
    const mode = (req.query.stream || "off").toString(); // "on" | "off"

    if (!userMessage) return res.status(400).json({ ok: false, error: "Missing userMessage" });

    if (mode === "on") {
      return await streamingFlow(req, res, userMessage, threadId);
    } else {
      const result = await nonStreamingFlow(userMessage, threadId);
      return res.status(200).json({ ok: true, ...result });
    }
  } catch (err) {
    console.error("assistant handler error:", err);
    try {
      return res.status(500).json({ ok: false, error: "Internal Server Error" });
    } catch {
      // if we were already streaming, the client just sees the stream end
    }
  }
}
