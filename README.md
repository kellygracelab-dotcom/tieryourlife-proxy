# TierYourLife Proxy

The server side of [TierYourLife](https://github.com/kellygracelab-dotcom/TierYourLife).
It started as a relay so the app would stop shipping its Gemini and TMDB
credentials inside the APK. It now also decides who may spend them: image
generation costs real money per image, and the only place that can be counted
on to meter it is the side holding the key.

## Endpoints

| Endpoint | Method | In | Out |
|---|---|---|---|
| `/generate` | POST | `{ "prompt": "..." }` | the image itself, `image/jpeg` |
| `/credits` | GET | — | `{ "credits": 7 }` |
| `/tmdb/3/search/movie` | GET | `?query=&language=` | TMDB's JSON, unchanged |
| `/boards` | GET | `?after=` | `{ "boards": [...], "next": null }` |
| `/boards/{uid}` | GET | — | the board, whole |
| `/boards/{uid}` | PUT | the board plus `basedOn` | `{ "uid": "...", "revision": 4 }` |
| `/boards/{uid}` | DELETE | — | nothing, `204` |

`/generate` does more than relay. Gemini answers with JSON carrying the image as
a base64 string; the function decodes it and returns raw bytes, so the phone
never sees base64 and the response is a third smaller. Successful responses
carry the balance left in `X-Credits-Remaining`.

`/tmdb` is a plain passthrough with the token attached — only the search path is
allowed, so this cannot be used as an open relay.

Wikidata is not proxied. It needs no credentials, and the app calls it directly.

## Keeping boards

A board lives in Room on the phone, and until this existed that was the only
place it lived: reinstalling, or a new phone, took someone's boards with it.
`/boards` is the copy an account keeps, so they come back.

It is not the published snapshot. A published list is a picture arranged for
strangers; this is the board itself — the pool, the trash, the order of
everything, and the identifiers that let a second phone recognise a board it has
already seen instead of duplicating it.

Three things it does deliberately:

**Guests are refused.** An anonymous identity lives inside the install, so a
backup kept under one is destroyed by the very event it protects against. There
is no point charging for storage nobody can ever reach again. `GET /boards`
answers a guest with an empty list rather than a 403, because asking is what the
app does on every start.

**A write says what it was based on.** The device sends `basedOn`, the revision
it was working from. If the account has moved on since, the write is refused
with `409` and the stored board comes back in the body. There is no arithmetic
that merges two arrangements of the same cards — the order *is* the content, and
an automatic merge invents an afternoon neither person had. So the app keeps
both, and the second one carries the name of the phone that wrote it.

**Deleting leaves a marker.** The document stays, emptied, with `deleted: true`.
Without it the account forgets the board, the other phone still has it, and the
next sync puts it back — a delete that will not stick.

## Access

`/generate` and `/credits` need two things:

- an **App Check** token (Play Integrity on Android) — answers *is this the
  released app*;
- a **Firebase ID token** in `Authorization: Bearer …`, from anonymous sign-in —
  answers *which install*.

App Check alone cannot meter anything: it is satisfied by every copy of the real
app equally. The uid is never read from the request body; it comes out of a
token Firebase signed, so a caller cannot name itself, let alone name someone else.

`/tmdb` deliberately requires App Check only. It costs nothing per call, and
tying catalogue search to sign-in would mean an auth hiccup takes out search as
well as generation.

## Quota

Every generation is reserved before Gemini is called and settled after:

1. Reserve — take one credit and hold the account for a six minute lease.
2. Generate.
3. Settle — on success the credit stays spent; on failure it goes back.

Deducting first is the point. If the credit were taken on success, a dropped
connection would hand out an image nobody paid for. A run that dies without
settling keeps the credit spent: past the reservation there is no way to tell
whether Gemini billed us, and guessing in the caller's favour means a free image
on every crash.

Three limits, not one:

| Limit | Where | Default |
|---|---|---|
| Credits per account | `accounts/{uid}` | 10, granted on the first generation |
| One generation at a time | the lease on the account | 6 minutes |
| Service-wide per UTC day | `usage/{YYYY-MM-DD}` | 500 |

The daily ceiling is the one that saves you from a mistake nobody predicted. It
is not a business rule — set it well above honest use and treat it tripping as
an alarm. `concurrency: 1` on `/generate` is part of the same defence:
`maxInstances` caps instances, and a gen2 instance will otherwise run many
generations at once, so the two together are what actually bound spending.

Refusals are distinct because they need different screens:

| Status | `code` | Meaning |
|---|---|---|
| 402 | `NO_CREDITS` | balance empty — the caller can act on this |
| 429 | `BUSY` | a generation is already running, `Retry-After` set |
| 503 | `DAILY_CEILING` | service-wide limit, nothing the caller can do |

All three constants live at the top of [`functions/src/quota.ts`](functions/src/quota.ts).

## Firestore

All of it written only by these functions. `firestore.rules` denies
clients outright and the Admin SDK bypasses rules — a client that could write
its own balance would never need to buy anything.

```
accounts/{uid}                credits, inFlightUntil, totalGenerated, createdAt, updatedAt
accounts/{uid}/boards/{uid}   one person's board, kept for their next phone
usage/{YYYY-MM-DD}            generations
publishedLists/{id}           a board someone put in the feed
```

Deploy the rules alongside the functions:

```bash
firebase deploy --only firestore:rules,functions
```

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

## Tests

The rules that decide whether a generation may happen are pure functions in
`quota.ts` — no Firestore, no clock, no network. `ledger.ts` is the only file
that turns those decisions into writes, and it holds no rules of its own. So the
cases that matter are tested without an emulator, with the runner built into Node:

```bash
npm --prefix functions test
```

```bash
npm --prefix functions run check
```

`check` builds and tests, and is what CI runs on every push and pull request.

## Running it

```bash
npm --prefix functions install
```

```bash
npm --prefix functions run serve
```

The emulator serves functions, Firestore and Auth together — the ledger needs
all three. App Check is not enforced against the emulator, so a plain `curl`
works there, but `/generate` still wants an ID token from the Auth emulator.

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
Gemini generation itself, billed per image. The quota above is the real control.
Set a billing budget alert as well — and note it belongs on the Google Cloud
project that owns the Gemini key, which is not this Firebase project. Remember
it only sends mail: it does not stop anything.
