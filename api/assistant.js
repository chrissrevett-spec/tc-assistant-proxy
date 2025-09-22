// /api/assistant.js
//
// Now powered by Assistants API v2 (threads + runs)
// Modes:
//  • Non-streaming  : POST /api/assistant?stream=off  -> JSON { ok, text }
//  • Streaming (SSE): POST /api/assistant?stream=on   -> raw SSE (unified events)
//
// Why this version?
// - Your account rejected /responses with assistant_id/tool_resources.
// - Assistants v2 uses the assistant's attached Vector Store & File Search directly.
// - Unified streaming emits `response.output_text.delta`, which your widget already handles.
//
// Required env vars
//  - OPENAI_API_KEY
//  - OPENAI_ASSISTANT_ID  (must have File Search enabled + your vector store attached)
//
// Optional env vars
//  - CORS_ALLOW_ORIGIN
//  - DEBUG_SSE_LOG=("1") for server-side stream mirroring
//
// Notes
// - We append a grounding policy to the assistant's instructions per call.

const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || "";

const CORS_ALLOW_ORIGIN   = process.env.CORS_ALLOW_ORIGIN || "https://tc-assistant-proxy.vercel.app";
const CORS_ALLOW_METHODS  = process.env.CORS_ALLOW_METHODS || "GET, POST, OPTIONS";
const CORS_ALLOW_HEADERS  = process.env.CORS_ALLOW_HEADERS || "Content-Type, Accept";
const CORS_MAX_AGE        = "86400";
const DEBUG_SSE_LOG       = process.env.DEBUG_SSE_LOG === "1";

if (!OPENAI_API_KEY) {
  console.error("[assistant] Missing OPENAI_API_KEY");
}
if (!OPENAI_ASSISTANT_ID) {
  console.error("[assistant] Missing OPENAI_ASSISTANT_ID — ensure your assistant has File Search + the correct Vector Store attached in the dashboard.");
}

// ---------- CORS ----------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
  res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  res.setHeader("Access-Control-Max-Age", CORS_MAX_AGE);
}
function endPreflight(res) { res.statusCode = 204; res.end(); }

// ---------- Body parsing ----------
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;

  return await new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const t = (data || "").trim();
      if (!t) return resolve({});
      if (t.startsWith("{") || t.startsWith("[")) {
        try { resolve(JSON.parse(t)); } catch { resolve({}); }
      } else {
        resolve({ userMessage: t });
      }
    });
    req.on("error", reject);
  });
}

// ---------- Helpers: fetch Assistant base instructions (cache) ----------
const INSTR_CACHE_TTL_MS = 5 * 60 * 1000;
let instrCache = { text: "", at: 0 };

async function fetchAssistantInstructions() {
  const now = Date.now();
  if (instrCache.text && now - instrCache.at < INSTR_CACHE_TTL_MS) return instrCache.text;

  try {
    const r = await fetch(`https://api.openai.com/v1/assistants/${OPENAI_ASSISTANT_ID}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2",
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
    });
    if (!r.ok) {
      const errTxt = await r.text().catch(() => "");
      console.warn(`[assistant] Failed to fetch assistant: ${r.status} ${errTxt}`);
      return "You are Talking Care Navigator. Be concise, practical, UK-focused, and cite official guidance at the end when relevant.";
    }
    const data = await r.json();
    const sys = (data && typeof data.instructions === "string" && data.instructions.trim()) ? data.instructions.trim() : "";
    const finalSys = sys || "You are Talking Care Navigator. Be concise, practical, UK-focused, and cite official guidance at the end when relevant.";
    instrCache = { text: finalSys, at: now };
    return finalSys;
  } catch (e) {
    console.warn("[assistant] Error fetching assistant instructions:", e?.message || e);
    return "You are Talking Care Navigator. Be concise, practical, UK-focused, and cite official guidance at the end when relevant.";
  }
}

// ---------- Grounding policy ----------
function withGroundingPolicy(sys) {
  const policy = `
CRITICAL GROUNDING POLICY:
You must search the attached document library first using File Search and base your answer on those documents.
Do not include inline URLs, bracketed numbers like [1], or footnotes inside the body of the answer. Only list sources once at the end under a "Sources" heading.
If the library contains no relevant passages, reply: "No matching sources found in the library." You may then use other enabled tools (e.g., web_search) but clearly separate those web sources in the Sources list.
Prefer short verbatim quotes for key definitions and include paragraph or section numbers where available.
Never answer purely from general knowledge without sources.
`.trim();
  return `${sys}\n\n${policy}`;
}

// ---------- Assistants v2 (non-streaming) ----------
async function handleNonStreaming(userMessage) {
  const base = await fetchAssistantInstructions();
  const instructions = withGroundingPolicy(base);

  // 1) Create a thread
  const thread = await fetch("https://api.openai.com/v1/threads", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({}),
  }).then(async r => (r.ok ? r.json() : Promise.reject(new Error(await r.text().catch(()=>`${r.status}`)))));

  // 2) Add the user message
  await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({
      role: "user",
      content: userMessage
    }),
  }).then(async r => (r.ok ? r.json() : Promise.reject(new Error(await r.text().catch(()=>`${r.status}`)))));

  // 3) Create run (no stream)
  const run = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify({
      assistant_id: OPENAI_ASSISTANT_ID,
      instructions
    }),
  }).then(async r => (r.ok ? r.json() : Promise.reject(new Error(await r.text().catch(()=>`${r.status}`)))));

  // 4) Poll until complete (simple loop with timeout)
  const started = Date.now();
  while (true) {
    const status = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs/${run.id}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2",
      },
    }).then(async r => (r.ok ? r.json() : Promise.reject(new Error(await r.text().catch(()=>`${r.status}`)))));

    if (status.status === "completed") break;
    if (status.status === "failed" || status.status === "expired" || status.status === "cancelled") {
      throw new Error(`run status: ${status.status}`);
    }
    if (Date.now() - started > 60_000) { // 60s timeout
      throw new Error("timeout waiting for run to complete");
    }
    await new Promise(r => setTimeout(r, 600));
  }

  // 5) Read latest assistant message
  const msgs = await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages?order=desc&limit=1`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "assistants=v2",
    },
  }).then(async r => (r.ok ? r.json() : Promise.reject(new Error(await r.text().catch(()=>`${r.status}`)))));

  let text = "";
  const m = msgs?.data?.[0];
  if (m && Array.isArray(m.content)) {
    for (const part of m.content) {
      if (part?.type === "text" && typeof part?.text?.value === "string") {
        text += part.text.value;
      }
    }
  }

  return { ok: true, text };
}

