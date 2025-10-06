// /api/upload.js
export const config = { runtime: "edge" };

const OAI = "https://api.openai.com/v1";

// ---- Config (env) ----
const ALLOWED_ORIGIN = process.env.TCN_ALLOWED_ORIGIN || "https://www.talkingcare.uk";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB cap, server-side too

// Keep this conservative. Add more if you need them.
const ALLOWED_EXT = [
  "pdf", "txt", "md", "rtf",
  "doc", "docx",
  "ppt", "pptx",
  "xls", "xlsx", "csv",
  "html", "htm"
];

function withCorsHeaders(init = {}) {
  const h = new Headers(init.headers || {});
  h.set("access-control-allow-origin", ALLOWED_ORIGIN);
  h.set("vary", "origin");
  return new Response(init.body ?? null, { ...init, headers: h });
}

function json(data, status = 200) {
  return withCorsHeaders({
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
}

function cors204() {
  return withCorsHeaders({
    status: 204,
    headers: {
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
    },
  });
}

function extOf(name = "") {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/i);
  return m ? m[1] : "";
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return cors204();
  if (req.method !== "POST") return json({ ok: false, error: "Method Not Allowed" }, 405);
  if (!OPENAI_API_KEY) return json({ ok: false, error: "Missing OPENAI_API_KEY" }, 500);

  try {
    // Edge: FormData + web File
    const form = await req.formData();
    const file = form.get("file");
    if (!file) return json({ ok: false, error: "No file" }, 400);

    // Server-side size check
    if (typeof file.size === "number" && file.size > MAX_UPLOAD_BYTES) {
      return json({ ok: false, error: "File too large (20 MB max)" }, 400);
    }

    // Server-side type check (by extension)
    const ext = extOf(file.name || "");
    if (!ALLOWED_EXT.includes(ext)) {
      return json({ ok: false, error: "File type not supported" }, 415);
    }

    // Upload to OpenAI Files. IMPORTANT: this route does NOT attach to any vector store.
    const out = new FormData();
    out.append("purpose", "assistants");
    // Edge runtime `file` is already a standard web File
    out.append("file", file, file.name);

    const r = await fetch(`${OAI}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: out,
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return json({
        ok: false,
        error: data?.error?.message || `OpenAI upload failed (${r.status})`,
      }, 502);
    }

    // Return only the file id — indexing happens later in /api/assistant against a TEMP vector store,
    // which is deleted immediately after the turn (along with this file).
    return json({
      ok: true,
      file_id: data.id,
      file_name: file.name || null,
      bytes: typeof file.size === "number" ? file.size : null,
      processed: true // <- tell the widget it's ready to use
    }, 200);
  } catch (e) {
    return json({ ok: false, error: e?.message || "Upload failed" }, 500);
  }
}
