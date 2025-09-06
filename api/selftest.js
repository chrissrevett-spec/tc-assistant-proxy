// api/selftest.js - verifies the Assistants v2 header is being sent
module.exports = async function (req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, reason: "Missing OPENAI_API_KEY env var" });
    }

    const headers = {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2"
    };

    const resp = await fetch("https://api.openai.com/v1/threads", {
      method: "POST",
      headers,
      body: JSON.stringify({})
    });

    const text = await resp.text();
    res.setHeader("Content-Type", "application/json");
    return res.status(resp.status).send(JSON.stringify({
      ok: resp.ok,
      status: resp.status,
      body: tryParse(text)
    }));
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};

function tryParse(s) { try { return JSON.parse(s); } catch { return s; } }
