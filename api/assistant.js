// api/assistant.js
//
// Robust Assistants v2 JSON + Streaming proxy for Squarespace.
// - Non-streaming: POST /api/assistant?stream=off  -> returns { ok, text, thread_id, citations, usage }
// - Streaming:     POST /api/assistant            -> SSE pass-through of OpenAI events
//
// ENV required (at project level in Vercel):
//   OPENAI_API_KEY           = sk-...               (required)
//   OPENAI_ASSISTANT_ID      = asst_...             (required)
// Optional:
//   CORS_ALLOW_ORIGIN        = https://www.talkingcare.uk
//   CORS_ALLOW_METHODS       = GET,POST,OPTIONS
//   CORS_ALLOW_HEADERS       = Content-Type, Accept
//
// NOTE: We add 'OpenAI-Beta' automatically when calling OpenAI.
//       We also widen CORS-Allow-Headers to include 'OpenAI-Beta' and 'Authorization' so your
//       preflights never block (even if you add headers later).

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ASSISTANT_ID   = process.env.OPENAI_ASSISTANT_ID || "";

if (!OPENAI_API_KEY) console.error("Missing OPENAI_API_KEY");
if (!ASSISTANT_ID)   console.error("Missing OPENAI_ASSISTANT_ID");

const ORIGIN  = process.env.CORS_ALLOW_ORIGIN  || "https://www.talkingcare.uk";
const METHODS = process.env.CORS_ALLOW_METHODS || "GET, POST, OPTIONS";
const HDRS    = (process.env.CORS_ALLOW_HEADERS || "Content-Type, Accept")
  // make sure these two are *always* present so future changes don't break preflight
  .split(",").map(s=>s.trim()).filter(Boolean)
  .concat(["OpenAI-Beta","Authorization"])
  .filter((v,i,a)=>a.indexOf(v)===i) // dedupe
  .join(", ");

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", METHODS);
  res.setHeader("Access-Control-Allow-Headers", HDRS);
  res.setHeader("Access-Control-Max-Age", "86400");
}

function json(res, code, obj) {
  if (!res.headersSent) {
    setCORS(res);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
  }
  res.status(code).end(JSON.stringify(obj));
}

async function oaJson(path, opt = {}) {
  const url = `https://api.openai.com${path}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
      ...opt.headers
    },
    body: opt.body ? JSON.stringify(opt.body) : undefined
  });
  if (!r.ok) {
    const errText = await r.text().catch(()=> "");
    throw new Error(`${opt.method||"POST"} ${url} failed: ${r.status} ${errText || r.statusText}`);
  }
  return r.json();
}

// GET event stream from OpenAI and pipe to client
async function oaStream(path, res) {
  const url = `https://api.openai.com${path}`;
  const r = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Accept": "text/event-stream",
      "OpenAI-Beta": "assistants=v2"
    }
  });
  if (!r.ok || !r.body) {
    const errText = await r.text().catch(()=> "");
    throw new Error(`GET ${url} failed: ${r.status} ${errText || r.statusText}`);
  }

  // Prepare SSE headers for the browser
  setCORS(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });

  // keep-alive pings (helps some proxies)
  const keepAlive = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
  }, 15000);

  try {
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      // Pass chunks straight through (already Server-Sent Events)
      res.write(chunk);
    }
  } finally {
    clearInterval(keepAlive);
    // end *once*
    if (!res.writableEnded) res.end();
  }
}

function extractTextAndCitations(messageObj) {
  // Concatenate all text parts; extract URL annotations only (hide file_ids)
  let text = "";
  const cites = [];
  for (const p of (messageObj?.content || [])) {
    if (p.type === "text" && p.text?.value) {
      text += p.text.value;
      const anns = p.text.annotations || [];
      for (const a of anns) {
        if (a?.url) cites.push({ type: "url", url: a.url });
      }
    }
  }
  return { text, citations: cites };
}

export default async function handler(req, res) {
  try {
    setCORS(res);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST")   return json(res, 405, { ok:false, error:"Method Not Allowed" });

    // Parse JSON (Squarespace sometimes gives string bodies)
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const streamOff = (req.query?.stream === "off");
    const userMessage = (body.userMessage || "").toString();
    let threadId = body.threadId || null;

    if (!OPENAI_API_KEY) return json(res, 500, { ok:false, error:"Missing OPENAI_API_KEY" });
    if (!ASSISTANT_ID)   return json(res, 500, { ok:false, error:"Missing OPENAI_ASSISTANT_ID" });
    if (!userMessage)    return json(res, 400, { ok:false, error:"Missing userMessage" });

    // Ensure a thread exists
    if (!threadId) {
      const t = await oaJson("/v1/threads");
      threadId = t.id;
    }

    // Add the user message
    await oaJson(`/v1/threads/${threadId}/messages`, {
      body: { role: "user", content: userMessage }
    });

    // Non-streaming: create a run, poll completion, fetch the latest assistant message, return as JSON
    if (streamOff) {
      const run = await oaJson(`/v1/threads/${threadId}/runs`, {
        body: { assistant_id: ASSISTANT_ID }
      });

      // Simple poll loop
      let status = run.status;
      let runId = run.id;
      const started = Date.now();
      while (status === "queued" || status === "in_progress") {
        await new Promise(r => setTimeout(r, 600));
        const rj = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
          headers: {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "assistants=v2"
          }
        });
        if (!rj.ok) {
          const et = await rj.text().catch(()=> "");
          throw new Error(`GET run status failed: ${rj.status} ${et}`);
        }
        const rd = await rj.json();
        status = rd.status;

        // hard timeout guard (60s)
        if (Date.now() - started > 60000) break;
      }

      // Fetch the latest messages
      const msgsR = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages?limit=5&order=desc`, {
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2"
        }
      });
      if (!msgsR.ok) {
        const et = await msgsR.text().catch(()=> "");
        throw new Error(`GET messages failed: ${msgsR.status} ${et}`);
      }
      const msgsJ = await msgsR.json();

      // Find the first assistant message
      const assistantMsg = (msgsJ.data || []).find(m => m.role === "assistant");
      const { text, citations } = assistantMsg ? extractTextAndCitations(assistantMsg) : { text: "", citations: [] };

      return json(res, 200, {
        ok: true,
        text: text || "(no text)",
        thread_id: threadId,
        citations,
        usage: null
      });
    }

    // Streaming: create a run, then GET /events and pipe it to the browser
    const run = await oaJson(`/v1/threads/${threadId}/runs`, {
      body: { assistant_id: ASSISTANT_ID }
    });
    const runId = run.id;

    // Pro tip: send a tiny "start" event before proxying OpenAI stream (UX feedback)
    setCORS(res);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write(`event: start\n`);
    res.write(`data: ${JSON.stringify({ ok:true, thread_id: threadId, run_id: runId })}\n\n`);

    // Now proxy OpenAI events
    await oaStream(`/v1/threads/${threadId}/runs/${runId}/events`, res);
    // oaStream ends the response safely.

  } catch (err) {
    console.error("assistant handler error:", err);
    // If headers already sent (e.g., during streaming), emit an SSE error event once.
    try {
      if (!res.headersSent) {
        json(res, 500, { ok:false, error:String(err?.message || err) });
      } else if (!res.writableEnded) {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ ok:false, step:"create_run_stream", error:String(err?.message || err) })}\n\n`);
        res.write(`event: done\n`);
        res.write(`data: [DONE]\n\n`);
        res.end();
      }
    } catch {}
  }
}
