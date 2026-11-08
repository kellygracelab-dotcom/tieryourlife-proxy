import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import * as emulator from "../src/emulator";
import { igdbClientId, igdbClientSecret, igdbNamed } from "../src/pictureSearch";

const CLIENT_ID = "test-client-id";
const CLIENT_SECRET = "test+secret&= /?ü";
const ACCESS_TOKEN = "test-access-token";

beforeEach(() => {
  mock.method(emulator, "isDemoEmulator", () => false);
  mock.method(igdbClientId, "value", () => CLIENT_ID);
  mock.method(igdbClientSecret, "value", () => CLIENT_SECRET);
});

afterEach(() => mock.restoreAll());

describe("IGDB's Twitch app token", () => {
  it("posts form-encoded credentials in the body, keeps every URL clean, and uses the token for IGDB", async () => {
    const asked: string[] = [];
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      asked.push(request.url);
      assert.equal(new URL(request.url).search, "");
      assert.equal(request.method, "POST");
      if (request.url === "https://id.twitch.tv/oauth2/token") {
        assert.match(request.headers.get("Content-Type") ?? "", /^application\/x-www-form-urlencoded(?:;|$)/);
        assert.deepEqual(Object.fromEntries(new URLSearchParams(await request.text())), {
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: "client_credentials",
        });
        return Response.json({ access_token: ACCESS_TOKEN, expires_in: 60 });
      }
      assert.equal(request.url, "https://api.igdb.com/v4/games");
      assert.equal(request.headers.get("Authorization"), `Bearer ${ACCESS_TOKEN}`);
      assert.equal(request.headers.get("Client-ID"), CLIENT_ID);
      assert.equal(request.headers.get("Content-Type"), "text/plain");
      assert.match(await request.text(), /where name ~ "Hollow Knight"/);
      return Response.json([{ id: 7331, name: "Hollow Knight", cover: { image_id: "coqa1" } }]);
    });

    const hits = await igdbNamed("Hollow Knight");

    assert.deepEqual(asked, ["https://id.twitch.tv/oauth2/token", "https://api.igdb.com/v4/games"]);
    assert.deepEqual(hits.map((hit) => hit.id), ["igdb:7331"]);
  });

  it("reports a refused token by host and status without exposing credentials or the response body", async () => {
    const asked: string[] = [];
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      asked.push(request.url);
      assert.equal(request.url, "https://id.twitch.tv/oauth2/token");
      return Response.json({ message: CLIENT_SECRET, access_token: ACCESS_TOKEN }, { status: 401 });
    });

    await assert.rejects(igdbNamed("Hollow Knight"), { message: "id.twitch.tv answered 401" });
    assert.deepEqual(asked, ["https://id.twitch.tv/oauth2/token"]);
  });
});
