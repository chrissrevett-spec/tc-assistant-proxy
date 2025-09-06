// api/assistant.js - CommonJS style for maximum compatibility on Vercel
module.exports = async function (req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    // Read JSON body safely in Node
    let body = "";
    await new Promise((resolve) => {
      req.on("data", (chunk) => (body += chunk));
      req.on("end", resolve);
    });
    const parsed = body ? JSON.parse(body) : {};
    const userMessage = parsed.userMessage;
    const incomingThreadId = parsed.threadId;

    if (!userMessage || typeof userMessage !== "string") {
      res.status(400).json({ error: "userMessage (string) required" });
      return;
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const ASSISTANT_ID = process.env.ASSISTANT_ID;
    if (!OPENAI_API_KEY || !ASSISTANT_ID) {
      res.status(500).json({ error: "Server not configured. Missing env vars." });
      return;
    }

    // Shared headers for all OpenAI calls (IMPORTANT: Assistants v2 header)
    const oaHeaders = {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2"
    };

    // 1) Create (or reuse) a thread
    let threadId = incomingThreadId;
    if (!threadId) {
      const t = await fetch("https://api.openai.com/v1/threads", {
        method: "POST",
        headers: oaHeaders,
        body: JSON.stringify({})
      }).then((r) => r.json());
      threadId = t.id;
    }

    // 2) Add the user message
    await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      method: "POST",
      headers: oaHeaders,
      body: JSON.stringify({ role: "user", content: userMessage })
    });

    // 3) Start a Run with streaming
    const runResp = await fetch(
      `https://api.openai.com/v1/threads/${threadId}/runs`,
      {
        method: "POST",
        headers: oaHeaders,
        body: JSON.stringify({ assistant_id: ASSISTANT_ID, stream: true })
      }
    );

    // Prepare to stream the SSE back to the browser
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Send thread id first so the client can store it
    res.write(`data: ${JSON.stringify({ thread_id: threadId })}\n\n`);

    const reader = runResp.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value)); // already SSE-formatted from OpenAI
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Proxy error", detail: String(e?.message || e) });
  }
};

