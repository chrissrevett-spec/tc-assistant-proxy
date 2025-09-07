// ---- CORS helpers (add at very top) ----
const ALLOWED_ORIGINS = new Set([
  "https://www.talkingcare.uk",
  "https://talkingcare.uk",
  // add any preview/testing hosts you use:
  // "https://preview.squarespace.com",
  // "http://localhost:5500",
]);

function pickOrigin(req) {
  const o = req.headers["origin"];
  if (o && ALLOWED_ORIGINS.has(o)) return o;
  return null; // disallow others by default
}

function setCorsHeaders(res, origin) {
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, x-vercel-protection-bypass");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendCorsPreflight(req, res) {
  const origin = pickOrigin(req);
  setCorsHeaders(res, origin);
  res.statusCode = 204; // No Content
  res.end();
  return true;
}

function beginSSE(res, origin) {
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // helps some CDNs
}

// Utility to safely send JSON with CORS on error/sync paths
function sendJson(res, origin, code, obj) {
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.statusCode = code;
  res.end(JSON.stringify(obj));
}

// /api/assistant.js
// Talking Care Navigator — unified JSON + SSE endpoint for Squarespace
//
// - POST ?stream=off  => JSON response (non-streaming)
// - POST (no query)   => text/event-stream (SSE) streaming
//
// Notes:
// * Requires env var OPENAI_API_KEY in Vercel Project settings.
// * If you use the Assistants API (v2), we must send header OpenAI-Beta: assistants=v2.
// * CORS allows your Squarespace origin (edit allowedOrigins below if needed).

import OpenAI from "openai";

const allowedOrigins = new Set([
  "https://www.talkingcare.uk",
  "https://talkingcare.uk",
  "http://localhost:5173",
  "http://localhost:3000",
]);

// Construct OpenAI client with the Assistants v2 beta header.
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: { "OpenAI-Beta": "assistants=v2" },
});

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-vercel-protection-bypass, Accept",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export default async function handler(req, res) {
  try {
    const origin = allowedOrigins.has(req.headers.origin)
      ? req.headers.origin
      : allowedOrigins.values().next().value; // first allowed

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(origin));
      return res.end();
    }

    if (req.method !== "POST") {
      res.writeHead(405, { ...corsHeaders(origin), "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
    }

    // Parse body
    let body = {};
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    } catch {
      // Some hosts already parse JSON
      body = req.body || {};
    }
    const userMessage = (body?.userMessage || "").toString().trim();
    let threadId = body?.threadId || null;

    if (!userMessage) {
      res.writeHead(400, { ...corsHeaders(origin), "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Missing userMessage" }));
    }

    // Helper: ensure thread exists (or create)
    async function getOrCreateThread(id) {
      try {
        if (id) {
          // validate it exists
          await openai.beta.threads.retrieve(id);
          return id;
        }
      } catch {
        // fall through to create
      }
      const t = await openai.beta.threads.create();
      return t.id;
    }

    // Helper: add message with busy-run safety
    async function safeAddMessage(tid, content) {
      // If a run is currently active for this thread, OpenAI will reject adding messages.
      // We’ll check latest runs; if one is running, we create a fresh thread to avoid blocking.
      try {
        // Attempt add; if it fails with "active run", we catch and start new thread
        await openai.beta.threads.messages.create(tid, {
          role: "user",
          content,
        });
        return tid;
      } catch (e) {
        const msg = e?.error?.message || e?.message || "";
        if (msg.includes("active run")) {
          const fresh = await openai.beta.threads.create();
          await openai.beta.threads.messages.create(fresh.id, { role: "user", content });
          return fresh.id;
        }
        throw e;
      }
    }

    // Non-streaming (JSON) mode
    if ((req.query?.stream || req.url.includes("stream=off"))) {
      threadId = await getOrCreateThread(threadId);
      threadId = await safeAddMessage(threadId, userMessage);

      // Create a run and poll to completion
      const run = await openai.beta.threads.runs.create(threadId, {
        assistant_id: process.env.ASSISTANT_ID, // set this in Vercel env, or swap to inline model if you prefer Responses API
        // You can pass additional instructions or tools here if needed
      });

      // Poll
      let completed = null;
      for (let i = 0; i < 120; i++) {
        const r = await openai.beta.threads.runs.retrieve(threadId, run.id);
        if (r.status === "completed") { completed = r; break; }
        if (["failed", "cancelled", "expired"].includes(r.status)) {
          res.writeHead(500, { ...corsHeaders(origin), "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: false, step: "run_poll", error: r.last_error || r.status }));
        }
        await new Promise(s => setTimeout(s, 1000));
      }
      if (!completed) {
        res.writeHead(504, { ...corsHeaders(origin), "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, step: "timeout", error: "Run did not complete in time" }));
      }

      // Fetch latest assistant message text
      const list = await openai.beta.threads.messages.list(threadId, { order: "desc", limit: 5 });
      const msg = list.data.find(m => m.role === "assistant");
      const text = (msg?.content || [])
        .filter(c => c.type === "text")
        .map(c => c.text?.value || "")
        .join("\n")
        .trim();

      // (Optional) collect simple usage if available
      const usage = completed?.usage || null;

      res.writeHead(200, { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, thread_id: threadId, text, citations: [], usage }));
    }

    // Streaming (SSE) mode
    threadId = await getOrCreateThread(threadId);
    threadId = await safeAddMessage(threadId, userMessage);

    // Set SSE headers
    res.writeHead(200, {
      ...corsHeaders(origin),
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // help some proxies not buffer
    });

    // Heartbeat to keep the connection open (every 10s)
    const heartbeat = setInterval(() => {
      try { res.write(`event: ping\ndata: {}\n\n`); } catch {}
    }, 10000);

    // Start streaming run
    const stream = await openai.beta.threads.runs.stream(threadId, {
      assistant_id: process.env.ASSISTANT_ID,
    });

    // Accumulate a bit of text to ensure the UI updates smoothly
    stream.on("message.delta", (evt) => {
      // evt.data.delta.content: array of deltas, we forward as OpenAI-style SSE
      res.write(`event: thread.message.delta\n`);
      res.write(`data: ${JSON.stringify(evt.data)}\n\n`);
    });

    stream.on("message.completed", (evt) => {
      res.write(`event: thread.message.completed\n`);
      res.write(`data: ${JSON.stringify(evt.data)}\n\n`);
    });

    stream.on("run.step.completed", (evt) => {
      res.write(`event: thread.run.step.completed\n`);
      res.write(`data: ${JSON.stringify(evt.data)}\n\n`);
    });

    stream.on("run.completed", (evt) => {
      res.write(`event: thread.run.completed\n`);
      res.write(`data: ${JSON.stringify(evt.data)}\n\n`);
      res.write(`data: [DONE]\n\n`);
      clearInterval(heartbeat);
      res.end();
    });

    stream.on("error", (err) => {
      // Send a structured error event instead of crashing
      try {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ message: err?.message || "stream error" })}\n\n`);
        res.write(`data: [DONE]\n\n`);
      } catch {}
      clearInterval(heartbeat);
      try { res.end(); } catch {}
    });

    // Safety: if client disconnects, stop streaming
    req.on("close", () => {
      try { stream.abort(); } catch {}
      clearInterval(heartbeat);
    });

  } catch (e) {
    // Final safety net
    const origin = allowedOrigins.values().next().value;
    res.writeHead(500, { ...corsHeaders(origin), "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, step: "top_level", error: e?.error || e?.message || "server error" }));
  }
}
