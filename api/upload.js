// /api/upload.js
//
// Uses busboy to robustly parse multipart/form-data.
// 1) Extracts one "file" field
// 2) Uploads to OpenAI Files API with purpose=assistants
// 3) Polls /v1/files/{id} until status==='processed' (or timeout ~45s)
// 4) Returns { ok:true, file:{ id, filename, bytes, status }, processed:true|false }

export const config = {
  api: { bodyParser: false },
};

import Busboy from "busboy";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CORS_ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN || "https://tc-assistant-proxy.vercel.app";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    let fileBuffer = null;
    let fileName = "upload.bin";
    let fileMIME = "application/octet-stream";

    bb.on("file", (_fieldname, stream, filename, _encoding, mimetype) => {
      if (filename) fileName = filename;
      if (mimetype) fileMIME = mimetype;
      const chunks = [];
      stream.on("data", (d) => chunks.push(d));
      stream.on("limit", () => reject(new Error("File too large")));
      stream.on("end", () => { fileBuffer = Buffer.concat(chunks); });
    });

    bb.on("error", reject);
    bb.on("finish", () => {
      if (!fileBuffer) return reject(new Error("No file uploaded"));
      resolve({ fileBuffer, fileName, fileMIME });
    });

    req.pipe(bb);
  });
}

async function uploadToOpenAI({ fileBuffer, fileName, fileMIME }) {
  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: fileMIME }), fileName);
  form.append("purpose", "assistants");

  const r = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`OpenAI upload failed: ${r.status} ${t}`);
  }
  return r.json(); // { id, filename, bytes, status, ... }
}

async function pollProcessed(fileId, timeoutMs = 45000, intervalMs = 800) {
  const start = Date.now();
  let meta = null;
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`https://api.openai.com/v1/files/${fileId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    });
    if (!r.ok) break;
    meta = await r.json();
    const status = meta?.status;
    if (status === "processed") return { processed: true, meta };
    if (status === "error") return { processed: false, meta };
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return { processed: false, meta };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    cors(res);
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    cors(res);
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }
  if (!OPENAI_API_KEY) {
    cors(res);
    return res.status(500).json({ ok: false, error: "Server misconfig: OPENAI_API_KEY missing" });
  }

  try {
    const { fileBuffer, fileName, fileMIME } = await readMultipart(req);
    const uploaded = await uploadToOpenAI({ fileBuffer, fileName, fileMIME });
    const fileId = uploaded.id;

    const { processed, meta } = await pollProcessed(fileId);

    cors(res);
    return res.status(200).json({
      ok: true,
      processed,
      file: {
        id: fileId,
        filename: fileName,
        bytes: meta?.bytes ?? uploaded?.bytes ?? fileBuffer.length,
        status: processed ? "processed" : meta?.status || uploaded?.status || "uploaded",
      },
    });
  } catch (err) {
    console.error("upload error", err);
    cors(res);
    return res.status(500).json({ ok: false, error: err.message || "Upload handler failed" });
  }
}
