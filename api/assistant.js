// /api/assistant.js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { userMessage, threadId } = req.body;
    const stream = req.query.stream !== "off"; // default true unless ?stream=off

    if (!userMessage) {
      return res.status(400).json({ error: "Missing userMessage" });
    }

    // Reuse thread if provided, otherwise create new
    const thread = threadId
      ? { id: threadId }
      : await client.beta.threads.create();

    const run = await client.beta.threads.runs.createAndStream(thread.id, {
      assistant_id: process.env.ASSISTANT_ID,
      instructions: userMessage,
    });

    if (!stream) {
      // collect all events into one message
      let fullText = "";
      for await (const event of run) {
        if (event.type === "response.output_text.delta") {
          fullText += event.delta;
        }
      }
      return res.status(200).json({ text: fullText });
    } else {
      // stream out directly
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      for await (const event of run) {
        res.write(`event: ${event.type}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } catch (err) {
    console.error("Error in assistant handler:", err);
    res.status(500).json({ error: err.message });
  }
}
