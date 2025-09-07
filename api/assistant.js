// Node runtime (Vercel "nodejs")
export const config = {
  runtime: "nodejs",
  maxDuration: 60,
  memory: 1024,
};

const OPENAI_URL = "https://api.openai.com/v1";
const ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// --- CORS helpers ---
const PROD_ORIGIN = "https://www.talkingcare.uk";
const EXTRA_ORIGIN = process.env.CORS_DEBUG_ORIGIN || "";
function corsOrigin(req) {
  const o = req.headers.get("origin");
  if (o === PROD_ORIGIN || (EXTRA_ORIGIN && o === EXTRA_ORIGIN)) return o;
  // default to prod origin; browser will still see ACAO matching prod
  return PROD_ORIGIN;
}
function baseCorsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-vercel-protection-bypass, Accept",
    "Access-Control-Max-Age": "86400"
  };
}
function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

// --- OpenAI helpers ---
async function oa(path, opts = {}) {
  const h = {
    "Authorization": `Bearer ${OPENAI_KEY}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "assistants=v2"
  };
  const res = await fetch(`${OPENAI_URL}${path}`, { ...opts, headers: { ...h, ...(opts.headers || {}) } });
  return res;
}

async function ensureThreadId(threadId) {
  if (threadId) return threadId;
  const r = await oa("/threads", { method: "POST", body: JSON.stringify({}) });
  if (!r.ok) throw new Error(`create_thread_failed: ${r.status} ${await r.text()}`);
  const t = await r.json();
  return t.id;
}

async function addUserMessage(threadId, text) {
  const r = await oa(`/threads/${threadId}/messages`, {
    method: "POST",
    body: JSON.stringify({ role: "user", content: text })
  });
  if (!r.ok) throw new Error(`add_message_failed: ${r.status} ${await r.text()}`);
}

async function createRun(threadId) {
  const r = await oa(`/threads/${threadId}/runs`, {
    method: "POST",
    body: JSON.stringify({ assistant_id: ASSISTANT_ID })
  });
  if (!r.ok) throw new Error(`create_run_failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function waitForRun(threadId, runId, timeoutMs = 45000) {
  const start = Date.now();
  while (true) {
    const r = await oa(`/threads/${threadId}/runs/${runId}`, { method: "GET" });
    if (!r.ok) throw new Error(`get_run_failed: ${r.status} ${await r.text()}`);
    const run = await r.json();
    if (run.status === "completed") return run;
    if (["failed", "cancelled", "expired"].includes(run.status)) {
      throw new Error(`run_${run.status}`);
    }
    if (Date.now() - start > timeoutMs) throw new Error("run_timeout");
    await new Promise(res => setTimeout(res, 800));
  }
}

async function getLatestAssistantText(threadId) {
  const r = await oa(`/threads/${threadId}/messages?limit=20`, { method: "GET" });
  if (!r.ok) throw new Error(`list_messages_failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  const msgs = data.data || [];
  const firstAssistant = msgs.find(m => m.role === "assistant");
  if (!firstAssistant) return "";
  // Concatenate text parts
  const parts = firstAssistant.content || [];
  return parts
    .filter(p => p.type === "text" && p.text && typeof p.text.value === "string")
    .map(p => p.text.value)
    .join("");
}

// Streams the OpenAI SSE directly to client, while relaying CORS
async function streamRun(threadId, userMessage, origin) {
  // Add message (separate call; we want explicit control)
  await addUserMessage(threadId, userMessage);

  // Create stream run
  const r = await oa(`/threads/${threadId}/runs`, {
    method: "POST",
    headers: { Accept: "text/event-stream" },
    body: JSON.stringify({ assistant_id: ASSISTANT_ID, stream: true })
  });

  if (!r.ok || !r.body) {
    const txt = await r.text().catch(() => "");
    return json({ ok: false, step: "create_run", error: tryParse(txt) || txt }, {
      status: r.status || 500,
      headers: baseCorsHeaders(origin)
    });
  }

  // Return an SSE passthrough response
  const headers = {
    ...baseCorsHeaders(origin),
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    // keep Vercel from buffering
    "X-Accel-Buffering": "no"
  };

  // We’ll wrap the upstream stream so we can inject an initial event and end marker
  const encoder = new TextEncoder();
  const prefix = `event: start\ndata: ${JSON.stringify({ ok: true, thread_id: threadId })}\n\n`;
  const trailer = `event: done\ndata: [DONE]\n\n`;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  // Write prefix immediately
  await writer.write(encoder.encode(prefix));

  // Pipe upstream SSE chunks
  const reader = r.body.getReader();
  async function pump() {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // pass through raw SSE from OpenAI
        await writer.write(value);
      }
    } catch (e) {
      // swallow; we'll finish the stream anyway
    } finally {
      // Trailer (finish)
      await writer.write(encoder.encode(trailer));
      await writer.close();
    }
  }
  pump();

  return new Response(readable, { status: 200, headers });
}

function tryParse(t) {
  try { return JSON.parse(t); } catch { return null; }
}

export default async function handler(req) {
  const origin = corsOrigin(req);
  const method = req.method || "GET";

  // Preflight
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: baseCorsHeaders(origin) });
  }

  if (!OPENAI_KEY) {
    return json({ ok: false, error: "Missing OPENAI_API_KEY" }, { status: 500, headers: baseCorsHeaders(origin) });
  }
  if (!ASSISTANT_ID) {
    return json({ ok: false, error: "Missing OPENAI_ASSISTANT_ID" }, { status: 500, headers: baseCorsHeaders(origin) });
  }

  if (method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, { status: 405, headers: baseCorsHeaders(origin) });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, { status: 400, headers: baseCorsHeaders(origin) });
  }

  const streamOff = (new URL(req.url)).searchParams.get("stream") === "off";
  const userMessage = String(body.userMessage || "").trim();
  let threadId = body.threadId || null;

  if (!userMessage) {
    return json({ ok: false, error: "userMessage is required" }, { status: 400, headers: baseCorsHeaders(origin) });
  }

  try {
    // Ensure a thread (or start fresh to avoid busy-run lock)
    threadId = await ensureThreadId(threadId);

    if (!streamOff) {
      // STREAMING path
      return await streamRun(threadId, userMessage, origin);
    }

    // NON-STREAM path
    await addUserMessage(threadId, userMessage);

    const run = await createRun(threadId);
    await waitForRun(threadId, run.id);

    const text = await getLatestAssistantText(threadId);
    return json({ ok: true, thread_id: threadId, text, citations: [], usage: null }, { headers: baseCorsHeaders(origin) });

  } catch (e) {
    const msg = e?.message || String(e);
    // Special case: “already has an active run”
    if (msg.includes("already has an active run")) {
      try {
        // start a brand new thread and retry once (non-stream, since we’re already in a catch)
        const freshThread = await ensureThreadId(null);
        await addUserMessage(freshThread, userMessage);
        const run = await createRun(freshThread);
        await waitForRun(freshThread, run.id);
        const text = await getLatestAssistantText(freshThread);
        return json({ ok: true, thread_id: freshThread, text, citations: [], usage: null, note: "recovered_on_new_thread" }, { headers: baseCorsHeaders(origin) });
      } catch (e2) {
        return json({ ok: false, error: String(e2) }, { status: 500, headers: baseCorsHeaders(origin) });
      }
    }
    return json({ ok: false, error: msg }, { status: 500, headers: baseCorsHeaders(origin) });
  }
}
