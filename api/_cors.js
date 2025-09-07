export function getAllowedOrigin() {
  return process.env.ALLOWED_ORIGIN || "*";
}

export function commonCorsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": getAllowedOrigin(),
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-vercel-protection-bypass, Accept",
    "Access-Control-Max-Age": "86400",
    ...extra
  };
}

export function okJson(obj, init = {}) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...commonCorsHeaders(),
      ...(init.headers || {})
    },
  });
}

export function errJson(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...commonCorsHeaders()
    },
  });
}

export function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: commonCorsHeaders(),
  });
}
