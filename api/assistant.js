// Runtime: Node on Vercel
export const config = { runtime: "nodejs" };

/**
 * ENV you MUST set at the Vercel project level (Project Settings → Environment Variables):
 *  - OPENAI_API_KEY         (required)
 *  - OPENAI_ASSISTANT_ID    (required) your assistants v2 assistant id, e.g. asst_XXXX
 *
 * Optional (if you want to restrict CORS to your prod site only):
 *  - ALLOW_ORIGIN=https://www.talkingcare.uk
 */

const PROD_ORIGIN = process.env.ALLOW_ORIGIN || "https://www.talkingcare.uk";
const ALLOWED_METHODS = "GET, POST, OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Accept";
const MAX_AGE = "86400";

function setCors(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
  res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
  res.setHeader("Access-Control-Max-Age", MAX_AGE);
}

function endPreflight(res) {
  res.statusCode = 204;
  res.end();
}

function bad(res, code, msg, extra = null) {
  res.status(code).json({ ok: false, error: msg, ...(extra ? { detail: extra } : {}) });
}

async function readJsonBody(req) {
  try {
    if (typeof req.body === "string") return JSON.parse(req.body || "{}");
    if (req.body && typeof req.body === "object") return req.body;
    // Manually read if body parsing is not applied
    const buf = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
    return buf.length ? JSON.parse(buf.toString("utf-8")) : {};
  } catch {
    return {};
  }
}

async function pollRunUntilTerminal(openaiKey, threadId, runId) {
  const headers = {
    "Authorization": `Bearer ${openaiKey}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "assistants=v2",
  };

  // Poll runs/{id}
  for (;;) {
    const r = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, { headers });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`pollRun failed: ${r.status} ${t}`);
    }
    const run = await r.json();
    if (["completed", "failed", "cancelled", "expired"].includes(run.status)) return run;
    await new Promise(r => setTimeout(r, 700));
  }
}

async function listLatestAssistantMessage(openaiKey, threadId) {
  const headers = {
    "Authorization": `Bearer ${openaiKey}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "assistants=v2",
  };

  // We want the most recent assistant message
  const r = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages?order=desc&limit=10`, { headers });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`listMessages failed: ${r.status} ${t}`);
  }
  const data = await r.json();
  const msg = (data?.data || []).find(m => m.role === "assistant");
  if (!msg) return { text: "", citations: [] };

  // Extract text + citations
  let outText = "";
  const cites = [];
  for (const c of msg.content || []) {
    if (c.type === "text") {
      outText += c.text?.value || "";
      const anns = c.text?.annotations || [];
      for (const a of anns) {
        if (a?.file_citation?.file_id) cites.push({ type: "file", file_id: a.file_citation.file_id });
        if (a?.file_path?.file_id) cites.push({ type: "file_path", file_id: a.file_path.file_id, path: a.file_path.path || null });
        if (a?.url) cites.push({ type: "url", url: a.url });
      }
    }
  }
  return { text: outText, citations: cites };
}

export default async function handler(req, res) {
  const origin = req.headers.origin || PROD_ORIGIN;
  setCors(res, origin);

  if (req.method === "OPTIONS") return endPreflight(res);
  if (!["POST"].includes(req.method)) {
    res.setHeader("Allow", "POST, OPTIONS");
    return bad(res, 405, "Method Not Allowed");
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
  const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || "";

  if (!OPENAI_API_KEY) return bad(res, 500, "Missing OPENAI_API_KEY");
  if (!OPENAI_ASSISTANT_ID) return bad(res, 500, "Missing OPENAI_ASSISTANT_ID");

  try {
    const body = await readJsonBody(req);
    const userMessage = (body.userMessage || "").toString();
    let threadId = body.threadId || null;
    const streamMode = (req.query?.stream || "").toString() !== "off";

    if (!userMessage) return bad(res, 400, "Missing userMessage");

    // 1) Create thread if none
    if (!threadId) {
      const r = await fetch("https://api.openai.com/v1/threads", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "OpenAI-Beta": "assistants=v2",
        },
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return bad(res, 502, "create_thread_failed", t);
      }
      const data = await r.json();
      threadId = data.id;
    }

    // 2) Add the user message to the thread
    {
      const r = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
          "OpenAI-Beta": "assistants=v2",
        },
        body: JSON.stringify({ role: "user", content: userMessage }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        // Busy-run guard
        if (t.includes("active run")) return bad(res, 409, "thread_busy_retry");
        return bad(res, 502, "add_message_failed", t);
      }
    }

    // 3) STREAMING path (SSE directly from OpenAI)
    if (streamMode) {
      // Important: return SSE headers to client first
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": ALLOWED_METHODS,
        "Access-Control-Allow-Headers": ALLOWED_HEADERS,
      });

      const send = (event, data) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
      };

      // Start event for your UI
      send("start", { ok: true, thread_id: threadId });

      // 3a) OpenAI run with stream=true
      const openaiResp = await fetch(
        `https://api.openai.com/v1/threads/${threadId}/runs/stream`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
            "OpenAI-Beta": "assistants=v2",
          },
          body: JSON.stringify({
            assistant_id: OPENAI_ASSISTANT_ID,
            // You can also include instructions or metadata here if you want
          }),
        }
      );

      if (!openaiResp.ok || !openaiResp.body) {
        const text = await openaiResp.text().catch(() => "");
        send("error", { ok: false, step: "create_run_stream", error: text || `HTTP ${openaiResp.status}` });
        send("done", "[DONE]");
        res.end();
        return;
      }

      // 3b) Pipe OpenAI SSE to your client, remapping only event names that your UI expects
      const reader = openaiResp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() || "";

          for (const chunk of chunks) {
            const lines = chunk.split("\n");
            let event = null;
            let data = "";
            for (const line of lines) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (!event) continue;

            // Pass through most events as-is; your page already handles
            // thread.message.delta and thread.run.completed etc.
            // If you want to cohere names, you can map some:
            // Example: event 'thread.message.delta' → keep same.
            // We’ll just forward.
            send(event, data === "" ? "{}" : data);
          }
        }
      } catch (e) {
        send("error", { ok: false, error: "stream_broken" });
      }

      // 3c) Finalise
      send("done", "[DONE]");
      res.end();
      return;
    }

    // 4) NON-STREAMING (poll until completed, then return last assistant message)
    const createRun = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2",
      },
      body: JSON.stringify({ assistant_id: OPENAI_ASSISTANT_ID }),
    });
    if (!createRun.ok) {
      const t = await createRun.text().catch(() => "");
      if (t.includes("active run")) return bad(res, 409, "thread_busy_retry");
      return bad(res, 502, "create_run_failed", t);
    }
    const run = await createRun.json();

    const terminal = await pollRunUntilTerminal(OPENAI_API_KEY, threadId, run.id);
    if (terminal.status !== "completed") {
      return bad(res, 502, "run_not_completed", terminal.status);
    }

    const { text, citations } = await listLatestAssistantMessage(OPENAI_API_KEY, threadId);

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      ok: true,
      text,
      citations,
      thread_id: threadId,
      usage: null, // (optional) you can call /runs/{id} usage if you need token stats
    });
  } catch (err) {
    console.error("assistant error:", err);
    return bad(res, 500, "internal_error");
  }
}
