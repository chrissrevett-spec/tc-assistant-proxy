// /api/upload.js
// Robust file upload handler using Busboy and OpenAI Files API
// Guardrails added: 20 MB file size cap, clear friendly errors.

export const config = {
  api: { bodyParser: false },
};

import Busboy from "busboy";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const CORS_ALLOW_METHODS = "POST, OPTIONS";
const CORS_ALLOW_HEADERS = "Content-Type";
const CORS_MAX_AGE = "86400";
const ALLOWED_ORIGINS = [
  "https://tc-assistant-proxy.vercel.app",
  "https://www.talkingcare.uk"
];

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

function cors(res, origin = "") {
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
  res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  res.setHeader("Access-Control-Max-Age", CORS_MAX_AGE);
}

function readMultipart(req) {
  console.log("👀 Entering readMultipart");
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_BYTES } });
    let fileBuffer = null;
    let fileName = "upload.bin";
    let fileMIME = "application/octet-stream";
    let done = false;

    const bail = (err) => {
      if (done) return;
      done = true;
      reject(err);
    };

    bb.on("file", (_fieldname, stream, filename, encoding, mimetype) => {
      // Some proxies send filename as an object
      let resolvedName = "upload.bin";
      if (typeof filename === "string" && filename.trim()) {
        resolvedName = filename.trim();
      } else if (filename && typeof filename === "object" && typeof filename.filename === "string") {
        resolvedName = filename.filename.trim() || "upload.bin";
      }
      const resolvedType =
        typeof mimetype === "string" && mimetype.trim()
          ? mimetype.trim()
          : (filename && typeof filename === "object" && typeof filename.mimeType === "string"
              ? filename.mimeType.trim()
              : "application/octet-stream");

      console.log("📂 File event hit:", { filename, encoding, mimeType: mimetype });
      fileName = resolvedName;
      fileMIME = resolvedType;

      const chunks = [];
      stream.on("data", (d) => chunks.push(d));
      stream.on("limit", () => bail(Object.assign(new Error("File too large (20 MB max)"), { code: "FILE_TOO_LARGE" })));
      stream.on("end", () => { fileBuffer = Buffer.concat(chunks); });
      stream.on("error", (e) => bail(e));
    });

    bb.on("error", (err) => {
      console.error("❌ Busboy error:", err);
      bail(err);
    });

    bb.on("finish", () => {
      if (done) return;
      console.log("✅ File read complete:", { filename: fileName });
      if (!fileBuffer) {
        console.error("❌ No file buffer was populated.");
        return bail(new Error("No file uploaded"));
      }
      if (fileBuffer.length > MAX_UPLOAD_BYTES) {
        return bail(Object.assign(new Error("File too large (20 MB max)"), { code: "FILE_TOO_LARGE" }));
      }
      done = true;
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
  cors(res, req.headers.origin || "");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ ok: false, error: "Server misconfig: OPENAI_API_KEY missing" });
  }

  try {
    const { fileBuffer, fileName, fileMIME } = await readMultipart(req);
    const uploaded = await uploadToOpenAI({ fileBuffer, fileName, fileMIME });
    const fileId = uploaded.id;

    const { processed, meta } = await pollProcessed(fileId);

    return res.status(200).json({
      ok: true,
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
    // Friendly errors
    const msg = err?.message || "Upload handler failed";
    if (err?.code === "FILE_TOO_LARGE") {
      return res.status(413).json({ ok: false, error: "File too large (20 MB max)" });
    }
    return res.status(500).json({ ok: false, error: msg });
  }
}
