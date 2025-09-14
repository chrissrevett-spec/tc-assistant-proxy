// api/assistant.js
//
// One endpoint, two modes using the OpenAI "Responses" API:
//
//  • Non-streaming  : POST /api/assistant?stream=off  -> JSON { ok, text, usage }
//  • Streaming (SSE): POST /api/assistant?stream=on   -> raw SSE forwarded as-is
//
// Now with dynamic system instructions fetched from an OpenAI Assistant:
// - Set OPENAI_ASSISTANT_ID in your env (already present).
// - We fetch /v1/assistants/{id} and inject assistant.instructions into the
//   Responses "system" role. Cached in memory for a short TTL.

const OPENAI_API_KEY        = process.env.OPENAI_API_KEY;
const OPENAI_MODEL          = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CORS_ALLOW_ORIGIN     = process.env.CORS_ALLOW_ORIGIN || "https://www.talkingcare.uk";
const OPENAI_ASSISTANT_ID   = process.env.OPENAI_ASSISTANT_ID || ""; // dynamic source of instructions
const ASSISTANT_CACHE_TTLMS = 5 * 60 * 1000; // 5 minutes

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
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

// ---------- OpenAI helpers ----------
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

// ---------- Assistant instructions cache ----------
let _assistantCache = {
  id: null,
  instructions: "",
  fetchedAt: 0,
};

async function fetchAssistantInstructions() {
  if (!OPENAI_ASSISTANT_ID) {
    return ""; // no assistant configured; use empty/default system later
  }

  const now = Date.now();
  if (
    _assistantCache.id === OPENAI_ASSISTANT_ID &&
    now - _assistantCache.fetchedAt < ASSISTANT_CACHE_TTLMS
  ) {
    return _assistantCache.instructions || "";
  }

  // Fetch latest assistant
  const r = await fetch(`https://api.openai.com/v1/assistants/${OPENAI_ASSISTANT_ID}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
  });

  if (!r.ok) {
    const errTxt = await r.text().catch(() => "");
    console.warn(`GET /assistants/${OPENAI_ASSISTANT_ID} failed: ${r.status} ${errTxt}`);
    // Keep old cache if present; otherwise return empty
    return _assistantCache.instructions || "";
  }

  const data = await r.json().catch(() => null);
  const instr = (data && data.instructions) ? String(data.instructions) : "";

  _assistantCache = {
    id: OPENAI_ASSISTANT_ID,
    instructions: instr,
    fetchedAt: now,
  };

  return instr;
}

// Build a Responses API request payload
function buildResponsesRequest(userMessage, systemInstructions, opts = {}) {
  // Final system content: prefer Assistant instructions; fallback to a tiny default
  const systemPreamble =
    (systemInstructions && systemInstructions.trim()) ||
    "You are Talking Care Navigator. Be concise, practical, and cite official UK guidance at the end.";

  return {
    model: OPENAI_MODEL,
    input: [
      { role: "system", content: systemPreamble },
      { role: "user",   content: userMessage }
    ],
    ...opts,
  };
}

// ---------- Non-streaming path (Responses API without SSE) ----------
async function handleNonStreaming(userMessage, systemInstructions) {
  const payload = buildResponsesRequest(userMessage, systemInstructions, { stream: false });
  const resp = await oaJson("/responses", "POST", payload);

  // Extract plain text from resp.output
  let text = "";
  if (resp && Array.isArray(resp.output)) {
    for (const item of resp.output) {
      if (item.type === "output_text" && typeof item.text === "string") {
        text += item.text;
      }
    }
  }

  const usage = resp?.usage || null;
  return { ok: true, text, usage };
}

// ---------- Streaming path (Responses API SSE) ----------
async function handleStreaming(res, userMessage, systemInstructions) {
  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    // CORS mirrored for stream
    "Access-Control-Allow-Origin": CORS_ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
  });

  const forward = (event, data) => {
    try {
      if (event) res.write(`event: ${event}\n`);
      if (data !== undefined) {
        res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
      }
    } catch { /* broken pipe */ }
  };

  // Optional “start” event
  forward("start", { ok: true });

  // Fire upstream SSE
  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    },
    body: JSON.stringify(buildResponsesRequest(userMessage, systemInstructions, { stream: true })),
  });

  if (!upstream.ok || !upstream.body) {
    const errTxt = await upstream.text().catch(() => "");
    forward("error", { ok: false, step: "responses_stream", error: errTxt || upstream.status });
    try { res.end(); } catch {}
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder("utf-8");

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      res.write(chunk); // forward raw SSE
    }
  } catch {
    // client aborted / network hiccup
  } finally {
    forward("done", "[DONE]");
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

    // Fetch dynamic system instructions (cached)
    const systemInstructions = await fetchAssistantInstructions();
    // Short log so you can verify which instructions are used
    const preview = (systemInstructions || "").slice(0, 120).replace(/\s+/g, " ");
    console.log(`Using system instructions (preview): "${preview}${systemInstructions.length > 120 ? '…' : ''}"`);

    if (mode === "on") {
      return await handleStreaming(res, userMessage, systemInstructions);
    } else {
      const out = await handleNonStreaming(userMessage, systemInstructions);
      return res.status(200).json(out);
    }
  } catch (err) {
    console.error("assistant handler error:", err);
    try {
      return res.status(500).json({ ok: false, error: "Internal Server Error" });
    } catch {}
  }
}
