// api/upload.js
export const config = { runtime: "edge" };

const OAI = "https://api.openai.com/v1";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}

function cors204() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
    },
  });
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return cors204();
  if (req.method !== "POST") return json({ ok: false, error: "Method Not Allowed" }, 405);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return json({ ok: false, error: "Missing OPENAI_API_KEY" }, 500);

  try {
    const form = await req.formData();                 // ✅ Works on Edge
    const file = form.get("file");
    if (!file) return json({ ok: false, error: "No file" }, 400);

    // Send to OpenAI Files
    const out = new FormData();
    out.append("purpose", "assistants");
    out.append("file", file, file.name);               // File is a web File object on Edge

    const r = await fetch(`${OAI}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: out,                                       // Edge doesn't need duplex: 'half'
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return json({
        ok: false,
        error: data?.error?.message || `OpenAI upload failed (${r.status})`,
      }, 500);
    }

    return json({ ok: true, file_id: data.id, processed: true }, 200);
  } catch (e) {
    return json({ ok: false, error: e?.message || "Upload failed" }, 500);
  }
}
