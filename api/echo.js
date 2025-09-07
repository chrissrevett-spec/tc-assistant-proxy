// api/echo.js
export default async function handler(req, res) {
  // Handle CORS preflight early
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const mode = (req.query.mode || '').toString();

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Use POST' });
    return;
  }

  // Basic JSON echo
  if (mode !== 'stream') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      res.status(200).json({ ok: true, message: body.message || 'pong' });
    } catch {
      res.status(200).json({ ok: true, message: 'pong' });
    }
    return;
  }

  // SSE echo (stream)
  try {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const say = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    };

    say('start', { ok: true });

    const chunks = ['Echo ', 'stream ', 'from ', 'server ', '✅'];
    let i = 0;

    const tick = () => {
      if (i >= chunks.length) {
        say('done', '[DONE]');
        res.end();
        return;
      }
      // Use the same shape your client consumes for text deltas:
      say('response.output_text.delta', { delta: { type: 'output_text_delta', text: chunks[i] } });
      i += 1;
      setTimeout(tick, 400);
    };
    setTimeout(tick, 200);
  } catch (err) {
    // Even if something explodes, reply with JSON (CORS headers already applied via vercel.json)
    try {
      res.status(200).json({ ok: false, error: String(err?.message || err) });
    } catch {
      res.end(); // last resort
    }
  }
}
