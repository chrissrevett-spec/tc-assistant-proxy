// /api/assistant.js
export const config = { runtime: "edge" };

// --- helpers ---
function corsHeaders(origin) {
  // Allow your Squarespace site
  const allow = origin && origin.includes("talkingcare.uk")
    ? origin
    : "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-vercel-protection-bypass, Accept",
    "Access-Control-Max-Age": "86400",
  };
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID   = process.env.ASSISTANT_ID; // asst_...
const BASE_URL       = "https://api.openai.com/v1";

async function api(path, options = {}) {
  const headers = {
    "Authorization": `Bearer ${OPENAI_API_KEY}`,
    "OpenAI-Beta": "assistants=v2",
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Response(JSON.stringify({ ok: false, step: options.step || "api", error: text ? JSON.parseSafe?.(text) || text : "request failed" }), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }
  return res;
}

// JSON.parse that won’t explode
JSON.parseSafe = (t) => { try { return JSON.parse(t); } catch { return null; } };

// Cancel any active run on a thread (queued/in_progress/requires_action)
async function cancelActiveRun(threadId) {
  try {
    const res = await api(`/threads/${threadId}/runs?limit=1&order=desc`, { method: "GET", step: "list_runs" });
    const data = await res.json();
    const run = data?.data?.[0];
    if (!run) return null;
    const active = ["queued", "in_progress", "requires_action"];
    if (active.includes(run.status)) {
      await api(`/threads/${threadId}/runs/${run.id}/cancel`, { method: "POST", body: "{}", step: "cancel_run" });
      return run.id;
    }
    return null;
  } catch {
    // swallow; if cancel fails we’ll fall back to new thread
    return null;
  }
}

// Wait for a run to finish (used only if you ever choose to poll instead of SSE)
async function waitForCompletion(threadId, runId, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await api(`/threads/${threadId}/runs/${runId}`, { method: "GET", step: "get_run" });
    const run = await res.json();
    const done = ["completed", "failed", "cancelled", "expired"];
    if (done.includes(run.status)) return run;
    await new Promise(r => setTimeout(r, 800));
  }
  throw new Error("timeout");
}

export default async function handler(req) {
  const origin = req.headers.get("origin") || "";
  const method = req.method || "GET";
  const url    = new URL(req.url);
  const streamOff = url.searchParams.get("stream") === "off";

  // CORS preflight
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders(origin) });
  }

  if (!OPENAI_API_KEY || !ASSISTANT_ID) {
    return new Response(JSON.stringify({ ok: false, error: "Server missing OPENAI_API_KEY or ASSISTANT_ID" }), {
      status: 500,
      headers: { ...corsHeaders(origin), "content-type": "application/json" }
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders(origin), "content-type": "application/json" }
    });
  }

  const userMessage = body?.userMessage || "";
  let   threadId    = body?.threadId || null;

  // If the incoming thread has an active run, try to cancel it; if that fails, reset to new thread
  if (threadId) {
    const cancelled = await cancelActiveRun(threadId);
    if (cancelled === null) {
      // if cancelActiveRun couldn’t verify/cancel (maybe API error), we’ll still try normal flow
      // but we’ll catch “already has an active run” below and reset thread as a final fallback.
    }
  }

  // Ensure we have a thread
  if (!threadId) {
    const t = await api(`/threads`, { method: "POST", body: "{}", step: "create_thread" }).then(r => r.json());
    threadId = t.id;
  }

  // Add message to thread (guard against “active run” race)
  async function safeAddMessage() {
    try {
      return await api(`/threads/${threadId}/messages`, {
        method: "POST",
        body: JSON.stringify({ role: "user", content: userMessage }),
        step: "add_message"
      }).then(r => r.json());
    } catch (resp) {
      const txt = await resp.text?.() || "";
      const err = JSON.parseSafe(txt);
      const msg = (err?.error?.message || err) + "";
      // If thread is busy, create a new thread and add message there
      if (msg.includes("already has an active run")) {
        const t = await api(`/threads`, { method: "POST", body: "{}", step: "create_thread_after_busy" }).then(r => r.json());
        threadId = t.id;
        return await api(`/threads/${threadId}/messages`, {
          method: "POST",
          body: JSON.stringify({ role: "user", content: userMessage }),
          step: "add_message_retry"
        }).then(r => r.json());
      }
      throw resp;
    }
  }
  await safeAddMessage();

  // Create run for this assistant
  async function safeCreateRun() {
    try {
      return await api(`/threads/${threadId}/runs`, {
        method: "POST",
        body: JSON.stringify({ assistant_id: ASSISTANT_ID }),
        step: "create_run"
      }).then(r => r.json());
    } catch (resp) {
      const txt = await resp.text?.() || "";
      const err = JSON.parseSafe(txt);
      const msg = (err?.error?.message || err) + "";
      // If still busy, reset to a brand new thread and retry once
      if (msg.includes("already has an active run")) {
        const t = await api(`/threads`, { method: "POST", body: "{}", step: "create_thread_after_busy2" }).then(r => r.json());
        threadId = t.id;
        await api(`/threads/${threadId}/messages`, {
          method: "POST",
          body: JSON.stringify({ role: "user", content: userMessage }),
          step: "add_message_retry2"
        });
        return await api(`/threads/${threadId}/runs`, {
          method: "POST",
          body: JSON.stringify({ assistant_id: ASSISTANT_ID }),
          step: "create_run_retry2"
        }).then(r => r.json());
      }
      throw resp;
    }
  }
  const run = await safeCreateRun();

  // Non-streaming JSON mode
  if (streamOff) {
    // Poll to completion
    const done = await waitForCompletion(threadId, run.id).catch(() => null);
    // Fetch the latest assistant message text
    const msgsRes = await api(`/threads/${threadId}/messages?limit=1&order=desc`, { method: "GET", step: "list_messages" });
    const msgs = await msgsRes.json();
    const last = msgs?.data?.[0];
    let text = "";
    let citations = [];
    if (last?.content?.length) {
      for (const c of last.content) {
        if (c.type === "text") {
          text += c.text?.value || "";
          (c.text?.annotations || []).forEach(a => {
            if (a?.file_citation?.file_id) citations.push({ type: "file", file_id: a.file_citation.file_id });
            if (a?.file_path?.file_id)    citations.push({ type: "file_path", file_id: a.file_path.file_id, path: a.file_path.path });
            if (a?.url)                   citations.push({ type: "url", url: a.url });
          });
        }
      }
    }
    return new Response(JSON.stringify({ ok: true, thread_id: threadId, text, citations, usage: done?.usage || null }), {
      status: 200,
      headers: { ...corsHeaders(origin), "content-type": "application/json" }
    });
  }

  // Streaming (SSE) mode
  const sseRes = await api(`/threads/${threadId}/runs/${run.id}/events`, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
    step: "stream_events"
  });

  const sseHeaders = {
    ...corsHeaders(origin),
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
    "connection": "keep-alive",
  };

  // Proxy the SSE stream straight through
  return new Response(sseRes.body, { status: 200, headers: sseHeaders });
}
