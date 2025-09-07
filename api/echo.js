export const config = { runtime: "nodejs22.x" };
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

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return OPTIONS();

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") || "sse";
  const { message = "Hello from Talking Care Navigator!" } = await req.json().catch(() => ({}));

  if (mode === "echo") {
    // Plain JSON response
    return new Response(JSON.stringify({ ok: true, message }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() }
    });
  }

  // SSE streaming test
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(sse("start", { ok: true }));
      const parts = [`{"message":"`, ...message.split(""), `"}`];
      for (const p of parts) {
        await wait(120);
        controller.enqueue(sse("thread.message.delta", { delta: { content: [{ type: "output_text_delta", text: p }] } }));
      }
      controller.enqueue(sse("done", "[DONE]"));
      controller.close();
    }
  });

  return new Response(stream, {
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

function sse(event, data) {
  const enc = new TextEncoder();
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return enc.encode(`event: ${event}\n` + `data: ${payload}\n\n`);
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
