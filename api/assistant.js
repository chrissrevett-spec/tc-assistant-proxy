export const config = { runtime: "nodejs22.x" };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID   = process.env.OPENAI_ASSISTANT_ID;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, x-vercel-protection-bypass",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    ...extra
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() }
  });
}

export async function OPTIONS() {
  // Vercel also injects headers via vercel.json, but answering explicitly is safest.
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export default async function handler(req) {
  try {
    if (req.method === "OPTIONS") return OPTIONS();

    if (!OPENAI_API_KEY) return json(500, { ok: false, error: "Missing OPENAI_API_KEY" });
    if (!ASSISTANT_ID)   return json(500, { ok: false, error: "Missing OPENAI_ASSISTANT_ID" });

    // Parse query and body
    const url = new URL(req.url);
    const streamOff = url.searchParams.get("stream") === "off";

    const { userMessage, threadId } = await req.json().catch(() => ({}));
    if (!userMessage) return json(400, { ok: false, error: "Missing userMessage" });

    // 1) Ensure thread
    let tid = threadId;
    if (!tid) {
      const r = await fetch("https://api.openai.com/v1/threads", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      });
      if (!r.ok) {
        const t = await r.text();
        return json(502, { ok: false, step: "create_thread", error: safeParse(t) ?? t });
      }
      const data = await r.json();
      tid = data.id;
    }

    // 2) Add user message
    {
      const r = await fetch(`https://api.openai.com/v1/threads/${tid}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ role: "user", content: userMessage })
      });
      if (!r.ok) {
        const t = await r.text();
        // Busy run case (active run) — surface clearly to the widget so it can clear thread
        return json(400, { ok: false, step: "add_message", error: safeParse(t) ?? t, thread_id: tid });
      }
    }

    // 3) STREAMING branch
    if (!streamOff) {
      const upstream = await fetch(`https://api.openai.com/v1/threads/${tid}/runs`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ assistant_id: ASSISTANT_ID, stream: true })
      });

      if (!upstream.ok || !upstream.body) {
        const t = upstream ? await upstream.text().catch(() => "") : "";
        return json(502, { ok: false, step: "create_run", error: safeParse(t) ?? t, thread_id: tid });
      }

      // Proxy SSE from OpenAI to the browser
      const clientStream = new ReadableStream({
        async start(controller) {
          // Send a small 'start' event so the client knows the stream really began
          controller.enqueue(encodeSSE("start", { ok: true, thread_id: tid }));

          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              controller.enqueue(new TextEncoder().encode(chunk));
            }
          } catch (e) {
            controller.enqueue(encodeSSE("error", { message: String(e?.message || e) }));
          } finally {
            controller.enqueue(encodeSSE("done", "[DONE]"));
            controller.close();
          }
        }
      });

      return new Response(clientStream, {
        status: 200,
        headers: {
          ...corsHeaders(),
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no"
        }
      });
    }

    // 4) NON-STREAM: create run, poll until completed, fetch final message text
    const run = await fetch(`https://api.openai.com/v1/threads/${tid}/runs`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ assistant_id: ASSISTANT_ID })
    });

    if (!run.ok) {
      const t = await run.text();
      return json(502, { ok: false, step: "create_run", error: safeParse(t) ?? t, thread_id: tid });
    }
    const runData = await run.json();

    // Poll
    let status = runData.status;
    let safetyCounter = 0;
    while (!["completed", "failed", "requires_action", "cancelled", "expired"].includes(status)) {
      await sleep(900);
      safetyCounter++;
      const r = await fetch(`https://api.openai.com/v1/threads/${tid}/runs/${runData.id}`, {
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" }
      });
      if (!r.ok) {
        const t = await r.text();
        return json(502, { ok: false, step: "get_run", error: safeParse(t) ?? t, thread_id: tid });
      }
      const d = await r.json();
      status = d.status;
      if (safetyCounter > 200) break; // ~3 minutes safeguard
    }

    if (status !== "completed") {
      return json(502, { ok: false, step: "run_status", status, thread_id: tid });
    }

    // Get the latest assistant message
    const msgs = await fetch(`https://api.openai.com/v1/threads/${tid}/messages?limit=10&order=desc`, {
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "assistants=v2" }
    });
    if (!msgs.ok) {
      const t = await msgs.text();
      return json(502, { ok: false, step: "list_messages", error: safeParse(t) ?? t, thread_id: tid });
    }
    const list = await msgs.json();
    const first = (list.data || []).find(m => m.role === "assistant");
    const text = extractText(first);

    return json(200, { ok: true, thread_id: tid, text, citations: [], usage: null });
  } catch (err) {
    return json(500, { ok: false, error: String(err?.message || err) });
  }
}

// helpers
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractText(msg) {
  if (!msg || !msg.content) return "";
  let out = "";
  for (const c of msg.content) {
    if (c.type === "text" && c.text?.value) out += c.text.value;
  }
  return out.trim();
}

function encodeSSE(event, data) {
  const enc = new TextEncoder();
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return enc.encode(`event: ${event}\n` + `data: ${payload}\n\n`);
}

function safeParse(t) { try { return JSON.parse(t); } catch { return null; } }
