import { onRequest } from "firebase-functions/v2/https";
import { requireAppCheck } from "./appCheck";
import { requireUser } from "./auth";
import { readCredits } from "./ledger";

/**
 * What the studio shows before anything is typed. Read-only: it never creates
 * an account and never moves a credit.
 */
export const credits = onRequest(
  {
    region: "europe-west1",
    timeoutSeconds: 30,
    memory: "256MiB",
    maxInstances: 10,
  },
  async (request, response) => {
    if (request.method !== "GET") {
      response.status(405).json({ error: "Use GET" });
      return;
    }
    if (!(await requireAppCheck(request, response))) {
      return;
    }
    const identity = await requireUser(request, response);
    if (!identity) {
      return;
    }

    try {
      const remaining = await readCredits(identity.uid);
      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({ credits: remaining });
    } catch (error) {
      console.error("Could not read credits", error);
      response.status(503).json({ error: "Ledger unavailable", code: "LEDGER_UNAVAILABLE" });
    }
  },
);
