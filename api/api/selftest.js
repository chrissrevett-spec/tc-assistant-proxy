// api/selftest.js - verifies we are sending the Assistants v2 header correctly
module.exports = async function (req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      res.status(500).json({ ok: false, reason: "Missing OPENAI_API_KEY env var" });
      return;
    }

    const headers = {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2"   // <- this is the key bit we need
    };

    const resp = await fetch("https://api.openai.com/v1/threads", {
      method: "POST",
      headers,
      body: JSON.stringify({})
    });

    const text = await resp.text();
    res.setHeader("Content-Type", "application/json");
    res.status(resp.status).send(JSON.stringify({
      ok: resp.ok,
      status: resp.status,
      body: tryParse(text)
    }));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};

function tryParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}
