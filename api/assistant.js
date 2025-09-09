// File: api/assistant.js
//
// One file that supports BOTH:
//   - Non-streaming JSON replies (?stream=off) using polling
//   - Streaming SSE replies (default) using Runs Events
//
// Requirements (project-level env on Vercel):
//   OPENAI_API_KEY           = sk-... (required)
//   OPENAI_ASSISTANT_ID      = asst_... (required)
//   CORS_ALLOW_ORIGIN        = https://www.talkingcare.uk (or your exact origin)
// Optional:
//   CORS_REFLECT_ORIGIN      = "true" to echo arbitrary Origin during preview
//
// Runtime: Node (NOT edge). In vercel.json set:
// {
//   "functions": { "api/*.js": { "runtime": "nodejs" } }
// }

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || "";
const ALLOW_ORIGIN =
  process.env.CORS_ALLOW_ORIGIN?.trim() || "https://www.talkingcare.uk";
const REFLECT_ORIGIN = /^true$/i.test(process.env.CORS_REFLECT_ORIGIN || "");

// ---- CORS helpers ----
function pickOrigin(req) {
  const origin = req.headers.origin || "";
  if (REFLECT_ORIGIN && origin) return origin; // preview-friendly, be cautious
  return ALLOW_ORIGIN;
}
function setCors(res, origin) {
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

// ---- OpenAI helpers ----
const OA_BASE = "https://api.openai.com/v1";

function oaHeaders(json = true) {
  const h = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    "OpenAI-Beta": "assistants=v2",
  };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

async function oaJson(url, method, bodyObj) {
  const resp = await fetch(url, {
    method,
    headers: oaHeaders(true),
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`${method} ${url} failed: ${resp.status} ${text}`);
  }
  return resp.json();
}

async function createThread() {
  return oaJson(`${OA_BASE}/threads`, "POST", {});
}

async function addUserMessage(thread_id, content) {
  return oaJson(`${OA_BASE}/threads/${thread_id}/messages`, "POST", {
    role: "user",
    content,
  });
}

async function createRun(thread_id, assistant_id) {
  return oaJson(`${OA_BASE}/threads/${thread_id}/runs`, "POST", {
    assistant_id,
  });
}

async function retrieveRun(thread_id, run_id) {
  return oaJson(`${OA_BASE}/threads/${thread_id}/runs/${run_id}`, "GET");
}

async function listMessages(thread_id) {
  // default order: newest first; we’ll join text from all assistant messages
  return oaJson(`${OA_BASE}/threads/${thread_id}/messages?limit=20`, "GET");
}

// ---- Polling (non-stream) until run completes ----
async function waitForRunDone(thread_id, run_id, timeoutMs = 60000) {
  const start = Date.now();
  while (true) {
    const run = await retrieveRun(thread_id, run_id);
    if (run.status === "completed") return run;
    if (
      run.status === "failed" ||
      run.status === "cancelled" ||
      run.status === "expired"
    ) {
      throw new Error(`run ${run.status}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("run timeout");
    }
    await new Promise((r) => setTimeout(r, 750));
  }
}

// ---- JSON mode response shaping (hide raw file IDs nicely) ----
function extractTextAndCitations(messages) {
  let text = "";
  const cites = [];
  for (const m of messages.data || []) {
    if (m.role !== "assistant") continue;
    for (const c of m.content || []) {
      if (c.type === "text" && c.text?.value) {
        text += (text ? "\n\n" : "") + c.text.value;
        const anns = c.text.annotations || [];
        for (const a of anns) {
          // Map file_citation and file_path to a stable label
          if (a.file_citation?.file_id) {
            const id = a.file_citation.file_id;
            // Avoid duplicates
            if (!cites.find((x) => x.type === "file" && x.file_id === id)) {
              cites.push({ type: "file", file_id: id });
            }
          } else if (a.file_path?.file_id) {
            const id = a.file_path.file_id;
            if (!cites.find((x) => x.type === "file_path" && x.file_id === id)) {
              cites.push({
                type: "file_path",
                file_id: id,
                path: a.file_path.path || undefined,
              });
            }
          } else if (a.url) {
            if (!cites.find((x) => x.type === "url" && x.url === a.url)) {
              cites.push({ type: "url", url: a.url });
            }
          }
        }
      }
    }
  }
  return { text, citations: cites };
}

// ---- The HTTP handler ----
export default async function handler(req, res) {
  const origin = pickOrigin(req);
  setCors(res, origin);

  if (req.method === "OPTIONS") {
    return endPreflight(res);
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res
      .status(405)
      .json({ ok: false, error: "Method Not Allowed (use POST)" });
  }

  if (!OPENAI_API_KEY || !OPENAI_ASSISTANT_ID) {
    return res
      .status(500)
      .json({ ok: false, error: "Missing OPENAI_API_KEY or OPENAI_ASSISTANT_ID" });
  }

  // Parse body safely
  const body =
    typeof req.body === "string"
      ? JSON.parse(req.body || "{}")
      : req.body || {};
  const userMessage = String(body.userMessage || "").trim();
  const threadIdFromClient = body.threadId || null;
  const url = new URL(req.url, "http://localhost"); // to read query
  const streamParam = url.searchParams.get("stream") || "on";
  const doStream = streamParam !== "off";

  try {
    // 1) Create or reuse thread
    const thread_id =
      threadIdFromClient ||
      (await createThread()).id;

    // 2) Add user message
    await addUserMessage(thread_id, userMessage || "Hello");

    // 3) Create a run
    const run = await createRun(thread_id, OPENAI_ASSISTANT_ID);
    const run_id = run.id;

    if (!doStream) {
      // ---- NON-STREAMING JSON PATH ----
      await waitForRunDone(thread_id, run_id, 90_000);
      const messages = await listMessages(thread_id);
      const { text, citations } = extractTextAndCitations(messages);

      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.status(200).json({
        ok: true,
        text: text || "(no text)",
        thread_id,
        citations,
        usage: run.usage || null,
      });
    }

    // ---- STREAMING SSE PATH ----
    // Important: write SSE headers and flush before contacting OpenAI stream
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept",
    });
    if (typeof res.flushHeaders === "function") {
      try { res.flushHeaders(); } catch {}
    }

    // Tell the client which thread we’re on
    res.write(`event: start\n`);
    res.write(`data: ${JSON.stringify({ ok: true, thread_id })}\n\n`);

    // 4) Open the OpenAI Run Events stream (SSE)
    const eventsUrl = `${OA_BASE}/threads/${thread_id}/runs/${run_id}/events?limit=100&after=0&stream=true`;
    const upstream = await fetch(eventsUrl, {
      method: "GET",
      headers: {
        ...oaHeaders(false),
        Accept: "text/event-stream",
      },
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => "");
      res.write(`event: error\n`);
      res.write(
        `data: ${JSON.stringify({
          ok: false,
          step: "create_run_stream",
          error: `runs/stream failed: ${upstream.status} ${errText}`,
        })}\n\n`
      );
      res.write(`event: done\n`);
      res.write(`data: [DONE]\n\n`);
      return res.end();
    }

    // 5) Pipe events through to the browser, untouched
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const keepAlive = setInterval(() => {
      try { res.write(`: keep-alive ${Date.now()}\n\n`); } catch {}
    }, 15000);

    try {
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // OpenAI sends SSE frames separated by \n\n
        const frames = buf.split("\n\n");
        buf = frames.pop() || "";

        for (const frame of frames) {
          // Pass through verbatim; don’t “rename” run_id to 'stream'!
          res.write(frame + "\n\n");
        }
      }
    } catch (e) {
      // If the client disconnected, just stop
    } finally {
      clearInterval(keepAlive);
    }

    res.write(`event: done\n`);
    res.write(`data: [DONE]\n\n`);
    return res.end();
  } catch (err) {
    // Stream-safe error
    const isSSE = doStream && !res.headersSent
      ? false // we haven’t sent SSE headers yet
      : doStream && res.getHeader("Content-Type")?.toString().includes("text/event-stream");

    if (isSSE) {
      try {
        res.write(`event: error\n`);
        res.write(
          `data: ${JSON.stringify({
            ok: false,
            step: "unhandled",
            error: String(err && err.message ? err.message : err),
          })}\n\n`
        );
        res.write(`event: done\n`);
        res.write(`data: [DONE]\n\n`);
        return res.end();
      } catch {}
    }
    console.error("assistant handler error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Internal Server Error" });
  }
}
