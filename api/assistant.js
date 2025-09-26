// api/assistant.js
// Node/Serverless (Vercel) – SSE streaming to the widget with intent-gating.
// Requires: "openai" in package.json deps and OPENAI_API_KEY env var.
// Uses your lib vector store via TCN_LIBRARY_VECTOR_STORE_ID.

import OpenAI from "openai";

// --- Env ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LIBRARY_VECTOR_STORE_ID = process.env.TCN_LIBRARY_VECTOR_STORE_ID; // keep your existing name

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
}

// --- Helpers ---
function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

function isGreeting(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  return /^(hi|hey|hello|howdy|yo|hiya|sup|what's up|whats up|good (morning|afternoon|evening))\b/.test(t);
}

function isMeta(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  return (
    /^(who (made|created|built) (you|this)|who owns you|what (are you|is [\w\s]+navigator)|what can you do|what's your purpose|what is your purpose)\b/.test(
      t
    )
  );
}

function isProcess(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  return /(can i upload|how do i upload|attach( a)? file|clear chat|how (do|to) use|how does this work)/.test(t);
}

function classifyIntent(text) {
  if (isGreeting(text)) return "greeting";
  if (isMeta(text)) return "meta";
  if (isProcess(text)) return "process";
  return "content";
}

// Map your lightweight stored history into Responses API input blocks
function mapHistoryToInput(history = []) {
  const blocks = [];
  for (const turn of history) {
    if (!turn || !turn.role || !turn.content) continue;
    if (turn.role === "user") {
      blocks.push({
        role: "user",
        content: [{ type: "input_text", text: String(turn.content) }],
      });
    } else if (turn.role === "assistant") {
      // Use output_text for assistant turns
      blocks.push({
        role: "assistant",
        content: [{ type: "output_text", text: String(turn.content) }],
      });
    }
  }
  return blocks;
}

// Minimal “always-on” guardrails — you already strengthened the full system prompt in your UI/config.
// This piece focuses on phrasing + retrieval behaviour.
const SYSTEM_CORE = `
You are Talking Care Navigator, supporting adult social care providers in England.
- Do NOT mention "files you've uploaded", "your uploads", or similar. If a document is attached THIS turn and used, call it the "attached document".
- Otherwise, refer to internal evidence as the "Talking Care Navigator Library".
- For greetings or meta questions, do NOT search or cite anything. Give a short friendly answer and ask how to help.
- Use clear UK English. Prefer bullets and short sections for lists.
`.trim();

/**
 * Optionally spin up a one-shot temp vector store for this turn (when an uploaded file_id is present).
 * Returns { id, processed: true } on success, or null if it fails (and we emit an 'info' SSE for the widget).
 */
async function ensureTempVectorStoreForFile(client, res, uploadedFileId) {
  try {
    const vs = await client.vectorStores.create({ name: `tcn-temp-${Date.now()}` });
    await client.vectorStores.files.create(vs.id, { file_id: uploadedFileId });

    // Poll for processing to finish (lightweight)
    const started = Date.now();
    let ready = false;
    while (Date.now() - started < 15000) {
      const status = await client.vectorStores.retrieve(vs.id);
      if (status.file_counts?.in_progress === 0 && status.file_counts?.failed === 0) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!ready) {
      sendSSE(res, "info", { note: "temp_vector_store_failed", error: "Timeout preparing your document." });
      return null;
    }

    sendSSE(res, "info", { note: "temp_vector_store_ready", id: vs.id });
    return { id: vs.id, processed: true };
  } catch (err) {
    sendSSE(res, "info", {
      note: "temp_vector_store_failed",
      error: err?.message || "Failed to prepare your document.",
    });
    return null;
  }
}

// --- Handler ---
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // SSE headers
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders?.();

  // Parse body
  let body = {};
  try {
    body = typeof req.body === "object" && req.body ? req.body : JSON.parse(req.body || "{}");
  } catch {
    // ignore; will fall back to empty
  }

  const userMessage = (body.userMessage || "").toString();
  const history = Array.isArray(body.history) ? body.history : [];
  const uploadFileId = body.upload_file_id ? String(body.upload_file_id) : null;

  // Safety: early start event
  sendSSE(res, "start", { ok: true });

  const intent = classifyIntent(userMessage);

  // If greeting/meta/process: short-circuit tool usage to avoid any "files/library" chatter.
  const client = new OpenAI({ apiKey: OPENAI_API_KEY });

  let vectorStoreIds = [];
  let tempVS = null;

  if (intent === "content") {
    // Only use file_search tools for genuine content questions.
    // If a file was attached this turn, prep a temp VS so the model can cite it.
    if (uploadFileId) {
      tempVS = await ensureTempVectorStoreForFile(client, res, uploadFileId);
      if (tempVS?.id) vectorStoreIds.push(tempVS.id);
    }
    if (LIBRARY_VECTOR_STORE_ID) {
      vectorStoreIds.push(LIBRARY_VECTOR_STORE_ID);
    }
  }

  // Build input blocks
  const inputBlocks = [
    {
      role: "system",
      content: [{ type: "input_text", text: SYSTEM_CORE }],
    },
    ...mapHistoryToInput(history),
    { role: "user", content: [{ type: "input_text", text: userMessage }] },
  ];

  // Tools only when intent === "content" and we actually have VS ids
  const tools = [];
  if (intent === "content" && vectorStoreIds.length > 0) {
    tools.push({
      type: "file_search",
      vector_store_ids: vectorStoreIds,
      max_num_results: 20,
      ranking_options: { ranker: "auto", score_threshold: 0.0 },
    });
  }

  // For greeting/meta/process keep tool_choice NONE; for content allow AUTO.
  const toolChoice = intent === "content" ? "auto" : "none";

  // Tight per-intent instruction overlay (keeps your main system prompt intact)
  let overlayInstructions = undefined;
  if (intent === "greeting") {
    overlayInstructions =
      "This is a greeting. Do not search or cite anything. Do not mention documents or a library. Reply briefly: 'Hello! How may I assist you today?'";
  } else if (intent === "meta") {
    overlayInstructions =
      "This is a meta question about identity/capability. Do not search or cite anything. Do not mention documents or a library. Be concise and friendly.";
  } else if (intent === "process") {
    overlayInstructions =
      "This is a process/capability question (e.g., uploading a file). Do not search or cite content sources. Explain the process briefly.";
  }

  try {
    const stream = await client.responses.stream({
      model: "gpt-4o-mini-2024-07-18",
      input: inputBlocks,
      tools,
      tool_choice: toolChoice,
      // New param location per Responses API
      text: { format: { type: "text" }, verbosity: "medium" },
      temperature: 1,
      stream: true,
      ...(overlayInstructions ? { instructions: overlayInstructions } : {}),
    });

    // Forward OpenAI SSE events to client
    for await (const event of stream) {
      // Just relay; your widget already cleans phrasing client-side.
      // We keep event names aligned with the SDK's emitted types.
      switch (event.type) {
        case "response.created":
        case "response.in_progress":
        case "response.completed":
        case "response.output_item.added":
        case "response.output_item.done":
        case "response.content_part.added":
        case "response.content_part.done":
        case "response.text.delta": // older alias (SDK may emit output_text.delta below)
        case "response.output_text.delta":
        case "response.output_text.done":
        case "response.error":
        case "response.file_search_call.in_progress":
        case "response.file_search_call.searching":
        case "response.file_search_call.completed":
        case "response.tool_call.created":
        case "response.tool_call.delta":
        case "response.tool_call.done":
        case "response.refusal.delta":
        case "response.refusal.done":
        case "response.completed_with_error":
        case "rate_limits.updated":
        case "response.content_part.added.metadata":
        case "response.output_text.annotation.added":
          sendSSE(res, event.type, event);
          break;
        default:
          // keep noise down; only forward meaningful events
          break;
      }
    }

    sendSSE(res, "done", "[DONE]");
    res.end();
  } catch (err) {
    const message = err?.message || "OpenAI stream failed";
    sendSSE(res, "error", { message });
    try {
      sendSSE(res, "done", "[DONE]");
    } finally {
      res.end();
    }
  }
}
