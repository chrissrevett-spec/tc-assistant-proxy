import { commonCorsHeaders, errJson, handleOptions } from "./_cors.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || "";
const OPENAI_BASE = process.env.OPENAI_BASE || "https://api.openai.com";

async function openai(path, init = {}) {
  const headers = {
    "Authorization": `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    ...(init.headers || {})
  };
  return fetch(`${OPENAI_BASE}${path}`, { ...init, headers });
}

function sseHeaders() {
  return {
    ...commonCorsHeaders(),
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  };
}

function jsonHeaders() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    ...commonCorsHeaders()
  };
}

export async function OPTIONS() { return handleOptions(); }

export async function POST(req) {
  // Validate env first — return 400 JSON so the UI can show a useful error.
  if (!OPENAI_API_KEY) {
    return errJson(400, { ok: false, error: "Missing OPENAI_API_KEY" });
  }
  if (!OPENAI_ASSISTANT_ID) {
    return errJson(400, { ok: false, error: "Missing OPENAI_ASSISTANT_ID" });
  }

  let body = {};
  try { body = await req.json(); } catch {}
  const userMessage = (body && body.userMessage) ? String(body.userMessage) : "";
  let threadId = body && body.threadId ? String(body.threadId) : null;

  if (!userMessage) {
    return errJson(400, { ok: false, error: "Missing userMessage" });
  }

  const url = new URL(req.url);
  const noStream = url.searchParams.get("stream") === "off";

  // Ensure a thread exists
  if (!threadId) {
    const r = await openai("/v1/threads", { method: "POST" });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return errJson(502, { ok: false, step: "create_thread", error: safeErr(t) });
    }
    const j = await r.json();
    threadId = j.id;
  }

  // Add user message
  {
    const r = await openai(`/v1/threads/${threadId}/messages`, {
      method: "POST",
      body: JSON.stringify({ role: "user", content: userMessage })
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      // Busy thread case is common; surface clearly
      return errJson(409, { ok: false, step: "add_message", error: safeErr(t), thread_id: threadId });
    }
  }

  if (noStream) {
    // ---------- Non-streaming path ----------
    // Create run
    let runId;
    {
      const r = await openai(`/v1/threads/${threadId}/runs`, {
        method: "POST",
        body: JSON.stringify({ assistant_id: OPENAI_ASSISTANT_ID })
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return errJson(502, { ok: false, step: "create_run", error: safeErr(t), thread_id: threadId });
      }
      const j = await r.json();
      runId = j.id;
    }

    // Poll for completion (simple polling; short backoff)
    let done = false, usage = null;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const r = await openai(`/v1/threads/${threadId}/runs/${runId}`, { method: "GET" });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.status === "completed") {
        usage = j.usage || null;
        done = true;
        break;
      }
      if (["failed", "cancelled", "expired"].includes(j.status)) {
        return errJson(502, { ok: false, step: "run_status", status: j.status, thread_id: threadId });
      }
    }
    if (!done) {
      return errJson(504, { ok: false, step: "timeout", error: "Run did not complete in time", thread_id: threadId });
    }

    // Fetch latest assistant message
    const r = await openai(`/v1/threads/${threadId}/messages?limit=1&order=desc`, { method: "GET" });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return errJson(502, { ok: false, step: "get_messages", error: safeErr(t), thread_id: threadId });
    }
    const j = await r.json();
    const text = extractAssistantText(j) || "No text.";
    const citations = extractCitations(j);

    return new Response(JSON.stringify({ ok: true, thread_id: threadId, text, citations, usage }), {
      status: 200,
      headers: jsonHeaders()
    });
  }

  // ---------- Streaming path ----------
  // Create a streaming run and forward OpenAI SSE to the browser
  const upstream = await openai(`/v1/threads/${threadId}/runs`, {
    method: "POST",
    body: JSON.stringify({ assistant_id: OPENAI_ASSISTANT_ID, stream: true })
  });

  if (!upstream.ok || !upstream.body) {
    const t = await upstream.text().catch(() => "");
    // Busy-thread or other errors bubble up cleanly
    return errJson(502, { ok: false, step: "create_run_stream", error: safeErr(t), thread_id: threadId });
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8");

  const stream = new ReadableStream({
    async start(controller) {
      // Send a small "start" event for client code
      const send = (event, data) => {
        const lines = [];
        if (event) lines.push(`event: ${event}`);
        lines.push(`data: ${typeof data === "string" ? data : JSON.stringify(data)}`);
        lines.push("");
        controller.enqueue(new TextEncoder().encode(lines.join("\n")));
      };

      send("start", { ok: true, thread_id: threadId });

      let done;
      while (true) {
        ({ value: done } = await readAndForward(reader, decoder, controller));
        if (done) break;
      }
      controller.close();
    }
  });

  return new Response(stream, { status: 200, headers: sseHeaders() });
}

/* ---------------- helpers ---------------- */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function safeErr(raw) {
  try {
    const j = JSON.parse(raw);
    return j;
  } catch {
    return String(raw || "Unknown error");
  }
}

function extractAssistantText(listResponse) {
  // listResponse.data[0] is the newest message
  const m = listResponse?.data?.find(x => x.role === "assistant") || listResponse?.data?.[0];
  if (!m || !m.content) return "";
  let out = "";
  for (const part of m.content) {
    if (part.type === "text" && part.text?.value) out += part.text.value;
  }
  return out.trim();
}

function extractCitations(listResponse) {
  const m = listResponse?.data?.find(x => x.role === "assistant") || listResponse?.data?.[0];
  if (!m || !m.content) return [];
  const cites = [];
  for (const part of m.content) {
    if (part.type === "text" && Array.isArray(part.text?.annotations)) {
      for (const a of part.text.annotations) {
        if (a?.file_citation?.file_id) cites.push({ type: "file", file_id: a.file_citation.file_id, quote: a.text || null });
        if (a?.file_path?.file_id)    cites.push({ type: "file_path", file_id: a.file_path.file_id, path: a.file_path.path || null });
        if (a?.url)                   cites.push({ type: "url", url: a.url });
      }
    }
  }
  return cites;
}

// Read from OpenAI SSE and forward chunks to our client as SSE.
// Returns {value:true} when upstream ends.
async function readAndForward(reader, decoder, controller) {
  const { value, done } = await reader.read();
  if (done) {
    controller.enqueue(new TextEncoder().encode(`event: done\ndata: [DONE]\n\n`));
    return { value: true };
  }
  const chunk = decoder.decode(value, { stream: true });
  // OpenAI sends "data: {...}\n\n", possibly with "event: ...\n"
  // We forward as-is (normalised) so your front-end parser works.
  const blocks = chunk.split("\n\n");
  for (const b of blocks) {
    if (!b.trim()) continue;
    controller.enqueue(new TextEncoder().encode(b.trim() + "\n\n"));
  }
  return { value: false };
}
