// api/assistant.js
// Full, drop-in file for Vercel (Node runtime, NOT Edge)

const DEFAULT_ALLOWED = [
  "https://www.talkingcare.uk",
  "https://talkingcare.uk",
  "http://localhost:3000"
];

function getAllowedOrigin(req) {
  const reqOrigin = req.headers.origin || "";
  const fromEnv = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const allow = fromEnv.length ? fromEnv : DEFAULT_ALLOWED;
  return allow.includes(reqOrigin) ? reqOrigin : allow[0] || "*";
}

function setCors(req, res) {
  const origin = getAllowedOrigin(req);
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-vercel-protection-bypass, Accept"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function bad(res, code, payload) {
  res.status(code).json({ ok: false, ...payload });
}

async function readJson(req) {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString("utf8") || "{}";
    return JSON.parse(body);
  } catch {
    return {};
  }
}

async function ensureNoActiveRun(openaiKey, threadId) {
  // Best-effort: if an active run exists, return null to force a new thread
  if (!threadId) return null;
  try {
    const r = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "OpenAI-Beta": "assistants=v2"
      }
    });
    if (!r.ok) return null;
    const data = await r.json();
    const active = (data?.data || []).some(x =>
      ["queued","in_progress","requires_action","cancelling"].includes(x.status)
    );
    return active ? null : threadId;
  } catch {
    return null;
  }
}

async function addMessage(openaiKey, threadId, content) {
  const r = await fetch(
    `https://api.openai.com/v1/threads/${threadId}/messages`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "OpenAI-Beta": "assistants=v2",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        role: "user",
        content
      })
    }
  );
  if (!r.ok) {
    const t = await r.text().catch(()=>"");
    throw new Error(`add_message_failed:${t}`);
  }
}

async function createThread(openaiKey) {
  const r = await fetch("https://api.openai.com/v1/threads", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "OpenAI-Beta": "assistants=v2",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });
  if (!r.ok) {
    const t = await r.text().catch(()=>"");
    throw new Error(`create_thread_failed:${t}`);
  }
  const j = await r.json();
  return j?.id;
}

async function createRun(openaiKey, threadId, assistantId, extra = {}) {
  const r = await fetch(
    `https://api.openai.com/v1/threads/${threadId}/runs`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "OpenAI-Beta": "assistants=v2",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ assistant_id: assistantId, ...extra })
    }
  );
  if (!r.ok) {
    const t = await r.text().catch(()=>"");
    throw new Error(`create_run_failed:${t}`);
  }
  return r;
}

