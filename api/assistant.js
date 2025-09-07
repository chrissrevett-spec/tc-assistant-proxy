// api/assistant.js — STREAMING SSE proxy for OpenAI Assistants v2
// Branding: "Talking Care Navigator" (by Talking Care)
// CORS enabled. Falls back to non-streaming if SSE is unavailable.

module.exports = async function (req, res) {
  /* ---------- CORS ---------- */
  const ORIGIN = req.headers.origin || "*"; // tighten later to your domains
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-vercel-protection-bypass");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    /* ---------- Read JSON body ---------- */
    let raw = "";
    await new Promise(r => { req.on("data", c => raw += c); req.on("end", r); });
    const { userMessage, threadId: incomingThreadId } = raw ? JSON.parse(raw) : {};

    if (!userMessage || typeof userMessage !== "string") {
      res.status(400).json({ ok:false, error:"userMessage (string) required" });
      return;
    }

    /* ---------- Env ---------- */
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;  // set in Vercel
    const ASSISTANT_ID   = process.env.ASSISTANT_ID;    // asst_...
    if (!OPENAI_API_KEY || !ASSISTANT_ID) {
      res.status(500).json({ ok:false, error:"Server not configured (missing env vars)." });
      return;
    }

    /* ---------- OpenAI helpers ---------- */
    const H = {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2"
    };
    const U = p => `https://api.openai.com/v1${p}`;

    /* ---------- Branding/system guardrails ---------- */
    const BRAND_INSTRUCTIONS =
      "You are Talking Care Navigator, created by Talking Care. " +
      "Always introduce yourself as Talking Care Navigator. " +
      "Answer specifically for adult social care in England. " +
      "Prioritise official UK sources (CQC, DHSC, GOV.UK, NICE, SCIE, MCA Code of Practice). " +
      "Be precise, practical, inspection-ready (minimum vs best practice where relevant). " +
      "If legislation/guidance is unclear or context-dependent, say so and give the safest compliance position. " +
      "When appropriate, end with a short list of sources/citations. " +
      "Close with: 'For human support, contact hello@talkingcare.uk' when helpful.";

    /* ---------- 1) Ensure a thread ---------- */
    let threadId = incomingThreadId || null;
    if (!threadId) {
      const tR = await fetch(U("/threads"), { method:"POST", headers:H, body:"{}" });
      const tJ = await tR.json();
      if (!tR.ok) { res.status(tR.status).json({ ok:false, step:"create_thread", error:tJ }); return; }
      threadId = tJ.id;
    }

    /* ---------- 2) Add the user message ---------- */
    const mR = await fetch(U(`/threads/${threadId}/messages`), {
      method:"POST", headers:H,
      body: JSON.stringify({ role:"user", content:userMessage })
    });
    const mJ = await mR.json();
    if (!mR.ok) { res.status(mR.status).json({ ok:false, step:"add_message", error:mJ }); return; }

    /* ---------- 3) Try to stream the run via SSE ---------- */
    // We attempt: POST /threads/{threadId}/runs?stream=true  (SSE)
    let sseResp = await fetch(U(`/threads/${threadId}/runs?stream=true`), {
      method:"POST", headers:H,
      body: JSON.stringify({ assistant_id: ASSISTANT_ID, instructions: BRAND_INSTRUCTIONS })
    });

    if (sseResp.ok && sseResp.headers.get("content-type")?.includes("text/event-stream")) {
      // Prepare our SSE response to the browser
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        // Allow browsers to keep connection open
        "X-Accel-Buffering": "no"
      });

      // Keep-alive ping every 20s
      const keepAlive = setInterval(() => {
        try { res.write(": keep-alive\n\n"); } catch (_) {}
      }, 20000);

      try {
        // Pipe OpenAI's SSE stream directly to the client
        const reader = sseResp.body.getReader();
        const decoder = new TextDecoder("utf-8");
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            const chunk = decoder.decode(value, { stream: true });
            // Relay exactly as we receive (already SSE formatted)
            res.write(chunk);
          }
        }
        // Finish
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (e) {
        // On stream error, end connection
        try { res.write(`event: error\ndata: ${JSON.stringify({ message: String(e) })}\n\n`); } catch (_) {}
        try { res.end(); } catch (_) {}
      } finally {
        clearInterval(keepAlive);
      }
      return;
    }

    /* ---------- 4) Fallback: non-streaming poll + one-shot JSON ---------- */
    // If we got here, streaming wasn't available; make a normal run and poll
    const rR = await fetch(U(`/threads/${threadId}/runs`), {
      method:"POST", headers:H,
      body: JSON.stringify({ assistant_id: ASSISTANT_ID, instructions: BRAND_INSTRUCTIONS })
    });
    const run = await rR.json();
    if (!rR.ok) { res.status(rR.status).json({ ok:false, step:"create_run", error:run }); return; }

    const started = Date.now();
    let status = run.status, runId = run.id;
    while (["queued","in_progress","requires_action"].includes(status)) {
      if (Date.now() - started > 120000) { // 2 minutes
        res.status(504).json({ ok:false, error:"Timeout waiting for run.", thread_id: threadId, run_id: runId });
        return;
      }
      await new Promise(r => setTimeout(r, 800));
      const sR = await fetch(U(`/threads/${threadId}/runs/${runId}`), { headers:H });
      const sJ = await sR.json();
      if (!sR.ok) { res.status(sR.status).json({ ok:false, step:"get_run", error:sJ }); return; }
      status = sJ.status;
    }

    // Get messages and return the last assistant text as a plain JSON (not SSE)
    const gR = await fetch(U(`/threads/${threadId}/messages?order=desc&limit=5`), { headers:H });
    const gJ = await gR.json();
    if (!gR.ok) { res.status(gR.status).json({ ok:false, step:"get_messages", error:gJ }); return; }

    const assistantMsg = (gJ.data || []).find(m => m.role === "assistant");
    const text = assistantMsg?.content?.find(c => c.type === "text")?.text?.value || "(no text)";
    res.status(200).json({ ok:true, thread_id: threadId, text });

  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
};
