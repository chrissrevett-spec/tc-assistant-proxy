import { commonCorsHeaders, errJson, handleOptions } from "./_cors.js";

/**
 * POST /api/echo
 * - mode=stream → sends SSE "start", several "chunk" events with your message, and "done".
 * - otherwise   → returns JSON { ok:true, message }
 */
export async function OPTIONS() { return handleOptions(); }

export async function POST(req) {
  const headers = commonCorsHeaders();

  let body;
  try { body = await req.json(); } catch { body = {}; }
  const msg = (body && body.message) ? String(body.message) : "Hello";

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") || "json";

  if (mode !== "stream") {
    return new Response(JSON.stringify({ ok: true, message: msg }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
    });
  }

  // SSE streaming
  const stream = new ReadableStream({
    start(controller) {
      const enc = (obj, event = "message") => {
        const lines = [];
        if (event) lines.push(`event: ${event}`);
        lines.push(`data: ${JSON.stringify(obj)}`);
        lines.push(""); // blank line
        controller.enqueue(new TextEncoder().encode(lines.join("\n")));
      };

      // let browsers know
      enc({ ok: true }, "start");

      const chunks = [
        `{"message":"`,
        msg.slice(0, Math.ceil(msg.length * 0.33)),
        msg.slice(Math.ceil(msg.length * 0.33), Math.ceil(msg.length * 0.66)),
        msg.slice(Math.ceil(msg.length * 0.66)) + `"}`
      ];

      let i = 0;
      const interval = setInterval(() => {
        if (i < chunks.length) {
          enc({ chunk: chunks[i++] }, "chunk");
        } else {
          enc("[DONE]", "done");
          clearInterval(interval);
          controller.close();
        }
      }, 120);
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...headers,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}

export async function GET() {
  // Helpful for quick health checks
  return new Response("OK", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...commonCorsHeaders() }
  });
}
