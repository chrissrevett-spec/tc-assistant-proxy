// api/assistant.js
// Vercel Node function (runtime: "nodejs") implementing Assistants v2 with:
// - Non-streaming JSON responses
// - Streaming via SSE (server proxies OpenAI runs/{run_id}/events)
// - Busy-run guard (cancel active run before adding a new message)
// - Friendly citations (no raw file IDs)
// - CORS that matches your Squarespace origin

// ---------- Config ----------
const REQUIRED_ENV = ["OPENAI_API_KEY", "OPENAI_ASSISTANT_ID"];
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    // Don't throw synchronously in serverless — just log.
    console.warn(`[assistant] Missing env ${k}`);
  }
}
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || "";
const CORS_ALLOW_ORIGIN =
  process.env.CORS_ALLOW_ORIGIN || "https://www.talkingcare.uk";

// ---------- Utilities ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function endPreflight(res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: true }));
}

function bad(res, code, msg) {
  res.status(code).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: false, error: msg }));
}

async function oaJson(path, opts = {}) {
  const url = `https://api.openai.com${path}`;
  const r = await fetch(url, {
    method: opts.method || "GET",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      // CRITICAL for Assistants v2:
      "OpenAI-Beta": "assistants=v2",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(
      `${opts.method || "GET"} ${url} failed: ${r.status} ${t || r.statusText}`
    );
  }
  if (r.status === 204) return null;
  return r.json();
}

// Get latest run; returns null if none
async function getLatestRun(threadId) {
  const data = await oaJson(
    `/v1/threads/${threadId}/runs?order=desc&limit=1`,
    { method: "GET" }
  );
  const run = (data && data.data && data.data[0]) || null;
  return run;
}

function isRunActive(status) {
  return ["queued", "in_progress", "requires_action", "cancelling"].includes(
    status
  );
}

// Cancel active run if needed; wait until terminal or timeout
async function ensureThreadIdle(threadId, timeoutMs = 8000) {
  const start = Date.now();
  let latest = await getLatestRun(threadId);
  if (!latest || !isRunActive(latest.status)) return;

  // Try cancel once
  try {
    await oaJson(
      `/v1/threads/${threadId}/runs/${latest.id}/cancel`,
      { method: "POST" }
    );
  } catch {
    // ignore cancel errors; we'll still wait a bit
  }

  // Poll until finished or timeout
  while (Date.now() - start < timeoutMs) {
    await sleep(500);
    latest = await getLatestRun(threadId);
    if (!latest || !isRunActive(latest.status)) return;
  }
  // If still active, let the call continue — OpenAI will reject adding message; client will show friendly error.
}

// Extract assistant text + file citations from the latest assistant message
function pickAssistantMessageTextAndCites(messagesList) {
  // The list endpoint returns most-recent first; find first assistant message
  const msg = (messagesList.data || []).find((m) => m.role === "assistant");
  if (!msg) return { text: "", cites: [] };

  let text = "";
  const cites = [];

  for (const part of msg.content || []) {
    if (part.type === "text" && part.text?.value) {
      text += part.text.value;
      // Collect annotations -> file citations/urls/file_paths
      for (const ann of part.text.annotations || []) {
        if (ann?.url) {
          cites.push({ type: "url", url: ann.url });
        } else if (ann?.file_path?.file_id) {
          // Hide raw file IDs — show a generic label
          cites.push({
            type: "file_path",
            label: "document",
            path: ann.file_path.path || "",
          });
        } else if (ann?.file_citation?.file_id) {
          // Hide raw file IDs — show a generic label
          cites.push({
            type: "file",
            label: "document",
          });
        }
      }
    }
  }

  // Deduplicate identical citations
  const seen = new Set();
  const unique = [];
  for (const c of cites) {
    const key =
      c.type === "url" ? `url:${c.url}` :
      c.type === "file_path" ? `fp:${c.path}` :
      `f:document`;
    if (!seen.has(key)) { seen.add(key); unique.push(c); }
  }

  return { text: text || "", cites: unique };
}

// ---------- Handler ----------
export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return endPreflight(res);
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return bad(res, 405, "Method Not Allowed");
  }

  // Parse input
  let body = {};
  try {
    body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  } catch {
    return bad(res, 400, "Invalid JSON body");
  }

  const userMessage = (body.userMessage || "").toString();
  let threadId = body.threadId || null;
  const streamOff = (req.query?.stream === "off");

  if (!OPENAI_API_KEY || !ASSISTANT_ID) {
    return bad(res, 500, "Server misconfigured: missing OPENAI envs");
  }
  if (!userMessage) {
    return bad(res, 400, "Missing userMessage");
  }

  // ----- Ensure thread -----
  if (!threadId) {
    const t = await oaJson(`/v1/threads`, { method: "POST", body: {} });
    threadId = t.id;
  }

  // Ensure no active run before adding a new message
  try {
    await ensureThreadIdle(threadId);
  } catch (e) {
    console.warn("[assistant] ensureThreadIdle error:", e?.message || e);
    // continue; we'll attempt message add and surface a good error if it fails
  }

  // Add user message to the thread
  try {
    await oaJson(`/v1/threads/${threadId}/messages`, {
      method: "POST",
      body: { role: "user", content: userMessage },
    });
  } catch (e) {
    // Typical case: "Can't add messages … while a run is active." — try one more idle pass then retry once
    const msg = String(e.message || "");
    if (msg.includes("while a run") || msg.includes("active")) {
      try {
        await ensureThreadIdle(threadId, 6000);
        await oaJson(`/v1/threads/${threadId}/messages`, {
          method: "POST",
          body: { role: "user", content: userMessage },
        });
      } catch (e2) {
        console.error("add message failed after retry:", e2?.message || e2);
        return bad(res, 500, "Thread is busy, please try again.");
      }
    } else {
      console.error("add message failed:", e?.message || e);
      return bad(res, 500, "Failed to add message.");
    }
  }

  // ----- STREAMING PATH (SSE proxy) -----
  if (!streamOff) {
    // Create run
    let run;
    try {
      run = await oaJson(`/v1/threads/${threadId}/runs`, {
        method: "POST",
        body: { assistant_id: ASSISTANT_ID },
      });
    } catch (e) {
      console.error("create run failed:", e?.message || e);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
      });
      res.write(`event: start\n`);
      res.write(`data: ${JSON.stringify({ ok: true, thread_id: threadId })}\n\n`);
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ ok: false, step: "create_run", error: String(e.message || e) })}\n\n`);
      res.write(`event: done\n`);
      res.write(`data: [DONE]\n\n`);
      return res.end();
    }

    // OpenAI SSE events stream for this run
    const eventsUrl = `https://api.openai.com/v1/threads/${threadId}/runs/${run.id}/events`;

    // Send initial headers to client
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: start\n`);
    res.write(`data: ${JSON.stringify({ ok: true, thread_id: threadId, run_id: run.id })}\n\n`);

    try {
      const upstream = await fetch(eventsUrl, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2",
          "Accept": "text/event-stream",
        },
      });

      if (!upstream.ok || !upstream.body) {
        const t = await upstream.text().catch(() => upstream.statusText);
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ ok:false, step:"create_run_stream", error:`runs/events failed: ${upstream.status} ${t}` })}\n\n`);
        res.write(`event: done\n`);
        res.write(`data: [DONE]\n\n`);
        return res.end();
      }

      // Pipe OpenAI SSE to client verbatim (do not rewrite event names)
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder("utf-8");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
    } catch (e) {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ ok:false, step:"create_run_stream", error:String(e.message || e) })}\n\n`);
    } finally {
      res.write(`event: done\n`);
      res.write(`data: [DONE]\n\n`);
      res.end();
    }
    return;
  }

  // ----- NON-STREAMING PATH -----
  // Create run and poll until completed
  let run;
  try {
    run = await oaJson(`/v1/threads/${threadId}/runs`, {
      method: "POST",
      body: { assistant_id: ASSISTANT_ID },
    });
  } catch (e) {
    console.error("create run (non-stream) failed:", e?.message || e);
    return bad(res, 500, "Failed to start run.");
  }

  // Poll the run status
  const deadline = Date.now() + 60_000; // 60s cap
  let status = run.status;
  while (["queued", "in_progress", "requires_action"].includes(status)) {
    if (Date.now() > deadline) {
      // Try to cancel and abort
      try {
        await oaJson(`/v1/threads/${threadId}/runs/${run.id}/cancel`, { method: "POST" });
      } catch {}
      return bad(res, 504, "Run timed out.");
    }
    await sleep(600);
    const r = await oaJson(`/v1/threads/${threadId}/runs/${run.id}`, { method: "GET" });
    status = r.status;
  }

  if (status !== "completed") {
    return bad(res, 500, `Run ended with status: ${status}`);
  }

  // Read the thread messages and extract the assistant reply + citations
  const msgs = await oaJson(`/v1/threads/${threadId}/messages?order=desc&limit=10`, {
    method: "GET",
  });
  const { text, cites } = pickAssistantMessageTextAndCites(msgs);

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).end(JSON.stringify({
    ok: true,
    text: text || "(no text returned)",
    thread_id: threadId,
    citations: cites,   // clean, user-friendly
    usage: null,        // can be wired if you log run usage separately
  }));
}
