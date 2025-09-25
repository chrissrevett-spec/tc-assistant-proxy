// api/upload.js
export const config = { runtime: "nodejs" };

const OAI = "https://api.openai.com/v1";

export default async function handler(req, res) {
  // CORS + preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    return res.end();
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: "Missing OPENAI_API_KEY" });

    // Parse incoming multipart/form-data using Web API
    const form = await req.formData();
    const file = form.get("file");
    if (!file) return res.status(400).json({ ok: false, error: "No file" });

    // Rebuild form for OpenAI Files endpoint
    const out = new FormData();
    out.append("purpose", "assistants");
    // The WHATWG File from req.formData() can be appended directly
    out.append("file", file, file.name);

    const r = await fetch(`${OAI}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: out,
      // REQUIRED by Node/undici when sending streamed bodies (like FormData)
      duplex: "half",
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(500).json({
        ok: false,
        error: data?.error?.message || `OpenAI upload failed (${r.status})`,
      });
    }

    return res.status(200).json({
      ok: true,
      file_id: data.id,
      processed: true, // UI hint (we do indexing during /api/assistant call)
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || "Upload failed" });
  }
}
