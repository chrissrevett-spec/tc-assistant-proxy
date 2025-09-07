const { noContent, bad } = require("./_cors");

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return noContent(res);
  if (req.method !== "POST")    return noContent(res);
  try {
    await readBody(req); // we don’t store; this is a stub
    return noContent(res);
  } catch {
    return bad(res, "invalid json");
  }
};

