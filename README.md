# TierYourLife Proxy

The server side of [TierYourLife](https://github.com/kellygracelab-dotcom/TierYourLife).
It exists for one reason: the app used to ship its Gemini and TMDB credentials
inside the APK, where anyone could read them. Now the app holds no credentials
at all and talks to these two endpoints instead.

## Endpoints

| Endpoint | Method | In | Out |
|---|---|---|---|
| `/generate` | POST | `{ "prompt": "..." }` | the image itself, `image/jpeg` |
| `/tmdb/3/search/movie` | GET | `?query=&language=` | TMDB's JSON, unchanged |

`/generate` does more than relay. Gemini answers with JSON carrying the image as
a base64 string; the function decodes it and returns raw bytes, so the phone
never sees base64 and the response is a third smaller.

`/tmdb` is a plain passthrough with the token attached — only the search path is
allowed, so this cannot be used as an open relay.

Wikidata is not proxied. It needs no credentials, and the app calls it directly.

## Access

Both endpoints require a valid **App Check** token (Play Integrity on Android).
Requests without one get a 401, which is what keeps the endpoints from being
called by anything other than the released app.

## Secrets

Never committed. They live in Firebase Secret Manager:

```bash
firebase functions:secrets:set GEMINI_API_KEY
```

```bash
firebase functions:secrets:set TMDB_READ_ACCESS_TOKEN
```

Each command prompts for the value and stores it. `functions/.env` and
`.runtimeconfig.json` are git-ignored so a local override cannot leak either.

## Running it

```bash
npm --prefix functions install
```

```bash
npm --prefix functions run serve
```

The emulator serves the functions on localhost. App Check is not enforced
against the emulator, so a plain `curl` works there.

## Deploying

```bash
firebase deploy --only functions
```

Region is `europe-west1`. `/generate` runs with a 300 second timeout because
image generation regularly takes over a minute — the client's read timeout must
be larger than this one, or it will hang up on a request that was still being
paid for.

## Cost

Cloud Run's free tier covers this comfortably; what actually costs money is
Gemini generation itself, billed per image. `maxInstances` is capped at 10 so a
runaway loop cannot fan out. Set a billing budget alert before the first deploy,
and remember it only sends mail — it does not stop anything.
