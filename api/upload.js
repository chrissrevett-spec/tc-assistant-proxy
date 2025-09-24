// /api/upload.js
//
// Accepts multipart/form-data from the widget, uploads files to OpenAI,
// and attaches them to a (new or existing) vector store.
// Returns: { ok, temp_vector_store_id, files:[{name, size, mime, file_id, status}] }
//
// Requires Node runtime (NOT edge) so we can parse multipart with busboy.

import Busboy from "busboy";

export const config = {
  api: { bodyParser: false }, // we handle multipart ourselves
};

const OPENAI_API_KEY   = process.env.OPENAI_API_KEY || "";
const ACCEPT_LIST      = (process.env.OPENAI_UPLOAD_ACCEPT || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
// Sensible defaults if not provided:
const MAX_FILES        = parseInt(process.env.OPENAI_UPLOAD_MAX_FILES || "8", 10);
const MAX_MB           = parseInt(process.env.OPENAI_UPLOAD_MAX_MB || "25", 10);  // per upload batch
const NAME_PREFIX      = process.env.OPENAI_VECTOR_STORE_NAME_PREFIX || "TC-Session";

if (!OPENAI_API_KEY) {
  console.error("[upload] Missing OPENAI_API_KEY");
}

// --- helpers ----

function reject(res, code, msg) {
  res.status(code).json({ ok:false, error: msg });
}

function mimeAllowed(mime, filename) {
  if (ACCEPT_LIST.length === 0) return true; // allow all if not configured
  const m = (mime || "").toLowerCase();
  const ext = (filename.split(".").pop() || "").toLowerCase();
  return ACCEPT_LIST.includes(m) || ACCEPT_LIST.includes(ext);
}

// stream -> buffer with a cap
async function streamToBuffer(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const c of stream) {
    size += c.length;
    if (size > maxBytes) throw new Error("File too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function oaJson(path, method, body, headers = {}) {
  const r = await fetch(`https://api.openai.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "assistants=v2",
      ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body
      ? (body instanceof FormData ? body : JSON.stringify(body))
      : undefined,
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`${method} ${path} failed: ${r.status} ${txt}`);
  }
  return r.json();
}

// Create a new vector store (session-scoped)
async function createVectorStore() {
  const name = `${NAME_PREFIX}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const data = await oaJson("/vector_stores", "POST", { name });
  return data.id;
}

// Upload a file to OpenAI Files, purpose=assistants
async function uploadFileToOpenAI({ buffer, filename, mime }) {
  const fd = new FormData();
  fd.append("file", new Blob([buffer], { type: mime || "application/octet-stream" }), filename);
  fd.append("purpose", "assistants");
  const data = await oaJson("/files", "POST", fd);
  return data.id;
}

// Attach file to vector store
async function attachFileToVectorStore(vsId, fileId) {
  const data = await oaJson(`/vector_stores/${vsId}/files`, "POST", { file_id: fileId });
  return data.id; // vector_store_file id
}

// Optional: poll ingestion status briefly (best-effort)
async function pollIngestionStatus(vsId, vsFileId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await oaJson(`/vector_stores/${vsId}/files/${vsFileId}`, "GET");
    const st = data?.status || "unknown";
    if (st === "completed" || st === "failed" || st === "cancelled") return st;
    await new Promise(r => setTimeout(r, 800));
  }
  return "processing";
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ALLOW_ORIGIN || "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return reject(res, 405, "Method Not Allowed");
  }
  if (!OPENAI_API_KEY) return reject(res, 500, "Server misconfig: OPENAI_API_KEY not set");

  // CORS (mirror your assistant route)
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ALLOW_ORIGIN || "https://tc-assistant-proxy.vercel.app");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", process.env.CORS_ALLOW_METHODS || "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", process.env.CORS_ALLOW_HEADERS || "Content-Type, Accept");

  try {
    const busboy = Busboy({ headers: req.headers });
    const files = [];    // { filename, mime, buffer, size }
    const fields = {};   // plain fields (e.g., vector_store_id)

    const MAX_BYTES = MAX_MB * 1024 * 1024;

    const done = new Promise((resolve, reject2) => {
      let totalSize = 0;

      busboy.on("file", async (name, file, info) => {
        const { filename, mimeType } = info;
        if (files.length >= MAX_FILES) {
          file.resume();
          return reject2(new Error(`Too many files. Max ${MAX_FILES}.`));
        }
        if (!mimeAllowed(mimeType, filename)) {
          file.resume();
          return reject2(new Error(`File type not allowed: ${mimeType || filename}`));
        }
        try {
          const buf = await streamToBuffer(file, MAX_BYTES); // per-file cap
          totalSize += buf.length;
          if (totalSize > MAX_BYTES) throw new Error(`Total upload too large. Max ${MAX_MB}MB`);
          files.push({ filename, mime: mimeType, buffer: buf, size: buf.length });
        } catch (e) {
          file.resume();
          reject2(e);
        }
      });

      busboy.on("field", (name, val) => {
        fields[name] = val;
      });

      busboy.on("error", reject2);
      busboy.on("finish", resolve);
    });

    req.pipe(busboy);
    await done;

    if (!files.length) return reject(res, 400, "No files provided");
    const clientVS = (fields.vector_store_id || req.query.vs || "").toString().trim();

    // Create or reuse vector store
    const vectorStoreId = clientVS || (await createVectorStore());

    // Upload each file -> /files, then attach to vector store
    const results = [];
    for (const f of files) {
      try {
        const fileId = await uploadFileToOpenAI(f);
        const vsFileId = await attachFileToVectorStore(vectorStoreId, fileId);
        const status = await pollIngestionStatus(vectorStoreId, vsFileId, 12000);
        results.push({
          name: f.filename,
          size: f.size,
          mime: f.mime || null,
          file_id: fileId,
          status
        });
      } catch (e) {
        results.push({
          name: f.filename,
          size: f.size,
          mime: f.mime || null,
          file_id: null,
          status: "error",
          error: e?.message || String(e),
        });
      }
    }

    // If *every* file errored, consider the whole thing a failure
    const anyOk = results.some(r => r.file_id);
    if (!anyOk) {
      return res.status(400).json({ ok:false, error:"All uploads failed", files: results });
    }

    return res.status(200).json({
      ok: true,
      temp_vector_store_id: vectorStoreId,
      files: results
    });
  } catch (err) {
    console.error("[upload] error:", err);
    return reject(res, 500, "Internal Server Error");
  }
}
