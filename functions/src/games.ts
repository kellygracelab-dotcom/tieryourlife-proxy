import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { requireAppCheck } from "./appCheck";
import {
  IGDB_GAMES_ENDPOINT,
  type TokenState,
  gamesQuery,
  isSearchable,
  toCatalogue,
  tokenFrom,
  tokenIsUsable,
} from "./igdb";

const twitchClientId = defineSecret("TWITCH_CLIENT_ID");
const twitchClientSecret = defineSecret("TWITCH_CLIENT_SECRET");

const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";

/**
 * Held between requests on purpose. A warm instance answers many searches, and
 * Twitch hands out a token that lasts about two months -- fetching one per
 * search would be a second round trip on every keystroke for nothing.
 */
let cached: TokenState | null = null;

async function appToken(): Promise<string | null> {
  if (tokenIsUsable(cached, Date.now())) {
    return cached.token;
  }
  const body = new URLSearchParams({
    client_id: twitchClientId.value(),
    client_secret: twitchClientSecret.value(),
    grant_type: "client_credentials",
  });
  let reply: globalThis.Response;
  try {
    reply = await fetch(TWITCH_TOKEN_URL, { method: "POST", body });
  } catch {
    return null;
  }
  if (!reply.ok) {
    console.error("Twitch refused a token", reply.status);
    return null;
  }
  const fresh = tokenFrom((await reply.json()) as Record<string, unknown>, Date.now());
  if (!fresh) {
    console.error("Twitch returned a token we cannot use");
    return null;
  }
  cached = fresh;
  return fresh.token;
}

/**
 * Games, by name, with their covers.
 *
 * The query is built here rather than passed through. IGDB speaks a small
 * language of its own, and forwarding whatever a caller wrote would let anyone
 * with the app's App Check token ask this project's IGDB account anything at
 * all. The client sends a search term; the shape of the question is ours.
 */
export const games = onRequest(
  {
    region: "europe-west1",
    secrets: [twitchClientId, twitchClientSecret],
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

    const term = String(request.query.q ?? "");
    if (!isSearchable(term)) {
      response.status(200).json({ results: [] });
      return;
    }

    const token = await appToken();
    if (!token) {
      response.status(502).json({ error: "Could not reach the catalogue" });
      return;
    }

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(IGDB_GAMES_ENDPOINT, {
        method: "POST",
        headers: {
          "Client-ID": twitchClientId.value(),
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        body: gamesQuery(term),
      });
    } catch {
      response.status(502).json({ error: "Could not reach the catalogue" });
      return;
    }

    // A token can be withdrawn before it expires. One retry with a fresh one,
    // and only one: a second failure is not a stale token.
    if (upstream.status === 401) {
      cached = null;
      const retry = await appToken();
      if (!retry) {
        response.status(502).json({ error: "Could not reach the catalogue" });
        return;
      }
      try {
        upstream = await fetch(IGDB_GAMES_ENDPOINT, {
          method: "POST",
          headers: {
            "Client-ID": twitchClientId.value(),
            Authorization: `Bearer ${retry}`,
            Accept: "application/json",
          },
          body: gamesQuery(term),
        });
      } catch {
        response.status(502).json({ error: "Could not reach the catalogue" });
        return;
      }
    }

    if (!upstream.ok) {
      console.error("IGDB returned", upstream.status);
      response.status(upstream.status).json({ error: "Catalogue refused the request" });
      return;
    }

    response.status(200).json({ results: toCatalogue((await upstream.json()) as never[]) });
  },
);
