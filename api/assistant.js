// api/assistant.js
const OPENAI_URL = 'https://api.openai.com/v1/responses';

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Use POST' });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Do NOT 500 here; return a friendly JSON the client can show
    res.status(200).json({ ok: false, error: 'Missing OPENAI_API_KEY (server env)' });
    return;
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch {
    body = {};
  }

  const userMessage = (body.userMessage || '').toString().trim();
  if (!userMessage) {
    res.status(200).json({ ok: false, error: 'userMessage is required' });
    return;
  }

  const streamOff = (req.query.stream || '').toLowerCase() === 'off';

  // Non-streaming path (simple and reliable)
  if (streamOff) {
    try {
      const r = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4.1-mini',
          input: userMessage
        })
      });

      const text = await r.text();
      if (!r.ok) {
        // Surface OpenAI errors as JSON (still 200 to avoid browser CORS weirdness on error)
        res.status(200).json({ ok: false, step: 'responses', error: safeParse(text) || text });
        return;
      }

      const data = safeParse(text);
      const out = extractTextFromResponses(data);
      res.status(200).json({
        ok: true,
        text: out || '(no content)',
        // keep fields the widget expects:
        thread_id: null,
        citations: [],
        usage: null
      });
      return;
    } catch (err) {
      res.status(200).json({ ok: false, error: String(err?.message || err) });
      return;
    }
  }

  // Streaming path (SSE) via Responses API
  try {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const say = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    };

    say('start', { ok: true });

    const upstream = await fetch(`${OPENAI_URL}?stream=true`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4.1-mini',
        input: userMessage
      })
    });

    if (!upstream.ok || !upstream.body) {
      const txt = await upstream.text().catch(() => '');
      say('error', { ok: false, status: upstream.status, body: txt || '(no body)' });
      say('done', '[DONE]');
      res.end();
      return;
    }

    // Pipe OpenAI's SSE to your client, translating only the event names you care about (no rename needed)
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let gotFirst = false;

    const flushBlocks = (blocks) => {
      for (const block of blocks) {
        if (!block.trim()) continue;
        const lines = block.split('\n');
        let eventType = null;
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event:')) eventType = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        // forward as-is; your widget now understands response.output_text.delta
        if (data === '[DONE]') {
          say('done', '[DONE]');
        } else {
          try {
            const obj = JSON.parse(data);
            say(eventType || 'message', obj);
          } catch {
            // If OpenAI sends a keepalive or non-JSON line, ignore
          }
        }
      }
    };

    // Guard: stop if nothing arrives quickly
    const firstTimer = setTimeout(() => {
      if (!gotFirst) {
        say('error', { ok: false, error: 'stream_start_timeout' });
        say('done', '[DONE]');
        res.end();
      }
    }, 3000);

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      gotFirst = true;
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      flushBlocks(parts);
    }

    clearTimeout(firstTimer);
    // Flush any residue
    if (buffer) flushBlocks([buffer]);
    say('done', '[DONE]');
    res.end();
  } catch (err) {
    // Fail gracefully in-stream
    try {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ ok: false, error: String(err?.message || err) })}\n\n`);
      res.write(`event: done\n`);
      res.write(`data: [DONE]\n\n`);
      res.end();
    } catch {
      // last ditch
      try { res.status(200).json({ ok: false, error: String(err?.message || err) }); } catch {}
    }
  }
}

// Helpers
function safeParse(t) {
  try { return JSON.parse(t); } catch { return null; }
}

function extractTextFromResponses(resp) {
  // Responses API structure: response.output[0].content[...] typically has text
  // But also supports response.output_text (flattened). Prefer output_text if present.
  if (!resp) return '';
  if (typeof resp.output_text === 'string') return resp.output_text;
  if (Array.isArray(resp.output)) {
    for (const seg of resp.output) {
      if (seg?.type === 'output_text' && typeof seg?.text === 'string') return seg.text;
      // Fallback if nested content exists
      if (Array.isArray(seg?.content)) {
        for (const c of seg.content) {
          if (c?.type === 'output_text' && typeof c?.text === 'string') return c.text;
          if (c?.type === 'text' && typeof c?.text === 'string') return c.text;
        }
      }
    }
  }
  return '';
}
