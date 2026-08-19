import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { requireAppCheck } from "./appCheck";

const tmdbReadAccessToken = defineSecret("TMDB_READ_ACCESS_TOKEN");

const TMDB_BASE_URL = "https://api.themoviedb.org";
const ALLOWED_PATHS = ["/3/search/movie"];

export const tmdb = onRequest(
  {
    region: "europe-west1",
    secrets: [tmdbReadAccessToken],
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

    const path = request.path;
    if (!ALLOWED_PATHS.includes(path)) {
      response.status(404).json({ error: "Unknown path" });
      return;
    }

    const query = new URLSearchParams(
      Object.entries(request.query).map(([key, value]) => [key, String(value)]),
    );

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(`${TMDB_BASE_URL}${path}?${query}`, {
        headers: {
          Authorization: `Bearer ${tmdbReadAccessToken.value()}`,
          Accept: "application/json",
        },
      });
    } catch {
      response.status(502).json({ error: "Could not reach the catalogue" });
      return;
    }

    if (!upstream.ok) {
      console.error("TMDB returned", upstream.status);
      response.status(upstream.status).json({ error: "Catalogue refused the request" });
      return;
    }

    response.setHeader("Content-Type", "application/json");
    response.status(200).send(await upstream.text());
  },
);