// ---------- Assistants v2 (streaming passthrough) ----------
async function handleStreaming(res, userMessage) {
  // SSE headers to client
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": CORS_ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
  });

  const send = (event, data) => {
    try {
      if (event) res.write(`event: ${event}\n`);
      if (data !== undefined) res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
    } catch {}
  };

  send("start", { ok: true });

  try {
    const base = await fetchAssistantInstructions();
    const instructions = withGroundingPolicy(base);

    // Use the unified streaming endpoint for Assistants:
    // POST /v1/threads/runs with { assistant_id, instructions, additional_messages, stream: true }
    const upstream = await fetch("https://api.openai.com/v1/threads/runs", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "OpenAI-Beta": "assistants=v2",
      },
      body: JSON.stringify({
        assistant_id: OPENAI_ASSISTANT_ID,
        instructions,
        // "additional_messages" lets us avoid a separate thread+message POST
        additional_messages: [{ role: "user", content: userMessage }],
        stream: true
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const errTxt = await upstream.text().catch(() => "");
      send("error", { ok:false, step:"assistants_stream", status: upstream.status, error: errTxt || "no-body" });
      try { res.end(); } catch {}
      return;
    }

    // Pass unified SSE straight through. Your widget already listens for response.output_text.delta etc.
    const reader  = upstream.body.getReader();
    const decoder = new TextDecoder("utf-8");

    // Optional server logging (compact)
    let logBuf = "";
    const maybeLogChunk = (chunkStr) => {
      if (!DEBUG_SSE_LOG) return;
      logBuf += chunkStr;
      const blocks = logBuf.split("\n\n");
      logBuf = blocks.pop() || "";
      for (const block of blocks) {
        const lines = block.split("\n");
        let event = "message";
        for (const line of lines) {
          if (line.startsWith("event:")) { event = line.slice(6).trim(); break; }
        }
        if (event === "response.output_text.delta") {
          // keep logs terse
          const dl = lines.find(l => l.startsWith("data:"));
          if (dl) {
            try {
              const d = JSON.parse(dl.slice(5).trim());
              if (d?.delta) console.log("[assistant][SSE][delta]", String(d.delta).slice(0, 200));
            } catch {}
          }
        } else if (event === "response.completed") {
          console.log("[assistant][SSE] completed");
        } else if (event === "error") {
          console.warn("[assistant][SSE] error", block);
        }
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunkStr = decoder.decode(value, { stream: true });
      try { res.write(chunkStr); } catch {}
      maybeLogChunk(chunkStr);
    }

    send("done", "[DONE]");
    try { res.end(); } catch {}

  } catch (e) {
    send("error", { ok:false, step:"assistants_stream", error: e?.message || String(e) });
    try { res.end(); } catch {}
  }
}

// ---------- Main handler ----------
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return endPreflight(res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok:false, error: "Method Not Allowed" });
  }

  try {
    const body = await readBody(req);
    const userMessage = (body.userMessage || "").toString().trim();
    const mode = (req.query.stream || "off").toString();

    if (!userMessage) {
      return res.status(400).json({ ok:false, error: "Missing userMessage" });
    }

    if (mode === "on") {
      return await handleStreaming(res, userMessage);
    } else {
      const out = await handleNonStreaming(userMessage);
      return res.status(200).json(out);
    }
  } catch (err) {
    console.error("assistant handler error:", err);
    try {
      return res.status(500).json({ ok:false, error: "Internal Server Error" });
    } catch {}
  }
}
