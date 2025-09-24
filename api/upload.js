// /api/upload.js
//
// Accepts multipart/form-data with a single "file" field.
// 1) Uploads the file to OpenAI Files API
// 2) Polls /v1/files/{id} until status === 'processed' (or timeout)
// 3) Returns { ok:true, file: { id, filename, bytes, status } }

export const config = {
  api: { bodyParser: false }, // we'll read the stream ourselves
};

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ALLOW_ORIGIN || "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok:false, error: "Method Not Allowed" });
  }
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ ok:false, error: "Server misconfig: OPENAI_API_KEY missing" });
  }

  try {
    // Parse multipart quickly (single small file) without external deps
    const contentType = req.headers["content-type"] || "";
    const m = contentType.match(/boundary=(.*)$/);
    if (!m) return res.status(400).json({ ok:false, error:"Missing multipart boundary" });
    const boundary = "--" + m[1];

    const buf = Buffer.from(await req.arrayBuffer());
    const parts = buf.toString("binary").split(boundary).filter(p => p.trim() && p.trim() !== "--");

    let fileName = "upload.bin";
    let fileBytes = null;
    for (const part of parts) {
      const [rawHeaders, rawBody] = part.split("\r\n\r\n");
      if (!rawHeaders || !rawBody) continue;
      const headers = rawHeaders.split("\r\n").filter(Boolean).slice(1).join("\n"); // skip first \r\n
      if (/name="file"/i.test(headers)) {
        const nameMatch = headers.match(/filename="([^"]+)"/i);
        fileName = nameMatch ? nameMatch[1] : fileName;
        const bodyBinary = rawBody.endsWith("\r\n") ? rawBody.slice(0, -2) : rawBody; // strip trailing CRLF
        fileBytes = Buffer.from(bodyBinary, "binary");
        break;
      }
    }
    if (!fileBytes) return res.status(400).json({ ok:false, error:"No file field found" });

    // Create a form to send to OpenAI
    const form = new FormData();
    form.append("file", new Blob([fileBytes]), fileName);
    form.append("purpose", "assistants"); // required for retrieval

    // Upload to OpenAI
    const uploadResp = await fetch("https://api.openai.com/v1/files", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });
    if (!uploadResp.ok) {
      const t = await uploadResp.text().catch(() => "");
      return res.status(502).json({ ok:false, error:`OpenAI upload failed: ${t}` });
    }
    const fileMeta = await uploadResp.json(); // { id, filename, bytes, status, ... }
    const fileId = fileMeta.id;

    // Poll until processed (max ~15s)
    const started = Date.now();
    let status = fileMeta.status || "uploaded";
    let meta = fileMeta;

    while (status !== "processed" && Date.now() - started < 15000) {
      await new Promise(r => setTimeout(r, 600));
      const check = await fetch(`https://api.openai.com/v1/files/${fileId}`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
      });
      if (!check.ok) break;
      meta = await check.json();
      status = meta.status || status;
      if (status === "error") break;
    }

    if (status !== "processed") {
      // Best-effort final check; still return the file (client/assistant will guard)
      return res.status(200).json({
        ok: true,
        file: { id: fileId, filename: fileName, bytes: meta.bytes, status: status || "unknown" },
        processed: false
      });
    }

    return res.status(200).json({
      ok: true,
      file: { id: fileId, filename: fileName, bytes: meta.bytes, status: "processed" },
      processed: true
    });
  } catch (err) {
    console.error("upload error", err);
    return res.status(500).json({ ok:false, error:"Upload handler failed" });
  }
}
