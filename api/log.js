import { handleOptions, okJson } from "./_cors.js";

export async function OPTIONS() { return handleOptions(); }

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { body = {}; }
  // We purposely don’t persist; just 204/200 to avoid slowing front-end on poor networks.
  return okJson({ ok: true });
}
