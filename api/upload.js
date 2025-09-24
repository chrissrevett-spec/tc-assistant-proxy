// /api/upload.js
// Robust file upload handler using Busboy and OpenAI Files API

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
  console.log("👀 Entering readMultipart");
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    let fileBuffer = null;
    let fileName = "upload.bin";
    let fileMIME = "application/octet-stream";

    bb.on("file", (_fieldname, stream, filename, _encoding, mimetype) => {
      console.log("📂 File event hit:", filename);
      if (filename) fileName = filename;
      if (mimetype) fileMIME = mimetype;
      const chunks = [];
      stream.on("data", (d) => chunks.push(d));
      stream.on("limit", () => reject(new Error("File too large")));
      stream.on("end", () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    bb.on("error", (err) => {
      console.error("❌ Busboy error:", err);
      reject(err);
    });

    bb.on("finish", () => {
      if (!fileBuffer) {
        console.error("❌ No file buffer was populated.");
        return reject(new Error("No file uploaded"));
      }
      console.log("✅ File read complete:", fileName);
      resolve({ fileBuffer, fileName, fileMIME });
    });

    req.pipe(bb);
  });
}

async function uploadToOpenAI({ fileBuffer, fileName, fileMIME }) {
  console.log("⬆️ Uploading to OpenAI...");
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
    console.error("❌ OpenAI upload failed:", r.status, t);
    throw new Error(`OpenAI upload failed: ${r.status} ${t}`);
  }
  const result = await r.json();
  console.log("✅ OpenAI upload success:", result);
  return result;
}

async function pollProcessed(fileId, timeoutMs = 45000, intervalMs = 800) {
  console.log("⏳ Polling for processing status...");
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
    console.log("📡 File status:", status);
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
      // 👇 add top-level file_id so the existing widget logic can use it
      file_id: fileId,
      processed,
      file: {
        id: fileId,
        filename: fileName,
        bytes: meta?.bytes ?? uploaded?.bytes ?? fileBuffer.length,
        status: processed ? "processed" : meta?.status || uploaded?.status || "uploaded",
      },
    });
  } catch (err) {
    console.error("❌ Upload error:", err);
    cors(res);
    return res.status(500).json({ ok: false, error: err.message || "Upload handler failed" });
  }
}
