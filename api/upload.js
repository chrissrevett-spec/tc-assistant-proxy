// api/upload.js
export const config = { runtime: "nodejs" };

/**
 * POST multipart/form-data with field "file"
 * - Caps size at 20 MB
 * - Uploads to OpenAI Files API (purpose: "assistants")
 * - Returns { ok, file_id, processed }
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    // Convert Node req to Web Request to read formData without extra deps
    const url = new URL(req.url, `http://${req.headers.host}`);
    const webReq = new Request(url, { method: req.method, headers: req.headers, body: req });

    const form = await webReq.formData();
    const file = form.get("file");

    if (!file || typeof file.arrayBuffer !== "function") {
      return res.status(400).json({ ok: false, error: "No file provided" });
    }

    const MAX_BYTES = 20 * 1024 * 1024; // 20MB
    if (file.size > MAX_BYTES) {
      return res.status(400).json({ ok: false, error: "File too large (20 MB max)" });
    }

    // Build form-data to send to OpenAI
    const fd = new FormData();
    fd.append("purpose", "assistants");
    fd.append(
      "file",
      new Blob([await file.arrayBuffer()], { type: file.type || "application/octet-stream" }),
      file.name || "upload.bin"
    );

    const r = await fetch("https://api.openai.com/v1/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: fd,
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(500).json({ ok: false, error: `OpenAI upload failed: ${txt || r.status}` });
    }

    const data = await r.json();
    return res.status(200).json({
      ok: true,
      file_id: data.id,     // e.g. "file-XXXX"
      processed: true       // show the green tick; indexing happens in /api/assistant
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || "Upload error" });
  }
}
