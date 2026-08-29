import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import type { Response } from "express";
import { requireAppCheck } from "./appCheck";
import { requireUser } from "./auth";
import { reserveGeneration, settleGeneration } from "./ledger";
import type { ReserveDecision } from "./quota";

const geminiApiKey = defineSecret("GEMINI_API_KEY");

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_MODEL = "gemini-3.1-flash-image";
const ASPECT_RATIO = "3:4";
const IMAGE_SIZE = "1K";
const MAX_PROMPT_LENGTH = 1000;

const CREDITS_HEADER = "X-Credits-Remaining";

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

/**
 * Turns a refused reservation into a response the app can act on. The status
 * codes are distinct on purpose: "buy more" and "wait" are different screens.
 */
function refuse(response: Response, decision: Exclude<ReserveDecision, { outcome: "reserved" }>): void {
  switch (decision.outcome) {
    case "no_credits":
      response.status(402).json({ error: "No generations left", code: "NO_CREDITS" });
      return;
    case "busy":
      response.setHeader("Retry-After", String(decision.retryAfterSeconds));
      response.status(429).json({ error: "A generation is already running", code: "BUSY" });
      return;
    case "daily_ceiling":
      response.setHeader("Retry-After", "3600");
      response.status(503).json({ error: "Daily limit reached", code: "DAILY_CEILING" });
      return;
  }
}

export const generate = onRequest(
  {
    region: "europe-west1",
    secrets: [geminiApiKey],
    timeoutSeconds: 300,
    memory: "512MiB",
    maxInstances: 10,
    // One request per instance. maxInstances alone caps instances, not spending:
    // the gen2 default lets a single instance run many generations at once.
    concurrency: 1,
  },
  async (request, response) => {
    if (request.method !== "POST") {
      response.status(405).json({ error: "Use POST" });
      return;
    }
    if (!(await requireAppCheck(request, response))) {
      return;
    }
    const identity = await requireUser(request, response);
    if (!identity) {
      return;
    }
    const uid = identity.uid;

    // Validated before the ledger is touched, so a malformed request never
    // costs the caller a credit.
    const prompt = String(request.body?.prompt ?? "").trim();
    if (!prompt) {
      response.status(400).json({ error: "Empty prompt" });
      return;
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      response.status(400).json({ error: "Prompt too long" });
      return;
    }

    const startedAtMs = Date.now();
    let reservation: ReserveDecision;
    try {
      reservation = await reserveGeneration(uid, startedAtMs);
    } catch (error) {
      console.error("Could not reserve a generation", error);
      response.status(503).json({ error: "Ledger unavailable", code: "LEDGER_UNAVAILABLE" });
      return;
    }

    if (reservation.outcome !== "reserved") {
      refuse(response, reservation);
      return;
    }

    // From here a credit is held. Every exit must settle it, or the account
    // stays locked until the lease runs out.
    let bytes: Buffer;
    try {
      bytes = await requestImage(prompt);
    } catch (error) {
      await releaseQuietly(uid, false, startedAtMs);
      respondToGenerationFailure(response, error);
      return;
    }

    const remaining = await releaseQuietly(uid, true, startedAtMs);

    response.setHeader("Content-Type", "image/jpeg");
    response.setHeader("Cache-Control", "no-store");
    if (remaining !== null) {
      response.setHeader(CREDITS_HEADER, String(remaining));
    }
    response.status(200).send(bytes);
  },
);

/** Settling must never mask the outcome of the generation itself. */
async function releaseQuietly(
  uid: string,
  succeeded: boolean,
  startedAtMs: number,
): Promise<number | null> {
  try {
    return await settleGeneration(uid, succeeded, startedAtMs);
  } catch (error) {
    console.error("Could not settle a generation", error);
    return null;
  }
}

class GenerationError extends Error {
  constructor(
    message: string,
    readonly clientMessage: string,
  ) {
    super(message);
  }
}

async function requestImage(prompt: string): Promise<Buffer> {
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
  } catch (error) {
    throw new GenerationError(String(error), "Could not reach the image service");
  }

  if (!upstream.ok) {
    console.error("Gemini returned", upstream.status, await upstream.text());
    throw new GenerationError(
      `Gemini returned ${upstream.status}`,
      "Image service refused the request",
    );
  }

  const body = (await upstream.json()) as GeminiResponse;
  const base64 = body.steps
    ?.flatMap((step) => step.content ?? [])
    .find((content) => content.type === "image" && content.data)?.data;

  if (!base64) {
    throw new GenerationError("Gemini response contained no image", "Image service returned no image");
  }

  return Buffer.from(base64, "base64");
}

function respondToGenerationFailure(response: Response, error: unknown): void {
  const clientMessage =
    error instanceof GenerationError ? error.clientMessage : "Image generation failed";
  if (!(error instanceof GenerationError)) {
    console.error("Image generation failed", error);
  }
  response.status(502).json({ error: clientMessage, code: "GENERATION_FAILED" });
}
