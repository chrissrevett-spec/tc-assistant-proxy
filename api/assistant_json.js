// api/assistant_json.js — always NON-STREAMING, returns { ok, text, thread_id } or a clear error
module.exports = async function (req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  // read JSON body
  try {
    let body = "";
    await new Promise((resolve) => { req.on("data", c => body += c); req.on("end", resolve); });
    const parsed = body ? JSON.parse(body) : {};
    const userMessage = parsed.userMessage;
    const incomingThreadId = parsed.threadId || null;

    if (!userMessage || typeof userMessage !== "string") {
      return res.status(400).json({ ok:false, error: "userMessage (string) required" });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const ASSISTANT_ID   = process.env.ASSISTANT_ID;
    if (!OPENAI_API_KEY || !ASSISTANT_ID) {
      return res.status(500).json({ ok:false, error: "Server not configured (missing env vars)." });
    }

    const H = {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2"
    };
    const U = (p) => `https://api.openai.com/v1${p}`;

    // 1) Thread
    let threadId = incomingThreadId;
    if (!threadId) {
      const tResp = await fetch(U("/threads"), { method:"POST", headers:H, body: JSON.stringify({}) });
      const tJson = await tResp.json();
      if (!tResp.ok) return res.status(tResp.status).json({ ok:false, step:"create_thread", error:tJson });
      threadId = tJson.id;
    }

    // 2) Add message
    const mResp = await fetch(U(`/threads/${threadId}/messages`), {
      method:"POST", headers:H, body: JSON.stringify({ role:"user", content:userMessage })
    });
    const mJson = await mResp.json();
    if (!mResp.ok) return res.status(mResp.status).json({ ok:false, step:"add_message", error:mJson });

    // 3) Create run (non-stream)
    const rResp = await fetch(U(`/threads/${threadId}/runs`), {
      method:"POST", headers:H, body: JSON.stringify({ assistant_id: ASSISTANT_ID })
    });
    const run = await rResp.json();
    if (!rResp.ok) return res.status(rResp.status).json({ ok:false, step:"create_run", error:run });

    // 4) Poll until complete (max ~120s)
    const started = Date.now();
    let status = run.status, runId = run.id;
    while (["queued","in_progress","requires_action"].includes(status)) {
      if (Date.now() - started > 120000) { // 2 minutes
        return res.status(504).json({ ok:false, error:"Timeout waiting for run to complete.", thread_id: threadId, run_id: runId });
      }
      await new Promise(r => setTimeout(r, 800));
      const sResp = await fetch(U(`/threads/${threadId}/runs/${runId}`), { headers:H });
      const sJson = await sResp.json();
      if (!sResp.ok) return res.status(sResp.status).json({ ok:false, step:"get_run", error:sJson });
      status = sJson.status;
    }

    // 5) Read latest assistant message(s)
    const msgsResp = await fetch(U(`/threads/${threadId}/messages`), { headers:H });
    const msgsJson = await msgsResp.json();
    if (!msgsResp.ok) return res.status(msgsResp.status).json({ ok:false, step:"get_messages", error:msgsJson });

    const latestAssistant = (msgsJson.data || []).find(m => m.role === "assistant");
    const text = latestAssistant?.content?.find(c => c.type === "text")?.text?.value || "(no text)";

    return res.status(200).json({ ok:true, thread_id: threadId, text });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
};
