// api/assistant.js
//
// One endpoint, two modes using the OpenAI "Responses" API:
//
//  • Non-streaming  : POST /api/assistant?stream=off  -> JSON { ok, text, usage }
//  • Streaming (SSE): POST /api/assistant?stream=on   -> raw SSE forwarded as-is
//
// Key fixes in this version:
// - Uses a Responses-capable model (from env) and rejects 3.5-turbo*.
// - Clean SSE passthrough (no buffering), robust CORS once, no double headers.
// - Accepts Squarespace/Firefox text/plain and JSON bodies.
// - No dependence on Assistants/threads/runs -> no run_id 404s/hangs.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CORS_ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN || "https://tc-assistant-proxy.vercel.app";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
}
if (/^gpt-3\.5-turbo/i.test(OPENAI_MODEL || "")) {
  console.error(
    `OPENAI_MODEL='${OPENAI_MODEL}' is not compatible with the Responses API stream events. ` +
    `Set OPENAI_MODEL=gpt-4o-mini (recommended) or gpt-4o.`
  );
}

// ---------- CORS ----------
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
}
function endPreflight(res) {
  res.statusCode = 204;
  res.end();
}

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

// ---------- OpenAI helper ----------
async function oaJson(path, method, body) {
  const r = await fetch(`https://api.openai.com/v1${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const errTxt = await r.text().catch(() => "");
    throw new Error(`${method} ${path} failed: ${r.status} ${errTxt}`);
  }
  return r.json();
}

function buildResponsesRequest(userMessage, opts = {}) {
  const systemPreamble =
    "You are Talking Care Navigator. Be concise, practical, UK-focused, and cite official guidance at the end.";

  return {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: systemPreamble },
      { role: "user",   content: userMessage }
    ],
    // You can add: temperature, max_output_tokens, response_format, etc.
    ...opts,
  };
}

// ---------- Non-streaming ----------
async function handleNonStreaming(userMessage) {
  const payload = buildResponsesRequest(userMessage, { stream: false });
  const resp = await oaJson("/responses", "POST", payload);

  let text = "";
  if (resp && Array.isArray(resp.output)) {
    for (const part of resp.output) {
      if (part?.type === "output_text" && typeof part.text === "string") {
        text += part.text;
      }
    }
  }
  const usage = resp?.usage || null;
  return { ok: true, text, usage };
}

// ---------- Streaming ----------
async function handleStreaming(res, userMessage) {
  // Start SSE immediately (avoid buffering)
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": CORS_ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
  });

  const forwardRaw = (chunk) => { try { res.write(chunk); } catch {} };
  const emit = (event, data) => {
    try {
      if (event) res.write(`event: ${event}\n`);
      if (data !== undefined) res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
    } catch {}
  };

  emit("start", { ok: true });

  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    },
    body: JSON.stringify(buildResponsesRequest(userMessage, { stream: true })),
  });

  if (!upstream.ok || !upstream.body) {
    const errTxt = await upstream.text().catch(() => "");
    emit("error", { ok: false, step: "responses_stream", error: errTxt || upstream.status });
    try { res.end(); } catch {}
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8");

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // Forward OpenAI SSE bytes unmodified. The client expects
      // events like `response.output_text.delta`, `response.completed`, etc.
      forwardRaw(decoder.decode(value, { stream: true }));
    }
  } catch {
    // client aborted / network blip
  } finally {
    emit("done", "[DONE]");
    try { res.end(); } catch {}
  }
}

// ---------- Main handler ----------
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return endPreflight(res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const body = await readBody(req);
    const userMessage = (body.userMessage || "").toString().trim();
    const mode = (req.query.stream || "off").toString(); // "on" | "off"

    if (!userMessage) {
      return res.status(400).json({ ok: false, error: "Missing userMessage" });
    }

    if (/^gpt-3\.5-turbo/i.test(OPENAI_MODEL || "")) {
      return res.status(400).json({
        ok: false,
        error: `Model '${OPENAI_MODEL}' is not compatible with Responses streaming. Use gpt-4o-mini or gpt-4o.`,
      });
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
      return res.status(500).json({ ok: false, error: "Internal Server Error" });
    } catch {}
  }
}
