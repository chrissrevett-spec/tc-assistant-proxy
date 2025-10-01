function classifyIntent(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return null;

  // greetings / small talk
  if (/^(hi|hello|hey|hiya|howdy|yo|good (morning|afternoon|evening))\b/.test(t)) return "greeting";
  if (/(are|r)\s*(you|u)\s*ok(ay)?\??$/.test(t)) return "greeting";
  if (/\b(you|u)\s*ok(ay)?\??$/.test(t)) return "greeting";
  if (/\bhow('?|’)?s it going\b|\bhow are (you|u)\b/.test(t)) return "greeting";

  // identity / creator / purpose / capability
  if (/\bwho (are|r) (you|u)\b/.test(t)) return "who";
  if (/\bwho (made|created|built) (you|u)\b|\bwho owns you\b|\bowner\b/.test(t)) return "creator";
  if (/\bwhat (is|’s|'s) your (purpose|goal|mission|objective|role)\b|\bwhy (were you created|do you exist)\b|\bprime directive\b/.test(t)) return "purpose";

  // 👇 NEW: cover “what do you/u do” & synonyms
  if (/\bwhat do (you|u) do\b|\bwhat('?|’)?s your (role|job|function|capabilities?)\b/.test(t)) return "capability";
  if (/\bwhat can (you|u) do\b|\bhow can (you|u) help\b|\bexamples? of (how|what) (you|u) can do\b|\bwhat can u even do\b/.test(t)) return "capability";

  // process / “how does this work”
  if (/\bhow (does|do) (this|it) work\b|\bhow (do|to) (i|we) (use|work with) (you|this)\b|\bcan i upload\b|\bhow to upload\b/.test(t)) return "process";

  // privacy / data handling
  if (/\b(what|how) (do|will) (you|u) (do|use|handle) (with )?my data\b|\bdata (policy|privacy)\b|\bprivacy\b/.test(t)) return "privacy";

  // comparison to ChatGPT / others
  if (/\bwhy (should|would) i use (this|you) (instead of|over) (chatgpt|chat gpt|gpt|openai)\b/.test(t)) return "comparison";
  if (/\bwhy (is|are) (this|you) (better|different) (than|to) (chatgpt|chat gpt|gpt|openai)\b/.test(t)) return "comparison";
  if (/\b(compare|difference|vs\.?|versus)\b.*\b(chatgpt|chat gpt|gpt|openai)\b/.test(t)) return "comparison";

  // “what files?” / inventory probes
  if (/\bwhat files\??$|\bi haven'?t uploaded any\b|\bno (files|documents) uploaded\b/.test(t)) return "no_files";

  // 👇 NEW: explicit “document store / library contents” inventory questions
  if (/\b(document|doc) store\b|\bwhat (files|documents).*\b(do you have|are in (your|the) (library|store))\b/.test(t)) return "inventory";

  return null;
}