async function waitForRunDone(openaiKey, threadId, runId, maxMs = 60000) {
  const start = Date.now();
  while (true) {
    const r = await fetch(
      `https://api.openai.com/v1/threads/${threadId}/runs/${runId}`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${openaiKey}`,
          "OpenAI-Beta": "assistants=v2"
        }
      }
    );
    if (!r.ok) {
      const t = await r.text().catch(()=>"");
      throw new Error(`get_run_failed:${t}`);
    }
    const run = await r.json();
    if (["completed","failed","cancelled","expired"].includes(run.status)) {
      return run;
    }
    if (Date.now() - start > maxMs) {
      throw new Error("run_timeout");
    }
    await new Promise(x => setTimeout(x, 800));
  }
}

async function fetchLatestAssistantMessage(openaiKey, threadId) {
  const r = await fetch(
    `https://api.openai.com/v1/threads/${threadId}/messages?order=desc&limit=10`,
    {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "OpenAI-Beta": "assistants=v2"
      }
    }
  );
  if (!r.ok) {
    const t = await r.text().catch(()=>"");
    throw new Error(`list_messages_failed:${t}`);
  }
  const j = await r.json();
  const msg = (j?.data || []).find(m => m.role === "assistant");
  if (!msg) return { text: "", citations: [] };

  let text = "";
  let citations = [];
  for (const part of msg.content || []) {
    if (part.type === "text") {
      text += part.text?.value || "";
      // Collect any references if present
      for (const a of (part.text?.annotations || [])) {
        if (a?.file_citation?.file_id) {
          citations.push({ type: "file", file_id: a.file_citation.file_id });
        } else if (a?.file_path?.file_id) {
          citations.push({ type: "file_path", file_id: a.file_path.file_id, path: a.file_path.path || null });
        } else if (a?.url) {
          citations.push({ type: "url", url: a.url });
        }
      }
    }
  }
  return { text, citations };
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`);
  if (data !== undefined) {
    if (typeof data === "string") {
      res.write(`data: ${data}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  } else {
    res.write("\n");
  }
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    return bad(res, 405, { error: "Method not allowed" });
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
  const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || "";

  if (!OPENAI_API_KEY) return bad(res, 500, { error: "Missing OPENAI_API_KEY" });
  if (!OPENAI_ASSISTANT_ID) return bad(res, 500, { error: "Missing OPENAI_ASSISTANT_ID" });

  const url = new URL(req.url, "http://local");
  const streamOff = url.searchParams.get("stream") === "off";

  const body = await readJson(req);
  let { userMessage, threadId } = body || {};
  if (typeof userMessage !== "string" || !userMessage.trim()) {
    return bad(res, 400, { error: "userMessage is required" });
  }

  // Avoid “active run” lock: if current thread has an active run, drop it and start a new one
  threadId = await ensureNoActiveRun(OPENAI_API_KEY, threadId);
  if (!threadId) {
    threadId = await createThread(OPENAI_API_KEY);
  }

  // Add the user message
  await addMessage(OPENAI_API_KEY, threadId, userMessage);

  // Non-streaming path
  if (streamOff) {
    // Create a run and poll until done
    const runResp = await createRun(OPENAI_API_KEY, threadId, OPENAI_ASSISTANT_ID);
    const run = await runResp.json();
    const final = await waitForRunDone(OPENAI_API_KEY, threadId, run.id);
    const usage = final?.usage || null;
    const { text, citations } = await fetchLatestAssistantMessage(OPENAI_API_KEY, threadId);

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    setCors(req, res);
    res.status(200).end(JSON.stringify({
      ok: true,
      thread_id: threadId,
      text,
      citations,
      usage
    }));
    return;
  }

  // Streaming path (SSE relay)
  // We create a run with streaming enabled, and pipe OpenAI SSE events to the client
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  setCors(req, res);

  // Send a quick start event so the browser knows the stream is alive
  sseWrite(res, "start", { ok: true });

  let upstream;
  try {
    upstream = await createRun(OPENAI_API_KEY, threadId, OPENAI_ASSISTANT_ID, { stream: true });
  } catch (e) {
    // If OpenAI rejected due to missing beta header etc., surface clearly
    sseWrite(res, "error", { message: String(e?.message || e) });
    sseWrite(res, "done", "[DONE]");
    res.end();
    return;
  }

  if (!upstream.body) {
    sseWrite(res, "error", { message: "No upstream body" });
    sseWrite(res, "done", "[DONE]");
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  // Keep-alive ping every 20s (helps behind CDNs)
  const heart = setInterval(() => {
    try { res.write(": ping\n\n"); } catch {}
  }, 20000);

  try {
    // Relay OpenAI SSE → Client
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";

      for (const chunk of chunks) {
        const lines = chunk.split("\n");
        let event = null;
        let data = "";

        for (const line of lines) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }

        // Forward OpenAI’s event names roughly 1:1 so your frontend parser keeps working
        if (data === "[DONE]") {
          sseWrite(res, "done", "[DONE]");
          clearInterval(heart);
          res.end();
          return;
        }

        // Forward as-is, but also map the common text deltas for your UI
        try {
          const obj = JSON.parse(data);
          // If it’s a content delta, re-emit as the legacy-ish "thread.message.delta"
          if (event === "response.output_text.delta" && obj?.delta?.type === "output_text_delta") {
            sseWrite(res, "thread.message.delta", {
              delta: { content: [{ type: "output_text_delta", text: obj.delta.text || "" }] },
              thread_id: threadId
            });
            continue;
          }
          // Pass through other events too (message completed, run completed, usage, etc.)
          sseWrite(res, event || "event", obj);
        } catch {
          // Non-JSON line; forward raw
          sseWrite(res, event || "event", data);
        }
      }
    }
  } catch (e) {
    sseWrite(res, "error", { message: String(e?.message || e) });
  } finally {
    clearInterval(heart);
    sseWrite(res, "done", "[DONE]");
    try { res.end(); } catch {}
  }
};
