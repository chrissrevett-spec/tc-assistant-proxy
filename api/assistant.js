 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/api/assistant.js b/api/assistant.js
index d70ef2544dfd0ad0ace3748d14227829cfcdf888..4e187e225538865301d7cd8e71b5014c85189828 100644
--- a/api/assistant.js
+++ b/api/assistant.js
@@ -17,51 +17,65 @@
 //   "response.output_text.delta" which this emits.
 
 const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
 const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini"; // pick what you want
 const CORS_ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN || "https://www.talkingcare.uk";
 
 if (!OPENAI_API_KEY) {
   console.error("Missing OPENAI_API_KEY");
 }
 
 // ---------- CORS ----------
 function setCors(res) {
   res.setHeader("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN);
   res.setHeader("Vary", "Origin");
   res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
   res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
   res.setHeader("Access-Control-Max-Age", "86400");
 }
 function endPreflight(res) {
   res.statusCode = 204;
   res.end();
 }
 
 // ---------- Body parsing ----------
 async function readBody(req) {
-  if (req.body && typeof req.body === "object") return req.body;
+  // Some hosting platforms (like Vercel) expose req.body as a getter that
+  // attempts to JSON-parse the incoming payload. If the payload isn't valid
+  // JSON, accessing req.body throws. Swallow those errors and fall back to
+  // manually reading the stream so we can accept both JSON and plain text.
+  try {
+    if (req.body !== undefined) {
+      const b = req.body;
+      if (typeof b === "string") {
+        try { return JSON.parse(b); } catch { return { userMessage: b }; }
+      }
+      if (typeof b === "object") return b;
+    }
+  } catch {
+    // ignore and read from stream below
+  }
 
   return await new Promise((resolve, reject) => {
     let data = "";
     req.setEncoding("utf8");
     req.on("data", (c) => (data += c));
     req.on("end", () => {
       const t = (data || "").trim();
       if (!t) return resolve({});
       // If JSON, parse; else treat as raw text as the user message
       if (t.startsWith("{") || t.startsWith("[")) {
         try { resolve(JSON.parse(t)); } catch { resolve({}); }
       } else {
         resolve({ userMessage: t });
       }
     });
     req.on("error", reject);
   });
 }
 
 // ---------- OpenAI helpers ----------
 async function oaJson(path, method, body) {
   const r = await fetch(`https://api.openai.com/v1${path}`, {
     method,
     headers: {
       "Authorization": `Bearer ${OPENAI_API_KEY}`,
 
EOF
)
