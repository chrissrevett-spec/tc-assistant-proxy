// api/assistant.js
// Vercel Node function – Assistants v2, JSON + SSE streaming

import https from "https";

// ---- Env & constants -------------------------------------------------------
const OPENAI_API_KEY       = process.env.OPENAI_API_KEY || "";
const OPENAI_ASSISTANT_ID  = process.env.OPENAI_ASSISTANT_ID || "";
// Set this in Vercel to your live Squarespace origin, e.g. https://www.talkingcare.uk
const CORS_ALLOW_ORIGIN    = process.env.CORS_ALLOW_ORIGIN || "https://www.talkingcare.uk";

const OA_BASE = "https://api.openai.com/v1";

// Utility: small fetch wrapper with JSON, error shaping
async function oaJson(path, opts = {}) {
  const url = `${OA_BASE}${path}`;
  const headers = {
    "Authorization": `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "assistants=v2",
    ...(opts.headers || {})
  };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const err = new Error(`${opts.method || "GET"} ${url} failed: ${res.status} ${text}`);
    err.status = res.status;
    err.body = payload || text;
    throw err;
  }
  return payload;
}

// CORS helpers
function setCORS(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
}
function pickOrigin(req) {
  const o = req.headers.origin || "";
  return o && o.startsWith("https://www.talkingcare.uk") ? o : CORS_ALLOW_ORIGIN;
}
function endPreflight(res) { res.statusCode = 204; res.end(); }

// Robust body parser (handles Firefox text/plain)
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { resolve({ _raw: raw }); }
    });
  });
}

// Filter citations: keep only URL or file_path (drop raw file ids)
function normalizeCitations(annotations = []) {
  const out = [];
  for (const a of annotations) {
    if (a?.url) out.push({ type: "url", url: a.url });
    else if (a?.file_path?.file_id) out.push({ type: "file_path", file_id: a.file_path.file_id, path: a.file_path.path || "" });
    // skip file_citation with file_id only
  }
  return out;
}

// Pipe OpenAI SSE events to client response
async function pipeRunEvents({ thread_id, run_id, res }) {
  // Build URL for events
  const url = new URL(`${OA_BASE}/threads/${thread_id}/runs/${run_id}/events`);
  // You can filter event types if you want, but passing through all is fine:
  // url.searchParams.set("event_types[]", "response.output_text.delta");

  const controller = new AbortController();
  const ended = { v: false };

  // Ensure headers for SSE to browser
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no", // harmless hint
  });

  const keepAlive = setInterval(() => {
    if (!ended.v && res.writable) {
      try { res.write(`: keep-alive ${Date.now()}\n\n`); } catch {}
    }
  }, 15000);

  const onClientClose = () => {
    ended.v = true;
    clearInterval(keepAlive);
    try { controller.abort(); } catch {}
    try { if (!res.writableEnded) res.end(); } catch {}
  };
  res.on("close", onClientClose);
  res.on("finish", onClientClose);
  res.on("error", onClientClose);

  // Start the upstream SSE
  const upstream = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "assistants=v2",
      "Accept": "text/event-stream"
    },
    signal: controller.signal
  });

  if (!upstream.ok || !upstream.body) {
    const t = await upstream.text().catch(() => "");
    // send a final error event, then end
    if (!ended.v && res.writable && !res.writableEnded) {
      try {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ ok:false, step:"create_run_stream", error:`runs/events failed: ${upstream.status} ${t}` })}\n\n`);
      } catch {}
    }
    onClientClose();
    return;
  }

  // Announce start to browser with thread/run ids
  try {
    if (!ended.v && res.writable) {
      res.write(`event: start\n`);
      res.write(`data: ${JSON.stringify({ ok:true, thread_id, run_id })}\n\n`);
    }
  } catch {}

  // Relay the stream
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8");
  while (true) {
    const { value, done } = await reader.read().catch(() => ({ value: null, done: true }));
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (ended.v || !res.writable || res.writableEnded) continue;

    // The upstream is already SSE-formatted. We can forward as-is,
    // but to be safe we split into "blocks" and re-emit lines.
    const blocks = chunk.split("\n\n");
    for (const b of blocks) {
      if (!b) continue;
      if (ended.v || !res.writable || res.writableEnded) break;

      // Forward upstream SSE block unmodified
      try {
        res.write(b + "\n\n");
      } catch {
        // client likely disconnected
      }
    }
  }

  // Final done
  if (!ended.v && res.writable && !res.writableEnded) {
    try {
      res.write(`event: done\n`);
      res.write(`data: [DONE]\n\n`);
    } catch {}
  }
  onClientClose();
}

