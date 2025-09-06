// api/assistant_json.js — NON-STREAMING + CORS
module.exports = async function (req, res) {
  // --- CORS ---
  const ORIGIN = req.headers.origin || "*"; // you can hardcode your site later
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Vary", "Origin"); // allow per-origin responses
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-vercel-protection-bypass");
  res.setHeader("Access-Control-Max-Age", "86400"); // cache preflight for 1 day

  if (req.method === "OPTIONS") {
    res.status(204).end(); // preflight OK
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method Not Allowed" });
    return;
  }

  try {
    // read JSON body
    let body = "";
    await new Promise((resolve) => { req.on("data", c => body += c); req.on("end", resolve); });
    const { userMessage, threadId: incomingThreadId } = body ? JSON.parse(body) : {};

    if (!userMessage || typeof userMessage !== "string") {
      res.status(400).json({ ok:false, error:"userMessage (string) required" });
      return;
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const ASSISTANT_ID   = process.env.ASSISTANT_ID;
    if (!OPENAI_API_KEY || !ASSISTANT_ID) {
      res.status(500).json({ ok:false, error:"Server not configured (missing env vars)." });
      return;
    }

    const H = {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2"
    };
    const U = (p) => `https://api.openai.com/v1${p}`;

    // 1) Thread
    let threadId = incomingThreadId || null;
    if (!threadId) {
      const tResp = await fetch(U("/threads"), { method:"POST", headers:H, body: JSON.stringify({}) });
      const tJson = await tResp.json();
      if (!tResp.ok) { res.status(tResp.status).json({ ok:false, step:"create_thread", error:tJson }); return; }
      threadId = tJson.id;
    }

    // 2) Add message
    const mResp = await fetch(U(`/threads/${threadId}/messages`), {
      method:"POST", headers:H, body: JSON.stringify({ role:"user", content:userMessage })
    });
    const mJson = await mResp.json();
    if (!mResp.ok) { res.status(mResp.status).json({ ok:false, step:"add_message", error:mJson }); return; }

    // 3) Create run (non-stream)
    const rResp = await fetch(U(`/threads/${threadId}/runs`), {
      method:"POST", headers:H, body: JSON.stringify({ assistant_id: ASSISTANT_ID })
    });
    const run = await rResp.json();
    if (!rResp.ok) { res.status(rResp.status).json({ ok:false, step:"create_run", error:run }); return; }

    // 4) Poll until complete (max 120s)
    const started = Date.now();
    let status = run.status, runId = run.id;
    while (["queued","in_progress","requires_action"].includes(status)) {
      if (Date.now() - started > 120000) {
        res.status(504).json({ ok:false, error:"Timeout waiting for run to complete.", thread_id: threadId, run_id: runId });
        return;
      }
      await new Promise(r => setTimeout(r, 800));
      const sResp = await fetch(U(`/threads/${threadId}/runs/${runId}`), { headers:H });
      const sJson = await sResp.json();
      if (!sResp.ok) { res.status(sResp.status).json({ ok:false, step:"get_run", error:sJson }); return; }
      status = sJson.status;
    }

    // 5) Read latest assistant message(s)
    const msgsResp = await fetch(U(`/threads/${threadId}/messages`), { headers:H });
    const msgsJson = await msgsResp.json();
    if (!msgsResp.ok) { res.status(msgsResp.status).json({ ok:false, step:"get_messages", error:msgsJson }); return; }

    const latestAssistant = (msgsJson.data || []).find(m => m.role === "assistant");
    const text = latestAssistant?.content?.find(c => c.type === "text")?.text?.value || "(no text)";

    res.status(200).json({ ok:true, thread_id: threadId, text });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
};
