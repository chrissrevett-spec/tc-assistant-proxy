// api/assistant_json.js — NON-STREAMING + CORS + citations + usage
// Branding: Always introduces/responds as "Talking Care GPT" (by Talking Care)

module.exports = async function (req, res) {
  // --- CORS (tighten to your domains later if you wish) ---
  const ORIGIN = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-vercel-protection-bypass");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"Method Not Allowed" });

  try {
    // read JSON body
    let raw = "";
    await new Promise(r => { req.on("data", c => raw += c); req.on("end", r); });
    const { userMessage, threadId: incomingThreadId } = raw ? JSON.parse(raw) : {};

    if (!userMessage || typeof userMessage !== "string") {
      return res.status(400).json({ ok:false, error:"userMessage (string) required" });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const ASSISTANT_ID   = process.env.ASSISTANT_ID; // asst_...
    if (!OPENAI_API_KEY || !ASSISTANT_ID) {
      return res.status(500).json({ ok:false, error:"Server not configured (missing env vars)." });
    }

    // Shared helpers
    const H = {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2"
    };
    const U = p => `https://api.openai.com/v1${p}`;

    // Brand/system guardrails for every run
    const BRAND_INSTRUCTIONS =
      "You are Talking Care GPT, created by Talking Care. " +
      "Always refer to yourself as Talking Care GPT. " +
      "Answer specifically for adult social care in England. " +
      "Prioritise official UK sources (CQC, DHSC, GOV.UK, NICE, SCIE, MCA Code). " +
      "Be precise, practical, and inspection-ready. " +
      "If legislation/guidance is unclear, say so and state the safest compliance position. " +
      "End with a short list of sources/citations.";

    // 1) Create or reuse thread
    let threadId = incomingThreadId || null;
    if (!threadId) {
      const tR = await fetch(U("/threads"), { method:"POST", headers:H, body: "{}" });
      const tJ = await tR.json();
      if (!tR.ok) return res.status(tR.status).json({ ok:false, step:"create_thread", error:tJ });
      threadId = tJ.id;
    }

    // 2) Add user message (as a user message)
    const mR = await fetch(U(`/threads/${threadId}/messages`), {
      method:"POST", headers:H,
      body: JSON.stringify({ role:"user", content: userMessage })
    });
    const mJ = await mR.json();
    if (!mR.ok) return res.status(mR.status).json({ ok:false, step:"add_message", error:mJ });

    // 3) Create run (non-stream) with brand/system instructions
    const rR = await fetch(U(`/threads/${threadId}/runs`), {
      method:"POST", headers:H,
      body: JSON.stringify({ assistant_id: ASSISTANT_ID, instructions: BRAND_INSTRUCTIONS })
    });
    const run = await rR.json();
    if (!rR.ok) return res.status(rR.status).json({ ok:false, step:"create_run", error:run });

    // 4) Poll until complete (max 120s)
    const started = Date.now();
    let status = run.status, runId = run.id, usage = null;
    while (["queued","in_progress","requires_action"].includes(status)) {
      if (Date.now() - started > 120000)
        return res.status(504).json({ ok:false, error:"Timeout waiting for run.", thread_id:threadId, run_id:runId });
      await new Promise(r => setTimeout(r, 800));
      const sR = await fetch(U(`/threads/${threadId}/runs/${runId}`), { headers:H });
      const sJ = await sR.json();
      if (!sR.ok) return res.status(sR.status).json({ ok:false, step:"get_run", error:sJ });
      status = sJ.status; usage = sJ.usage || usage;
    }

    // 5) Fetch latest assistant message(s)
    const gR = await fetch(U(`/threads/${threadId}/messages?order=desc&limit=5`), { headers:H });
    const gJ = await gR.json();
    if (!gR.ok) return res.status(gR.status).json({ ok:false, step:"get_messages", error:gJ });

    // Extract first assistant message, text + citations
    const assistantMsg = (gJ.data || []).find(m => m.role === "assistant");
    const text = assistantMsg?.content?.find(c => c.type === "text")?.text?.value || "(no text)";
    const citations = [];
    for (const part of (assistantMsg?.content || [])) {
      if (part.type === "text" && part.text?.annotations?.length) {
        for (const a of part.text.annotations) {
          if (a?.file_citation?.file_id) citations.push({ type:"file", file_id:a.file_citation.file_id, quote:a.text || null });
          if (a?.file_path?.file_id)    citations.push({ type:"file_path", file_id:a.file_path.file_id, path:a.file_path.path || null });
          if (a?.url)                   citations.push({ type:"url", url:a.url });
        }
      }
    }

    return res.status(200).json({
      ok: true,
      thread_id: threadId,
      text,
      citations,
      usage
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
};
