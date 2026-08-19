import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { requireAppCheck } from "./appCheck";

const geminiApiKey = defineSecret("GEMINI_API_KEY");

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_MODEL = "gemini-3.1-flash-image";
const ASPECT_RATIO = "3:4";
const IMAGE_SIZE = "1K";
const MAX_PROMPT_LENGTH = 1000;

interface GeminiContent {
  type?: string;
  data?: string;
}

interface GeminiStep {
  content?: GeminiContent[];
}

interface GeminiResponse {
  steps?: GeminiStep[];
}

export const generate = onRequest(
  {
    region: "europe-west1",
    secrets: [geminiApiKey],
    timeoutSeconds: 300,
    memory: "512MiB",
    maxInstances: 10,
  },
  async (request, response) => {
    if (request.method !== "POST") {
      response.status(405).json({ error: "Use POST" });
      return;
    }
    if (!(await requireAppCheck(request, response))) {
      return;
    }

    const prompt = String(request.body?.prompt ?? "").trim();
    if (!prompt) {
      response.status(400).json({ error: "Empty prompt" });
      return;
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      response.status(400).json({ error: "Prompt too long" });
      return;
    }

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(GEMINI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": geminiApiKey.value(),
        },
        body: JSON.stringify({
          model: GEMINI_MODEL,
          input: [{ type: "text", text: prompt }],
          response_format: {
            type: "image",
            aspect_ratio: ASPECT_RATIO,
            image_size: IMAGE_SIZE,
            mime_type: "image/jpeg",
          },
        }),
      });
    } catch {
      response.status(502).json({ error: "Could not reach the image service" });
      return;
    }

    if (!upstream.ok) {
      console.error("Gemini returned", upstream.status, await upstream.text());
      response.status(502).json({ error: "Image service refused the request" });
      return;
    }

    const body = (await upstream.json()) as GeminiResponse;
    const base64 = body.steps
      ?.flatMap((step) => step.content ?? [])
      .find((content) => content.type === "image" && content.data)?.data;

    if (!base64) {
      console.error("Gemini response contained no image");
      response.status(502).json({ error: "Image service returned no image" });
      return;
    }

    const bytes = Buffer.from(base64, "base64");
    response.setHeader("Content-Type", "image/jpeg");
    response.setHeader("Cache-Control", "no-store");
    response.status(200).send(bytes);
  },
);