// Small helper to sleep
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Cancel in-progress run (best-effort)
async function cancelRun(thread_id, run_id) {
  try {
    await oaJson(`/threads/${thread_id}/runs/${run_id}/cancel`, { method: "POST" });
  } catch { /* ignore */ }
}

// ----------------------------------------------------------------------------

export default async function handler(req, res) {
  const origin = pickOrigin(req);
  setCORS(res, origin);

  // Handle preflight
  if (req.method === "OPTIONS") return endPreflight(res);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok:false, error:"Method Not Allowed" });
  }

  // Basic guard
  if (!OPENAI_API_KEY || !OPENAI_ASSISTANT_ID) {
    return res.status(500).json({ ok:false, error:"Missing OPENAI_API_KEY or OPENAI_ASSISTANT_ID" });
  }

  try {
    const body = await readBody(req);

    // Support both JSON and form of your front-end
    const userMessage = (body?.userMessage || body?.message || "").toString();
    let threadId = body?.threadId || null;

    const url = new URL(req.url, `https://${req.headers.host}`);
    const streamFlag = (url.searchParams.get("stream") || "off").toLowerCase();
    const wantStream = streamFlag === "on" || streamFlag === "true";

    // 1) Ensure thread
    if (!threadId) {
      const t = await oaJson("/threads", { method: "POST", body: JSON.stringify({}) });
      threadId = t.id;
    }

    // 2) Post user message
    try {
      await oaJson(`/threads/${threadId}/messages`, {
        method: "POST",
        body: JSON.stringify({ role: "user", content: userMessage })
      });
    } catch (e) {
      // If active run blocks messages, try to wait/cancel it
      const blocked = /active run/.test(String(e?.body?.error?.message || e.message || ""));
      if (blocked) {
        // Try to list runs and cancel the latest in_progress one
        try {
          const runs = await oaJson(`/threads/${threadId}/runs`, { method: "GET" });
          const active = (runs?.data || []).find(r => r.status === "in_progress" || r.status === "queued");
          if (active) {
            await cancelRun(threadId, active.id);
            await delay(300); // small backoff
          }
          // Retry adding the message once
          await oaJson(`/threads/${threadId}/messages`, {
            method: "POST",
            body: JSON.stringify({ role: "user", content: userMessage })
          });
        } catch (e2) {
          throw e; // surface the original if retry also fails
        }
      } else {
        throw e;
      }
    }

    // 3) Create run
    const run = await oaJson(`/threads/${threadId}/runs`, {
      method: "POST",
      body: JSON.stringify({ assistant_id: OPENAI_ASSISTANT_ID })
    });
    const runId = run.id;

    // STREAMING branch
    if (wantStream) {
      // Hand off to SSE pipe that hits /runs/{run_id}/events
      await pipeRunEvents({ thread_id: threadId, run_id: runId, res });
      return; // pipeRunEvents handles response lifecycle
    }

    // NON-STREAMING branch: poll until completed, then fetch the assistant message & citations
    let status = run.status;
    let safetyCounter = 0;
    while (status === "queued" || status === "in_progress") {
      await delay(300);
      const r = await oaJson(`/threads/${threadId}/runs/${runId}`, { method: "GET" });
      status = r.status;
      if (++safetyCounter > 400) break; // ~120s guard
    }

    // Fetch last messages
    const msgs = await oaJson(`/threads/${threadId}/messages?limit=5`, { method: "GET" });
    // Find the latest assistant response
    const assistantMsg = (msgs?.data || []).find(m => m.role === "assistant");

    let text = "";
    let citations = [];
    if (assistantMsg?.content?.length) {
      for (const c of assistantMsg.content) {
        if (c.type === "text" && c.text?.value) {
          text += c.text.value;
          // Filter annotations to hide raw file ids
          const anns = c.text.annotations || [];
          citations = citations.concat(normalizeCitations(anns));
        }
      }
    }

    return res.status(200).json({
      ok: true,
      text: text || "No assistant text was returned.",
      thread_id: threadId,
      citations,
      usage: null
    });

  } catch (err) {
    console.error("assistant handler error:", err);
    // If we were in streaming mode and headers were already sent, try to emit an error event
    try {
      if (res.getHeader("Content-Type")?.toString().startsWith("text/event-stream") && !res.writableEnded) {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ ok:false, step:"server", error:String(err?.body?.error?.message || err.message || err) })}\n\n`);
        res.write(`event: done\n`);
        res.write(`data: [DONE]\n\n`);
        return res.end();
      }
    } catch {}

    return res.status(500).json({ ok:false, error:"Internal Server Error" });
  }
}
