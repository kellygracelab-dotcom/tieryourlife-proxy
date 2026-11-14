# TierYourLife proxy: the contract

The one description of what the proxy answers, read by the website and by the Android app. It is written from `functions/src`; where this file and the code disagree, the code is right and this file has a bug.

> **Rule.** A PR that changes a request or a response shape (a path, a method, a field, a status, an error `code`, a limit, a cursor) updates CONTRACT.md in the same PR. `functions/test/contract.test.ts` fails when a path word the routers answer is missing here, and when an exported function is not named here.

## Contents

- [Conventions](#conventions)
- [Public image addresses](#public-image-addresses)
- [Limits](#limits)
- [`lists`](#lists): feed, publishing, follows, reports, rankings, topics, sections, staff, house lists, picture search
- [`boards`](#boards)
- [`adoptGuestCredits`, `credits`, `generate`, `tmdb`](#adoptguestcredits)
- [Background functions](#background-functions)
- [Shapes](#shapes)
- [E2E](#e2e)
- [The website's functions](#the-websites-functions-tieryourlife-webfunctions)

## Conventions

**Base URL.** Every function is in `europe-west1`: `https://europe-west1-tieryourlife.cloudfunctions.net/<function>`. A path after the function's name is the route. Behind Hosting the function's own name arrives as the first segment as well (`/lists/lists/mine`); `lists`, `boards` and `tmdb` accept both forms, so `/lists/mine` and `/lists/lists/mine` are the same route. Below, routes are written as `/<function>/<route>`.

**Access.** Each route says which of these it needs:

| Word | Means |
|---|---|
| App Check | `X-Firebase-AppCheck: <token>`. Missing or invalid: `401 APP_UNVERIFIED`. Checked first on every function, except that `generate` says `GENERATION_OFF` before it. |
| user | `Authorization: Bearer <Firebase ID token>`, a guest's (anonymous sign-in) included. Missing or invalid: `401 UNAUTHENTICATED`. Every route of `lists`, `boards`, `credits`, `adoptGuestCredits`, `generate` needs it. A write (any method but `GET`, `HEAD`, `OPTIONS`) with a token whose uid was erased since (`DELETE /boards/account`), a guest's token from before it linked a provider included, gets **`401 ACCOUNT_ERASED`**, on every function, before anything is read or written; `503 UNAVAILABLE` when that cannot be checked. Reads go on and find nothing. |
| account | A user whose sign-in provider is not `anonymous`. A guest gets `403 NOT_SIGNED_IN` unless the route says otherwise. |
| not banned | An account without a live ban, its own (`bans/{uid}`) or one kept from an account the same person erased (`bannedIdentities`, see `DELETE /boards/account`): else `403 {error, code: "BANNED", until}` (`until` is epoch ms, or `null` for forever; of two bans, the one that lifts last). |
| staff | The owner or a moderator. Else `403 NOT_YOURS`. |
| owner | The owner alone: the account whose uid is `MODERATOR_UID` or whose verified e-mail is `MODERATOR_EMAIL`. A moderator gets `403 {code: "NOT_YOURS", detail: "owner_only"}`, anybody else `403 NOT_YOURS`. |

**Errors.** A refusal is JSON `{error, code, detail?}`: `error` is English for logs, `code` is what a client branches on. A few old refusals carry no `code`: `405 {error: "Use GET…"}` for a wrong method, `400 {error: "Which list?"}` / `"Which board?"`, `404 {error: "No such address"}` on `boards`, `400 Empty prompt` / `Prompt too long` on `generate`, and `tmdb`'s `404 Unknown path` / `502`. Any error the code did not expect is `503 UNAVAILABLE` on `lists` and `boards`.

**Times** are epoch milliseconds. **Colours** are `#RRGGBB`. **Text** is collapsed (runs of whitespace become one space), trimmed, and cut to its limit rather than refused, unless a limit says it refuses.

**Ids.** A list id or topic id is `[A-Za-z0-9_-]{1,64}`. A section id is `[a-z0-9][a-z0-9_-]{1,39}`. An author uid for follows is `[A-Za-z0-9]{8,128}`. A picture id (a file in the caller's `users/{uid}/pictures/` in Storage) is `[A-Za-z0-9_-]{1,64}`.

**Locales.** Sections and topics carry `names` keyed by `en uk ru es pt-BR de fr pl tr ja ar`. House-list translations are keyed by the same set without `en`.

**Built-in sections**, in their order: `anime`, `film_tv`, `games`, `music`, `books`, `food`, `sport`, `people`, `other`. They are made the first time anything reads sections, and `other` is always last and never hidden.

## Public image addresses

In `lists` JSON responses, image fields (including covers, cards, preview images,
section/topic pictures, collages and author faces) use the existing absolute
`https://tieryourlife.web.app/img/original/{published|avatars|sections|topics}/{id}/{picture}`
address for recognized public objects in `tieryourlife.firebasestorage.app`.
This lets older Android image loaders display them when Storage requires App
Check. Other image hosts remain unchanged. `users/` and pending `proposals/`
never become public addresses; their existing authentication/token and visibility
rules still apply. This does not add a Proxy route or relax Storage rules.

Old Firebase `alt=media` addresses and these site addresses are accepted on
republish and refer to the same stored picture, copy source, cleanup name and
ranking card identity. Stored snapshots keep canonical Storage addresses; reads
do not migrate documents. IDs, titles and credits are unchanged. Boards answer
canonical Storage addresses, their shared catalogue copies included
(`published/catalogue/{picture}`, which the site serves as
`/img/original/published/catalogue/{picture}`).

## Limits

| What | Limit | Where |
|---|---|---|
| List title, tier label, card title, board title, tier name in a ranking | 80 characters | `publishing.ts`, `sync.ts` |
| Tier caption | 60 | `publishing.ts`, `sync.ts` |
| Picture credit | 1000 | `pictureCredit.ts`, `publishing.ts`, `sync.ts` |
| Pictures by link | 400 fetches a UTC day and 200 an hour per account; a repeat the same day is free | `pictureSearchLimit.ts`, `pictureLinks.ts` |
| Picture attribution | `author` 300, `license` 100, `licenseUrl`, `link`, `originalUrl` 500, `id` 100, `formerUrls` 5 | `pictureAttribution.ts` |
| Picture address (`https://` only, others dropped) | 2000 | `publishing.ts`, `sync.ts` |
| Ranked tiers per list | 19 on a new list, else `400 TOO_MANY_TIERS`; a replace keeps up to as many as the stored list has, if that is more (some lists have 20) | `MAX_RANKED_TIERS`, `tierLimitFor` |
| Tiers per board | 20, **the pool included**: 19 ranked tiers and the pool | `MAX_TIERS_PER_BOARD` |
| Tier names in a ranking | 20 | `MAX_TIERS_PER_LIST` |
| Cards per list | 2000 (at least 1) | `MAX_ITEMS_PER_LIST` |
| Cards per board | 2000 live (without `deletedAt`, 0 allowed), plus up to 2000 more in the trash: at most 4000 in the body | `MAX_ITEMS_PER_BOARD`, `MAX_TRASHED_ITEMS_PER_BOARD` |
| A list snapshot, a board, as JSON | 700 000 UTF-8 bytes, else `413 TOO_LARGE`; resolved image URLs and retained publication fields count too | `MAX_SNAPSHOT_BYTES`, `MAX_BOARD_BYTES` |
| Own photographs (distinct picture ids) per list | 200 | `MAX_OWN_PICTURES_PER_LIST` |
| Pictures from other sites (distinct addresses, not catalogue art, not already copied) per list | 200, else `413 TOO_LARGE` | `MAX_OUTSIDE_PICTURES_PER_LIST` |
| Fetching a picture from another site to publish it | https only, no private or loopback address, 4 MB (read no further), 3 redirects, 8 s a hop, JPEG, PNG, GIF or WebP by the bytes; 4 at once; 12 s for a whole publication (6 s for a face), counted from the start and never waited past: what is not done by then is dropped; 400 fetches per account per UTC day, faces included, reused copies free | `outsidePictures.ts` |
| Cover collage (`coverImageUrls`) | 6, deduplicated | `MAX_PREVIEW_IMAGES` |
| New public lists per author | Production: 50 new lists in the preceding rolling seven days (`functions/.env.tieryourlife`, `PUBLIC_LISTS_PER_SEVEN_DAYS=50`). Without that setting (emulators, other projects): 50 current public lists. The house is exempt. Both claims are transactional | `MAX_LISTS_PER_AUTHOR`, `publishLimit.ts`, `publicListQuota.ts` |
| Boards kept per account | 200 not deleted | `MAX_BOARDS_PER_ACCOUNT` |
| Board uid, tier uid, item uid, `boardUid` of a publication | 1–100 characters | `sync.ts`, `readBoardUid` |
| Board fingerprint | 128 | `MAX_FINGERPRINT_LENGTH` |
| Device name | 40 | `MAX_DEVICE_NAME_LENGTH` |
| A game on a board | 2–2000 cards, up to 14000 answers (full-size Swiss + refine), kept 30 days after its last write | `sync.ts` |
| Follows of authors, of topics, of sections | 200 each | `MAX_FOLLOWING` |
| Report note | 500 | `MAX_NOTE_LENGTH` |
| Topic name | 2–40 characters, a letter or digit in it, refused otherwise | `topics.ts` |
| Waiting topics per account | 3 | `MAX_PENDING_TOPICS_PER_ACCOUNT` |
| Section name | 2–24 characters (an emoji is one), a letter or digit in it, refused otherwise | `sections.ts` |
| Waiting section proposals per account | 3 | `MAX_PENDING_SECTIONS_PER_ACCOUNT` |
| Section proposals per account per 24 h | 10 | `MAX_PROPOSALS_PER_DAY` |
| Decline note | 300 | `MAX_DECLINE_NOTE_LENGTH` |
| Section or topic picture | JPEG, PNG or WebP, at least 960 px wide, 16:10 ±2 % | `imageSize.ts` |
| House translations | 2000 per locale, 200 characters a side, the list document 1 000 000 bytes with them | `editorial.ts` |
| Picture search query | 2–100 characters, page 1–20 | `pictureSearch.ts` |
| Picture searches | 1000 per account per UTC hour, 3000 per UTC day; only searches that ask a catalogue count (see `GET /lists/pictures`) | `pictureSearchLimit.ts` |
| Resting catalogue | after 429 or 5xx: its `Retry-After`, at most 1 h; else 5 minutes; for every instance | `pictureSources.ts` |
| Web picture search | asked only when fewer than 6 good hits; 30 per account per day; 50 000 a month for everyone | `pictureSources.ts` |
| Kept web picture | 4 MB (read no further), 3 redirects, 300 attempts per account per day, refused ones too | `pictureSearch.ts` |
| Own picture in Storage (`users/{uid}/pictures/`) | under 4 MB, declared `image/jpeg`, `png`, `webp` or `gif` (rules); the bytes must start as JPEG, PNG, GIF or WebP; 2000 uploads per account per UTC day; otherwise `checkUpload` removes it right after it lands | `storage.rules`, `pictureBytes.ts` |
| Generation prompt | 1000 | `generate.ts` |
| Free generations, daily ceiling, lease | 3 per account, 100 a UTC day, 6 minutes | `quota.ts` |
| Page sizes | feed, house, anonymous, admin lists 20; topics 20 (max 50); rankings 30; board index 100; reports read 50; own topics, pending topics 100 | |

## `lists`

All routes: App Check and user. `lists` keeps one instance warm.

### Feed and reading

**`GET /lists`**: the feed. Query, all optional:
- `category`: a section id; anything else means no filter.
- `author`: a uid. An anonymous list never appears on its author's page.
- `topic`: a topic id.
- `q`: search words (lower-cased, cut to 80). A list matches when its search keys hold every word; keys cover the title in every language once the search sweep has run. A `q` with no usable word answers `{lists: [], nextCursor: null}`.
- `sort`: `recent` (default) or `popular` (by `takeCount`).
- `following=1`: only lists by followed authors, followed topics and followed sections (an anonymous list arrives by topic or section, never by author).
- `after`: the `nextCursor` of the page before.

Answer `200 {lists: ListSummary[], nextCursor: string | null}`, plus `followingNobody: true` when `following=1` and the caller follows nothing. Lists under review are left out. **Cursor:** without `following=1` it is the last list's id; with it, `"<updatedAt or takeCount>:<id>"`. A short page is the last; a full page may be followed by an empty one. `409 CURSOR_GONE` when the list an id cursor names was taken down meanwhile: start again from the top.

**`GET /lists/{id}`**: `200 ListSummary + {tiers: PublishedTier[], items: PublishedItem[], translations, picturesFrom, underReview, revision, coverAttribution?}`. `revision` (since 14.11.2026): the list's revision, **List revision** below. `coverAttribution`: the house editor's credit for the cover (**Editor's credit** below), only on a house list that has one. `picturesFrom`: the ids of the lists whose pictures this one holds copies of, as `published/{id}/{original}-{name}`; a client editing its own list sends those addresses back as they are, and copies everything else in its folder as its own photos. `404 NOT_FOUND` when there is none, or it is under review and the caller is neither staff nor its author. `underReview` says whether it is out of the feed.

**`GET /lists/mine`**: the caller's own lists, newest first, not paged: `200 {lists: (ListSummary + {authorUid, authorName, authorPhotoUrl, anonymous} as stored + {proposedSection, proposedSectionName} + boardUid? + underReview)[]}`. `underReview: true` means the list is out of the feed for moderation: its author sees it, nobody else does. `proposedSection` is the waiting proposal the list will move into, or `null`. `boardUid` is present when the publication said it.

**`GET /lists/following`**: whom and what the caller follows: `200 {authors: {uid, name, photoUrl}[], topics: Topic[], sections: {id, followerCount}[]}`. An author with no named list left has `name: ""`.

### Publishing

**Known provenance is immutable.** When `boardUid` names a kept board with a known original (`origin.listId` or its legacy `takenFrom`), a new publication and `/lists/classify` must use that original. A conflicting body `takenFrom` is `400 {code: "INVALID", detail: "takenFrom"}`; the private lineage is checked again in the public-write transaction. The source version may advance for that same original, with fresh positional bindings. Boards with no known provenance retain the legacy path.

For card comparison, a new owned `pictureId` with no effective public `imageUrl` is a content change. Its private id/image is never returned by preflight. The same public image URL still matches the original; when both a public URL and an owned picture are supplied, the public URL wins, exactly as publication stores it. Deezer art is dropped before this decision, so a retained owned photo then is the effective new image.

**`POST /lists/classify`**: read-only publication preflight, App Check and user (guests included). Takes the same draft body as `POST /lists`, including `takenFrom`, `sourceVersion`, `boardUid` and optional `items[].sourceIndex`. Answers `200 {kind: "list", basedOn, version?}` or `200 {kind: "ranking", listId, version}`. It writes nothing, copies no pictures, consumes no list slot and never publishes on its own. Clients use this result to name the explicit public action; `POST /lists` repeats the authoritative decision and source-version check before writing. Draft-shape refusals match publication; stale source gives `409 LIST_CHANGED`, invalid mapping/version gives `400 INVALID`. No separate criterion field exists: the list title and ordered tier labels/captions carry the current content semantics. No weekly publication quantity is enabled by default. The optional rolling policy below applies only to new independent public lists, with idempotent `boardUid` retries, Rankings, private saves and updates exempt.

**New-list quota (production: 50 a rolling week).** `PUBLIC_LISTS_PER_SEVEN_DAYS` unset, blank, or `off` retains the existing 50-current-list behavior and adds no rolling events or restrictions. Only an explicitly configured positive integer N enables the rolling policy, replacing the 50-current-list cap. Invalid configuration fails as `503 UNAVAILABLE` for a new independent public list; it cannot silently enable an invented number. Production sets N=50 in the tracked `functions/.env.tieryourlife`, which holds only this public number.

When enabled, each newly created independent public list, including an attributed derivative, consumes one event in the same Firestore transaction that creates it. Exact source copies become Rankings before the quota is considered. `POST /lists/{id}` updates, both Ranking write paths/withdrawal, private boards, preflight and editorial/house publication consume no event. A repeated `boardUid` returns its existing publication without spending, including parallel retries at a full quota. Deleting/unpublishing a list does not refund its event; publishing that board anew is a new list. Events at exactly seven days expire. Fifty older public lists do not prevent publishing again after the window. No historical public lists are migrated or counted as fresh events.

An exhausted rolling policy returns **`409 {error, code: "TOO_MANY_LISTS", retryAt}`**, with `retryAt` in epoch milliseconds and `Retry-After` in whole seconds. The existing code/status remains compatible; optional retry metadata tells updated clients when another new list may be published. There is no reservation and no event on rejection. Clients keep the private edit and explain waiting until that time; deleting a public list does not help. Existing clients whose message advises unpublishing must receive suitable wait wording before policy activation. The default-OFF current-list refusal remains unchanged and has no `retryAt`.

Rolling history uses `publishLocks/{authorUid}.publicListEvents`, bounded to live committed timestamps and shared by concurrent publication transactions. A committed timestamp ahead of the current instance's clock remains live until its own seven-day expiry; a backward clock cannot reopen a spent slot. History is retained when the policy is off, unchanged by updates/deletes/Rankings and removed by the existing account-erasure path. No new collection, rule, index, migration, client-writable setting or production clock override is introduced. Android from versionCode 483 and the website show the date from `retryAt`; older clients show their legacy wording.

**`POST /lists`**: publish a board. **`POST /lists/{id}`**: replace a list the caller published. Account, not banned. A list out of the feed (`underReview`) stays out after it is replaced, until staff dismiss its reports; the new snapshot is not kept (`reviewed` false). An author who withdraws a list while it is out of the feed is held: each list they publish or replace starts out of the feed, with a note naming the withdrawn list in the reports queue, until staff take down or dismiss the withdrawn list's reports, take down a held list, or 14 days pass. Dismissing a held list puts that one back and leaves the hold.

Body:
- `title`: string, required.
- `category`: section id, required. It must be an approved, not hidden section; or one the list already sits in (a republish keeps a section after it is hidden); or the caller's own waiting or declined proposal, in which case the list is filed under the proposal's `fileUnder` (or `other`) and, while the proposal waits, moves in when it is approved; or a merged section, followed to where it went. Else `400 {code: "INVALID", detail: "category"}`.
- `tiers`: the ranked tiers, 1–19 of `{label, caption?, colorLight, colorDark}` (the pool is not a tier here: its cards are the unranked ones). More is `400 TOO_MANY_TIERS`. A replace may keep as many as the stored list already has, when that is more than 19.
- `items`: 1–2000 of `{title?, imageUrl?, pictureId?, tierIndex?, credit?, attribution?}`. A card needs a title or a picture. Of `attribution` (see **Picture attribution** below) only `link`, `originalUrl` and, on a card with a `pictureId`, `source: "web"` are read; the server works out the rest, except the house editor's credit (**Editor's credit** below). `tierIndex` out of range, or absent, means unranked. `pictureId` names the caller's own photograph, which is copied to `published/{listId}/` after Vision SafeSearch passes it. An address into another list's published folder (`/o/published%2F{other}%2F{name}`), from a list saved and published again, is copied into this list's own folder as `{other}-{name}` and the list points at the copy, so it outlives the original being edited or withdrawn; one whose original is already gone is left out. **Any other address** (`imageUrl`, `coverImageUrl`, `coverImageUrls`) is shown as it is only when it is catalogue art, on one of the hosts `image.tmdb.org`, `s4.anilist.co`, `images.igdb.com`, `shared.akamai.steamstatic.com`, `cdn-images.dzcdn.net`, `e-cdns-images.dzcdn.net` (Deezer's, which publishing drops anyway; see below), `covers.openlibrary.org`, `inaturalist-open-data.s3.amazonaws.com`, `static.inaturalist.org`, `commons.wikimedia.org`, `upload.wikimedia.org` and `thumb.wikimedia.org` (Wikimedia's thumbnail host: the same paths and bytes) under `/wikipedia/commons/` only (read as a card keeps them, **Commons addresses** below) (exactly these, `CATALOGUE_HOSTS`; a local Wikipedia's own uploads, such as fair-use pictures under `/wikipedia/en/`, are pictures from another site since 13.11.2026), or this list's own copy (`https://firebasestorage.googleapis.com/v0/b/{bucket}/o/published%2F{listId}%2F{name}`). Everything else is fetched by the proxy, looked at by Vision SafeSearch and copied to `published/{listId}/w-{32 hex}`, and the list points at the copy: the same address always lands on the same name, so publishing the list again with the original address, or with the copy's, fetches nothing. One that cannot be fetched (unreachable, a private address, too big, not a JPEG, PNG, GIF or WebP by its bytes, an animated GIF or WebP, whose first frame is all Vision sees, or not done in time) or that Vision answers nothing about is dropped: its card publishes without art, a cover or collage picture is left out, and the answer counts it in `droppedPictures`. The list records `picturesFrom` (those lists' ids, and theirs in turn; also read off the names of its own copies, `{original}-{name}`, so sending the copy's own addresses again keeps it): when staff take one of them down, its pictures are deleted from every copy, a copy of a copy included. An `imageUrl` or `coverImageUrl` into the caller's own folder (`/o/users%2F{uid}%2Fpictures%2F{id}`) is taken as that `pictureId` or `coverPictureId`; one into anyone else's folder is dropped, and so are own-folder addresses in `coverImageUrls`. A board kept in the account (`PUT /boards`) keeps its own-folder collage as sent.
- `coverImageUrl`, `coverPictureId`, `coverImageUrls` (the chosen collage, up to 6): optional.
- `coverAttribution`: a house publication only, the editor's credit for the cover (**Editor's credit** below); `null` takes it off, absent keeps the one the same cover had.
- `anonymous`: `true` publishes without the author's name; `false` with it; absent keeps what a republished list was (a new one is named).
- Topic, at most one of: `topicId` (an existing topic; one merged into another means the topic it ended up at), `newTopic` (a name; reuses an approved topic of that name, or the caller's own waiting one, else proposes a new one, which holds the list in `other` until a moderator decides), or **`noTopic: true`**, which takes the topic off. Sending none of them (or `null`) on a republish keeps the list's topic while it stays in the same section, and moves it into the topic its proposal became. Two at once: `400 INVALID`.
- **Staff moves hold.** On a replace of a list staff moved (`movedByStaff`, see `POST /lists/{id}/move`), each moved field is judged on its own. A body that brings the field's `from` value, or does not bring the field at all (for the topic: none of `topicId`, `newTopic`, `noTopic`), keeps the staff's `to`. A body that brings another value, `newTopic`, or `noTopic: true` for the topic, wins, and that part of `movedByStaff` is cleared. The `topicId` in the answer is what was stored.
- `takenFrom`: the id of the list this board was copied from. For a **new** publication the server compares the real source with normalized `title`, the ordered tier labels/captions, and the multiset of cards (each card's title **and** canonical picture, including duplicate occurrences). Identical content or a mere rearrangement becomes the caller's Ranking of the original: `200 {id: <original id>, ranking: true}`. The comparison accepts the base source or **one whole official house-list language version**, with untranslated texts falling back to the base. It never mixes fields from different locales. A Russian official copy therefore remains a Ranking; a manual title/card/tier-caption edit outside those coherent versions permits a derivative. Tier colors, placements, local IDs, cover, category and picture credits do not create a distinct list. A distinct list carries `basedOn` credit (nobody by name for an anonymous source; none for a missing or own source). A hidden foreign source is `409 LIST_CHANGED`, also if it became hidden without changing its timestamp; visibility and content are rechecked in the write transaction. Existing public lists keep their type on `POST /lists/{id}`; there is no migration. A stored private board's provenance is also used when `boardUid` is supplied but the client omitted `takenFrom`.
- `sourceVersion?`: the source's `updatedAt` as read. `409 {code: "LIST_CHANGED", version?}` if it has changed or disappeared; the source is checked again in the same transaction as the public write. Older clients may omit it.
- `items[].sourceIndex?`: the card's zero-based position in that exact source snapshot's `items`. Indices require `sourceVersion` (or the kept private board's origin version). They preserve duplicate identities and row order when a new publication is a Ranking; duplicate, out-of-range or wrong-card mappings are `400 {code: "INVALID", detail: "sourceIndex"}`. Missing indices use deterministic occurrence matching for legacy clients. IDs and these hints do not decide whether the content is identical.
- **`boardUid`**: the device's own uid of the board, 1–100 characters.
- **`baseRevision?`** (since 14.11.2026, `POST /lists/{id}` and `PUT /lists/editorial/{id}`): the list's `revision` the client's copy was read at (**List revision** below). When the list now has another one, the answer is `409 {code: "LIST_CHANGED", revision}` with the revision it has, and nothing is written; checked again in the write transaction. Not a whole number from 0: `400 {code: "INVALID", detail: "baseRevision"}`. Absent or `null`: not checked, as before. Ignored on a new publication.

Answers:
- `200 {id, ranking: true}`: explicit publication of an unchanged foreign list became a Ranking; no new list, topic or pictures are created and no list quota is consumed. Private board progress/choice is untouched.
- `201 {id, topicId, underReview, revision, droppedPictures?}`: a new list (`revision` 1).
- `200 {id, topicId, underReview, revision, droppedPictures?}`: `POST /lists/{id}` replaced it; `revision` is the one it now has, the client's next `baseRevision`.
- **`droppedPictures`**: how many distinct pictures from other sites were left out (could not be fetched, were not a still JPEG, PNG, GIF or WebP, Vision answered nothing, or the 12 s ran out); absent when none were. Worth telling the author: publishing the same board again tries those ones again and fetches nothing it already has. A ranking (`{id, ranking: true}`) copies no pictures and never has it.
- `underReview: true` means the list was kept but starts out of the feed (held, or replacing a hidden list): its link answers 404 to others until staff look. Tell the author it waits for moderation.
- **`200 {id, topicId, existing: true, revision}`**: this author already published this `boardUid` (on `POST /lists` only). Nothing is written and the existing list is named, even for an author at either publication limit. This is what makes a retried publish idempotent. Once that list is unpublished the same `boardUid` publishes anew.

Refusals: `403 NOT_SIGNED_IN`, `403 BANNED`, `409 TOO_MANY_LISTS` (also when parallel publishes would pass the limit together: all but those that fit are refused), **`400 TOO_MANY_TIERS`** (`error` names the limit), `413 TOO_LARGE` (`error` names which limit), `400 INVALID` (`error` says what), `400 TOPIC_UNAVAILABLE` (someone else's waiting topic, or a rejected or merged one), `409 TOO_MANY_PENDING_TOPICS`, `422 {code: "PICTURE_REFUSED", because: "adult" | "racy" | "violence", imageUrl?}` (`imageUrl`, the address as sent, when the refused picture came from another site; nothing is published and nothing is kept), `422 {code: "PICTURE_LINK_NEEDED", itemIndex}` (a house publication only: the card at `itemIndex` of `items` has a picture from another site, new to this list, without the page it was found on in `attribution.link`), `400 {code: "BAD_ATTRIBUTION", reason, itemIndex | cover: true}` (a house publication only: the editor's credit on the card at `itemIndex`, or on the cover, cannot be kept; `reason` is `NO_LICENSE`, `UNKNOWN_LICENSE`, `NO_LINK`, `BAD_LINK`, `BAD_LICENSE_URL` or `TOO_LONG`; nothing is published), **`429 WEB_PICTURES_DAILY_LIMIT`** (the pictures from other sites this publication would fetch are more than the account has left today; nothing is fetched), and for `POST /lists/{id}` `404 NOT_FOUND` and `403 NOT_YOURS`. A photograph that is missing from Storage is not a refusal: its card publishes without art.

**The author's face** (`authorPhotoUrl`, on lists and rankings) comes from the ID token's `picture`. The author's own copy in `avatars/{uid}/` (what `POST /lists/face` gives) is kept as it is. Any other picture, a Google account photo included, is copied to `avatars/{uid}/w-{32 hex}` after SafeSearch, by the rules above, and that copy is the face; a new photo is a new copy. Since 14.11.2026 the faces already published from Google were copied the same way (`npm run copy-account-faces`). A Google account photo (`lh3.googleusercontent.com`, under `/a/` or `/a-/` only; its other paths are Drive, Photos and Blogger, anybody's pictures) that cannot be copied right now (not fetched, or past the day's fetches) stays Google's address; one refused, and any other picture not copied, is no face (`null`). A face never refuses the publication. Erasing the account deletes `avatars/{uid}/`. This holds for `POST /lists`, `PATCH /lists`, and `PUT /lists/{id}/rankings/mine`.

Words of 20 characters or more go to the Natural Language classifier. It never refuses: a doubtful board is put in the reports queue, and a very doubtful one is also taken out of the feed until someone looks.

**`DELETE /lists/{id}`**: unpublish. `204`, also when there is no such list. `403 NOT_YOURS`. Its pictures, share cards and app rankings go with it. Withdrawing a list that is `underReview` also writes, in the same batch, the `auditLog` row `{who: <author uid>, role: "author", what: "list.withdrawn_hidden", target: "publishedLists/{id}", before: {underReview: true}, after: null, at}`.

**`PATCH /lists`**: account. Copies the caller's current name and face (checked as above) onto every list they published: `200 {updated: n}`.

**`POST /lists/face/{pictureId}`**: account. Copies one of the caller's photographs to `avatars/` after SafeSearch: `200 {url}`. `400 INVALID`, `422 PICTURE_REFUSED`.

### Follows and takes

**`GET /lists/follow`**: up to 12 suggested authors from the most taken lists, without the caller and whoever they follow: `200 {authors: {uid, name, photoUrl, takeCount}[]}`.

**`GET /lists/follow/{uid}`**: `200 {following: boolean, followers: n}`. `400 INVALID`.

**`POST /lists/follow/{uid}`**: account. Idempotent: `200 {following: true}`. `403 NOT_SIGNED_IN`, `409 YOURSELF`, `409 TOO_MANY_FOLLOWING` (200), `400 INVALID`.

**`DELETE /lists/follow/{uid}`**: idempotent, `200 {following: false}`.

**`POST /lists/{id}/taken`**: somebody put this list on their phone. Adds one to `takeCount` once per account, in one transaction with the record of the take. Never for the author, and not for anybody whose report would not weigh: guests, banned accounts and accounts younger than 7 days get `counted: false` and nothing is recorded, so the same account counts once it is a week old. `200 {counted: boolean}`. `404 NOT_FOUND`.

### Reports and moderation

**`POST /lists/{id}/report`**: body `{reason, note?}`, `reason` one of `sexual`, `violence`, `hate`, `spam`, `other`, `wrong_category`. One report per person per list (a second replaces the first). `204`, also for a list already gone. `400 INVALID` for another reason. The list leaves the feed (`underReview`) on the first `sexual` report or the third report of any reason but `wrong_category`, unless staff already kept this snapshot. Reports from guests, banned accounts and accounts younger than 7 days are filed and shown to staff but do not count towards that, and never take a list out themselves. A moderator reporting a list by staff gets `403 TARGET_IS_MODERATOR` (see below).

**Staff do not judge staff.** A list whose author is the owner or a moderator, the caller's own included, is the owner's alone to report, take down (with or without a ban), dismiss or move. A moderator gets `403 {code: "TARGET_IS_MODERATOR"}` and nothing changes. This holds for an anonymous list too, so the refusal tells a moderator that its author is staff. A takedown of a list already gone judges the author its reports name. House lists (`tyl-editorial`) are nobody's, and any staff may act on them.

**`GET /lists/reports`**: staff. `200 {reports: QueuedList[]}` from the 50 newest reports, one row per list, hidden lists first: `{listId, listTitle, authorName, authorUid, authorPhotoUrl, anonymous, coverImageUrl, reasons, notes, reportCount, newestAtMs, hidden, reviewed}`. On an anonymous list (`anonymous: true`), and on a list already removed whose reports do not say it was named, only the owner is told the author; a moderator gets `authorName: ""`, `authorUid: null`, `authorPhotoUrl: null`.

**`POST /lists/{id}/takedown`**: staff. Body `{ban?}`, `ban` one of `week`, `month`, `three_months`, `six_months`, `forever` (a month is 30 days). Deletes the list and its reports, and bans the author when asked: `204`. `403 TARGET_IS_MODERATOR` for a moderator on a staff member's list.

**`POST /lists/{id}/dismiss`**: staff. Puts the list back and marks this snapshot kept, so complaints no longer hide it: `204`. A list already removed stays removed; only its reports go. `403 TARGET_IS_MODERATOR` as for takedown.

**`POST /lists/{id}/move`**: staff. Body `{topicId}` (an approved topic; the list takes its section) or `{category, topicId?: null}` (an approved section; the list keeps its topic only if that topic is in the section, and loses it when `topicId: null` is sent). `204`. `400 INVALID`, `404 NOT_FOUND`, `403 TARGET_IS_MODERATOR` for a moderator on a staff member's list. The list remembers the move as **`movedByStaff: {category?: {from, to}, topicId?: {from, to}}`** (`topicId` sides may be `null`), one entry per field that changed; `from` stays the author's value across later moves, and a move back to it drops that entry. The author's replace keeps these unless the body says otherwise (`POST /lists`, "Staff moves hold").

**`GET /lists/anonymous?after=`**: owner. Every anonymous list, newest first, with who published it: `200 {lists: (ListSummary + {publishedBy: {uid, name}})[], nextCursor}`. Cursor is the last id; `409 CURSOR_GONE`.

**`GET /lists/admin/counts`**: staff. `200 {reports: n, proposals: n}`.

**`GET /lists/admin/lists?section=&topic=&sort=&after=`**: staff. One section's lists, under review included. `topic` is a topic id, `none` (lists without a topic) or `other` (lists whose topic is not an approved topic of the section); absent means all. `200 {lists: (ListSummary + {underReview, publishedBy, proposedSection, proposedSectionName})[], nextCursor}`; `publishedBy` is `null` to a moderator on an anonymous list. `400 {code: "INVALID", detail: "section" | "topic" | "after"}`, `409 CURSOR_GONE`.

**`GET /lists/moderators`**: staff. `200 {moderators: {uid, name, photoUrl, email?, appointedAt}[]}`; `email` goes to the owner only.

**`GET /lists/moderators/candidates?q=`**: owner. Up to 10 signed-in accounts whose name, a word of it, or e-mail starts with `q` (2 characters or more): `200 {people: {uid, name, email, photoUrl}[]}`.

**`POST /lists/moderators/{uid}`**: owner. Body `{name?, photoUrl?}`. `200 {uid, moderator: true}`. `409 YOURSELF`, `404 NOT_FOUND`, `400 {code: "INVALID", detail: "uid"}` for a guest account.

**`DELETE /lists/moderators/{uid}`**: owner. `204`.

**`DELETE /lists/bans/{uid}`**: owner. Lifts the ban on that account, whoever set it: `bans/{uid}` and the `bannedIdentities` records it is kept by, through the erased account's `identityKeys` or the keys of the account signed in as that uid now (see `DELETE /boards/account`), so a ban kept past an erasure is lifted by the old uid or the new one. When there was anything to lift it writes `ban.lift` to the audit log, `{before: {until, bannedAt, reason, keptRecords: <records deleted>}, after: null}` (`before` has only `keptRecords` when `bans/{uid}` was not there): `204`, also when there was nothing. `400 INVALID` for something that is not a uid; any other method on `/lists/bans/{uid}` is `405`.

**`POST /lists/search-misses`**: body `{q}`. Notes a search that found nothing anywhere (only the folded words, never who). Always `204`.

**`GET /lists/search-misses`**: staff. The 100 most asked: `200 {misses: {q, count, lastAt}[]}`.

### Rankings

A reader's own placing of somebody's list, kept beside it.

**`GET /lists/{id}/rankings?after=`**: `200 {rankings: Ranking[], nextCursor}`, newest first, 30 a page; on the first page the caller's own comes first with `mine: true`. The website's account-less rankings are not shown. **Cursor:** a ranking id, or `~<seconds>.<nanoseconds>` after a run of rankings that are not shown. `409 CURSOR_GONE`.

**`PUT /lists/{id}/rankings/mine`**: account, not banned. Body `{tierLabels, rows}` or, the old way, `{tierLabels, arrangement}`:

Optional `version` is the source list's `updatedAt`; when supplied, a stale value is `409 LIST_CHANGED`, checked again in the ranking-write transaction. Omission remains accepted for older clients.
- `tierLabels`: 1–20 labels.
- `rows`: one array per label, each the card indexes (into the list's `items`) of that tier, left to right, each card at most once; cards in no row are unranked.
- `arrangement`: one tier index or `null` per card, in the list's order.

`200 Ranking + {created: boolean}`; replacing one's own ranking is idempotent and counts once. `403 NOT_SIGNED_IN`, `403 BANNED`, `404 NOT_FOUND` (also under review), `409 OWN_LIST`, `400 {code: "INVALID", detail: "tierLabels" | "rows" | "arrangement"}`.

**`DELETE /lists/{id}/rankings/mine`**: `204`, also when there was none.

### Topics

**`GET /lists/topics?q=&section=&limit=&cursor=`**: approved topics. With `q`: those whose names in any language hold every word, most followed first, one page, `nextCursor: null`. Without: biggest first (`listCount`), within `section` if given. `limit` 1–50, default 20. **Cursor:** `"<listCount>:<id>"`, passed back as `cursor`. `200 {topics: Topic[], nextCursor}`.

**`GET /lists/topics/mine`**: what the caller proposed, waiting ones first: `200 {topics: Topic[]}`.

**`GET /lists/topics/pending`**: staff. Oldest first: `200 {topics: (Topic + {proposerName, requestedSection, similar: Topic[]})[]}`. A topic first named by an anonymous list gives a moderator `proposerName: ""` and no `createdBy`; the owner is told both, and every entry carries `proposedAnonymously` so the owner can mark the name as hidden from others.

**`GET /lists/topics/{id}`**: `200 Topic`. `400 INVALID`, `404 NOT_FOUND`.

**`POST /lists/topics`**: staff. Body `{name, section, names?, pictureId?, pictureAttribution?}`: an approved topic outright, in an open section. `names` (since 14.11.2026): its translations at once, as `PATCH` takes them, `{<locale>: <name>}` for the locales of **Locales** (`en` is `name`); an empty one is left out; found by search in every language as the name is. `201 Topic`. `400 {code: "INVALID", detail: "name" | "section" | "names"}`, `409 {code: "NAME_TAKEN", id, detail: id}`, `400 BAD_PICTURE`.

**`PATCH /lists/topics/{id}`**: staff. Body `{name?, names?, pictureId?, pictureAttribution?}` (`pictureId: null` removes the picture; an empty translation removes it). `200 Topic`. `400 INVALID`, `400 BAD_PICTURE`, `400 BAD_ATTRIBUTION`, `409 NAME_TAKEN`, `409 SETTLED`.

**A topic picture's credit** (since 14.11.2026): `pictureAttribution` in `POST` and `PATCH /lists/topics`, `{author?, license, licenseUrl?, link}` (`manual: true` may be sent or left out), by the rules of the house editor's credit (**Editor's credit** below: the same licences, `link` required, an author or licence left empty read from a Commons, Flickr or iNaturalist page). `null` takes it away. It is kept while the picture stays: a new picture sent without one, or the picture taken away, takes it away too. `Topic` carries it, as stored (`manual: true`), only while the topic has a picture. Refused: `400 {code: "BAD_ATTRIBUTION", reason, detail: "pictureAttribution"}`, `reason` as for a card.

**`DELETE /lists/topics/{id}`**: owner. Only a topic no list carries: `204`. `409 {code: "NOT_EMPTY", detail: "lists", lists}`.

**`POST /lists/topics/{id}/follow`**: account. Idempotent, approved topics only: `200 {following: true}`. `403 NOT_SIGNED_IN`, `409 TOO_MANY_FOLLOWING`, `404 NOT_FOUND`, `409 NOT_APPROVED`.

**`DELETE /lists/topics/{id}/follow`**: idempotent, `200 {following: false}`.

**`POST /lists/topics/{id}/approve`** `{section}`, **`/reject`**, **`/rename`** `{name}`: staff. **`/merge`** `{into}`: owner. `200 Topic`. `409 SETTLED`, `400 INVALID`, `404 NOT_FOUND`. A merge moves the topic's lists and followers into the target.

### Sections

**`GET /lists/sections`**: `200 {sections: SectionView[], updatedAt, version, role}`. Everybody gets the approved, not hidden sections in drawing order (followed, then pinned by rank, then busiest of 30 days, then oldest; `other` last), then their own waiting proposals and their declined or merged ones not yet dismissed. Staff also get hidden sections and every proposal there has been, and `version` (else `null`), which `PUT order` saves against. `role` is `"owner"`, `"moderator"` or `null`.

**`GET /lists/sections/name-check?name=`**: `200 {free: true}`, `{free: false, id}` (who has it, in any language, ignoring case and accents) or `{free: false, code: "BAD_NAME"}`.

**`GET /lists/sections/{id}`**: `200 SectionView`. `404 NOT_FOUND` for none, or a proposal that is not the caller's. **`410 {code: "MERGED", mergedInto, detail: mergedInto, mergedTopicId?}`** for a merged section.

**`POST /lists/sections/{id}/follow`**: account, approved sections only. `200 {following: true}`. `403 NOT_SIGNED_IN`, `404 NOT_FOUND`, `410 MERGED`, `409 TOO_MANY_FOLLOWING`. **`DELETE /lists/sections/{id}/follow`**: `200 {following: false}`; `410 MERGED` for a merged section, whose followers were moved to `mergedInto`: leave that one.

**`GET /lists/sections/proposals`**: account, not banned. What the caller may still propose: `200 {pending, maxPending, proposalsToday, maxPerDay, refusal: null | "TOO_MANY_PENDING" | "TOO_MANY_PROPOSALS"}`. Asked before uploading a picture for a proposal that would be refused.

**`POST /lists/sections/proposals`**: account, not banned. Body `{name, icon?, fileUnder, pictureId}`: `icon` one of the offered Material Symbols (default `category`), `fileUnder` an open section where the lists wait meanwhile, `pictureId` the caller's own picture (copied into a private folder at once). `201 SectionView`. Refusals, all `{error, code, detail?}`: `400 BAD_NAME`, `400 {code: "NAME_TAKEN", id, detail}`, `400 BAD_ICON`, `400 BAD_FILE_UNDER`, `400 {code: "BAD_PICTURE", why, detail}` (`why`: `missing`, `not_image`, `too_small`, `not_16_10`), `400 TOO_MANY_PENDING`, `429 TOO_MANY_PROPOSALS`.

**`DELETE /lists/sections/proposals/{id}`**: account, not banned; the proposer's own. A waiting proposal is withdrawn; a declined or merged one's notice is put away. Answers:
- `200 {outcome: "withdrawn", status: "declined"}`: a withdrawn proposal is kept as declined; its lists stop waiting and stay where they were filed.
- `200 {outcome: "dismissed", status}`: `status` is what it became, `"declined"` or `"merged"`.
- `409 {code: "SETTLED", status: "approved"}`: it was approved meanwhile.
- `404 NOT_FOUND`: not the caller's, a built-in, or none.

Repeating a dismissal answers the same.

**`GET /lists/sections/queue`**: staff. Waiting proposals oldest first, each with `waitingLists`, `palette` and `nameClash`, then decisions whose lists were not all moved, each with `finish`, the call that completes it: `200 {sections: SectionView[]}`.

**`POST /lists/sections/{id}/approve`**: staff. Body `{name?, names?, icon?, tint?, rank?}`, `rank` the owner's alone. **`/decline`** `{note?}`: staff. **`/merge`** `{into}`: owner. `200 SectionView` (staff view). The same word again on a decision left unfinished finishes moving its lists. `409 SETTLED`, `409 BUILT_IN`, `400 {code: "INVALID", detail: "into"}`, `400 BAD_PICTURE`, `400 NAME_TAKEN`, `404 NOT_FOUND`.

**`POST /lists/sections/{id}/approve-as-topic`**: staff. Body `{section, name?, names?}`: the proposal becomes an approved topic in an existing section. **`POST /lists/sections/{id}/merge-into-topic`**: staff. Body `{topic}`: into an existing approved topic. Both `200 {topic: Topic | null, proposal: SectionView | null}`, and both finish a move cut short when asked again. `409 SETTLED`, `409 NAME_TAKEN {id, section}`, `400 {code: "INVALID", detail: "section" | "name" | "topic"}`, `404 NOT_FOUND`.

**`POST /lists/sections`**: owner. Body `{name, names?, icon?, rank?, pictureId?, tint?}`: an approved section outright. `201 SectionView`.

**`PATCH /lists/sections/{id}`**: owner. An approved section: `{name?, names?, icon?, rank?, hidden?, pictureId?, tint?}` (`pictureId: null` removes the picture; `tint` is `#RRGGBB`). A waiting one: `{name?, names?, icon?, pictureId?, tint?}`; `rank` or `hidden` there is `400 {code: "INVALID", detail: "rank" | "hidden"}`. `200 SectionView`. `409 SETTLED`, `409 BUILT_IN` (detail `pictureId` or `hidden`: `other` is never hidden), `400 NAME_TAKEN`, `400 BAD_NAME`, `400 BAD_ICON`, `400 BAD_PICTURE`, `400 INVALID`.

**`PUT /lists/sections/order`**: owner. Body `{ids, hidden?, version}`: every pinned section in its place, the rest unpinned, exactly `hidden` hidden. Answers like `GET /lists/sections`. `400 {code: "BAD_ORDER", detail?: "version"}`, `409 {code: "CONFLICT", detail: "version", version}`.

**`DELETE /lists/sections/{id}`**: owner. Only a section nothing is filed under, waits for, or has a live topic in: `204`. `409 BUILT_IN`, `409 {code: "NOT_EMPTY", detail: "lists" | "topics", lists, topics}`.

### House lists

Lists the house publishes, stored under author `tyl-editorial`, always anonymous, read like any other list.

**`GET /lists/editorial?after=`**: staff. `200 {lists: ListSummary[], nextCursor}`; cursor is the last id; `409 CURSOR_GONE`.

**`POST /lists/editorial`**: staff. Publish body as `POST /lists`: `201 {id, topicId, revision}`. No count limit; no classifier. **Our copies first** (since 14.11.2026): a house publication (and its edit, `PUT /lists/editorial/{id}`) is written only when every catalogue picture whose licence lets us keep a copy (a Commons file, an open iNaturalist photo, **Picture attribution** below) has become our copy; a direct Wikimedia address is refused by Wikimedia to some apps. Otherwise nothing is written and the answer is `503` with `Retry-After` and `retryAt` (epoch ms): `{code: "SOURCE_BUSY", busy: ["wikimedia"], retryAt}` when Commons could not be asked about the licences, `{code: "PICTURES_NOT_COPIED", imageUrls, retryAt}` when those pictures could not be copied in time. Send the same body again at `retryAt`; a picture that keeps failing is best replaced. A picture of another catalogue switched on for copies (**One switch per catalogue** below) never holds a publication: one not copied keeps its catalogue address and the daily upkeep copies it. Anybody else's publication is as before: a picture not copied keeps its catalogue address. The same 19 ranked tiers, `400 TOO_MANY_TIERS`.

**`PUT /lists/editorial/{id}`**: staff. Replace: `200 {id, topicId, revision}`; `baseRevision` and `409 LIST_CHANGED` as for `POST /lists/{id}`. Its translations stay, pruned to the texts it still shows. Tiers and staff moves as for `POST /lists/{id}`.

**`DELETE /lists/editorial/{id}`**: staff. `204`.

**`PUT /lists/editorial/{id}/translations`**: staff. Body `{translations: {<locale>: {<text as written>: <text in that locale>}}}`: locales as above without `en`; the keys are the list's own title, tier labels and captions and card titles. Replaces the translations whole and keeps only those the list shows: `200 {id, translations, dropped}`. `404 NOT_FOUND` (not a house list), `400 {code: "INVALID", detail}` (`detail` like `locale:xx`, `too_many:xx`, `too_long:xx`, `not_text:xx`), `413 TOO_LARGE`.

**House translations and `names`.** A reader shows `translations[locale]?.[text] ?? text` for every text of a house list (`GET /lists/{id}` carries `translations`). Every list summary carries `names`: its title in each locale it has been translated into (empty for a list that is not the house's), so a feed card needs no second read. A copy of a house list keeps those words. Topics and sections carry `names` of their own.

An accepted translation replacement advances the list's `updatedAt`, so an origin/sourceVersion also binds the official language baseline. Publication compares the matched language version again against fresh source contents in its write transaction.

### Picture search

**Image attribution.** Commons search requests `extmetadata` and carries the supplied author/custom attribution, licence and safe source/licence links as plain text in the existing optional `credit` string. Source links use Commons page ids when available. Missing metadata adds no credit; a known attribution that cannot fit whole in 1000 characters is not offered as a new search result. Search cache shape is 12 (13.11.2026: Wikidata names kept only in `mul`, the same in every language, are read as titles; answers cached before are not served). Existing saved boards are not rewritten. Older clients that truncate this field at 200 cannot be relied on to preserve longer credits.

**Picture attribution.** Every card with a picture is stored and sent with `attribution` (**PictureAttribution**), worked out by the server at publication: its `source` from the picture's address, an iNaturalist photo's author and licence from its `credit`, a Commons file's from Commons, and the page `link` from the address where it says one (Steam, iNaturalist, AniList characters, Open Library editions) or else from the `attribution.link` the client sent back, kept only when it is that catalogue's own page in its one shape (`https://www.themoviedb.org/{movie|tv|person}/{id}`, `https://anilist.co/{anime|manga|character}/{id}`, `https://www.igdb.com/games/{slug}`, `https://store.steampowered.com/app/{id}`, `https://openlibrary.org/{works|books}/{id}`). A card whose picture comes from another site, or is our copy of one, gets `{source: "web", link?}`, and so does a `pictureId` card sent with `attribution.source: "web"` (a picture kept by `POST /lists/pictures/link`); `link` is the `attribution.link` sent, any https page of at most 500 characters without a login or a port, and from a client that sends no `attribution` the one the same picture had before. A person's own photograph has none. A house publication must give `link` for every picture from another site that is new to the list (`PICTURE_LINK_NEEDED`). The old `credit` text stays as it was, for clients that show only that. A list too heavy to store with its attributions is stored without them.

**List revision** (since 14.11.2026). Every published list has `revision`, a whole number that moves on with every write to what it shows, whoever makes it: publishing and replacing it, the house's translations, staff moving it (`POST /lists/{id}/move`, and a section or topic merged or renamed under it), the daily picture refresh moving its pictures, and the maintenance scripts that fix its cards or pictures. `updatedAt` is not it: it orders "recently updated" and stands for the version a ranking was made against, so writes the author did not make leave it alone. A list stored before revisions is at 0 until its next write. A client that edits a list keeps the `revision` it read (`GET /lists/{id}`, or the answer of its last save) with its copy and sends it as `baseRevision`; on `409 LIST_CHANGED` it loads the list again instead of writing its older copy over the newer one. Takes, rankings and moderation (taking it out of the feed, putting it back) do not move it.

**Commons addresses** (since 14.11.2026). Everywhere an address is sent for publication (cards, cover and collage of `POST /lists`, `POST /lists/{id}`, the house's, a board's collage) and in `POST /lists/pictures/link`, a Commons address is kept at a width Wikimedia makes, never as the uploaded original: a file's own page (`https://commons.wikimedia.org/wiki/File:{name}`, as people copy it from the browser), `Special:FilePath/{name}` without a `width` or wider than 1280, the original (`upload.` or `thumb.wikimedia.org/wikipedia/commons/{x}/{xy}/{name}`), and a direct thumbnail (`…/thumb/…/{n}px-{name}`) at a width Wikimedia does not make (any but 20, 40, 60, 120, 250, 330, 500, 960, 1280: it answers 400 to the others) or wider than 1280 all become `https://commons.wikimedia.org/wiki/Special:FilePath/{name}?width=600`, as search hits are (Wikimedia serves its 960 px thumbnail for it). A `Special:FilePath` with a width up to 1280 (Wikimedia rounds it up to one it makes) and a direct thumbnail at a width it makes stay as sent. Copies we keep are made from the 500 px thumbnail.

**Editor's credit** (since 14.11.2026). On a house publication (`POST /lists/editorial`, and its edit `PUT /lists/editorial/{id}`) a card's `attribution` with `manual: true` is the editor's own credit for its picture: `{manual: true, author?, license, licenseUrl?, link}` (other fields as usual, `source: "web"` on an uploaded file). It is stored as given (spaces tidied) and marked `manual: true`, over whatever the server would work out: the card keeps its `source`, `id`, `originalUrl` and `formerUrls`, an uploaded file becomes `source: "web"`, and publishing again, the backfill and `refreshPictures` never work it out again. `link` (the page the picture stands on) is required; `license` is required and must be one of `CC0 1.0`, `CC BY {v}`, `CC BY-SA {v}` (`v` 1.0, 2.0, 2.5, 3.0 or 4.0; a jurisdiction suffix such as `3.0 de` is dropped), `Public domain` or `Used with permission`; spelling is free (`cc-by-sa 4.0`, `CC0`, a Creative Commons deed's address) and it is stored in that one shape, with the deed in `licenseUrl` when none was given (none for `Used with permission`). `author` ≤300, `license` ≤100, `link` and `licenseUrl` https, ≤500. When `link` is a Commons file page (`https://commons.wikimedia.org/wiki/File:{name}`), a Flickr photo (`https://www.flickr.com/photos/{user}/{id}/`) or an iNaturalist observation (`https://www.inaturalist.org/observations/{id}`) and the author or the licence is left empty, they are read from there (an iNaturalist observation's first photo); a licence read there that is not one of those is refused as `UNKNOWN_LICENSE`. A credit sent back as it is stored is kept without being read again. `attribution.manual: false` takes the editor's credit off; a card sent with no `manual` keeps the one the same picture had. The cover's is `coverAttribution` in the body, of the same shape, kept while the cover is the same picture, and returned by `GET /lists/{id}`. Anyone else's `manual`, and `coverAttribution`, are ignored. Refusal: `400 BAD_ATTRIBUTION` above.

**Catalogue pictures we keep.** Danylo's decision of 13.11.2026, after each catalogue's terms: an iNaturalist photo from `inaturalist-open-data.s3.amazonaws.com` whose credit names CC BY, CC BY-SA, CC0 or public domain, and a Commons file whose licence Commons names, are copied at publication from the catalogue's own picture of about 500 px into `published/{listId}/w-{32 hex}` (the name every copy of that address gets), without SafeSearch and outside `WEB_PICTURES_DAILY_LIMIT`. The card's `imageUrl` then points at the copy and `attribution.originalUrl` keeps the catalogue address; the cover and collage follow. **One switch per catalogue** (since 14.11.2026), `config/pictureCopies` `{sources: {wikimedia, inaturalist, tmdb, anilist, igdb, steam, openlibrary: boolean}}`, read at most once a minute: a catalogue switched on is copied the same way at every publication, cover and collage included (a Commons file or an iNaturalist photo still only with its licence, as above, and in the cover or collage when a card shows it), and by the backfill. Switching one off stops new copies; copies made stay. Each copy's file says what it was copied from and when, in its custom metadata `{originalUrl, source, copiedAt}` (epoch ms; `web` for a picture from another site). Once a day `refreshPictures` copies what a list or a ranking still shows from a catalogue switched on (one that did not answer at publication is asked again), and fetches again each copy of a catalogue whose terms limit a cache: TMDB's (six months at most) after 90 days. **A TMDB copy still not fetched again at 150 days is never switched back to TMDB's address blind** (since 14.11.2026, after QA): its address is looked at (HEAD, or one byte). Only when it answers 404 or 410 is TMDB asked for the card's `attribution.id` (e.g. `tmdb:movie:603`); a poster it names now is copied into the same folder, and every card, cover and collage that showed the old copy shows the new one, the card's `attribution.originalUrl` the new address and the old one added to `attribution.formerUrls`; the old copy is then deleted. Otherwise (TMDB busy or refusing, no answer, no id, no picture for the id, the new picture not copied) the copy stays and an ERROR line is logged every day until someone looks: one JSON object `{severity: "ERROR", message: "PICTURE_ALARM", source, path, docs, reason}`, at most 20 a run plus one line counting the rest. A copy past 150 days that nothing shows any more is deleted. A list's `revision` moves with each of these writes; credits (`source`, `id`, `link`, the catalogue's own notice) never change. **Undoing a catalogue in one command**: `npm run remove-picture-copies -- --project tieryourlife --source tmdb` (or `tmdb,igdb`, or `all`; a dry run unless `--apply`) switches it off, shows the catalogue's own address again everywhere a copy of it was shown (from the card's `attribution.originalUrl` or the file's own word), saves the old values first, and deletes those copies once nothing shows them. Without the document, or a source it does not name, only Commons and iNaturalist are on: TMDB (copies for six months at most), AniList (no storage), Steam (no grant), IGDB (until it confirms in writing) and Open Library stay off until the owner switches them on. Deezer and `static.inaturalist.org` (not openly licensed) are never copied and stay where the catalogue keeps them. A picture not copied within 15 seconds keeps its catalogue address; the next publication copies it. A client sending the copy back (republishing, or copying the list) sends `attribution.originalUrl` with it, which is kept only when the copy's name is that address's; without it the previous snapshot of the same list still knows. A catalogue address and every copy of it count as one picture when a ranking or a copy is compared with its source. Lists published before are given attributions, copies and catalogue ids by `npm run catalogue-pictures` (a dry run unless `--apply`; nothing is deleted, `updatedAt` stays, `revision` moves; `--sources a,b` copies only those of the catalogues switched on, `--list a,b` only those lists and their rankings). It copies ranking snapshots' catalogue pictures too, each ranking into a folder of its own, `published/ranking-{rankingId}/w-{32 hex}`, as a website ranking outlives its list. An id comes from the address or page where they say one, or else from the house fill's searches (`houseFillJobs`) when every hit that showed that address had the same id; otherwise none.

**Publication attempts.** Newly copied private, external and adopted pictures use an attempt-specific `_p_UUID` suffix; filenames and URLs are opaque to clients. A refused or failed write removes only that attempt's new files. Replacing a list reuses external copies referenced by the committed snapshot without another fetch, scan or quota charge; pending files of another attempt are never a cache. Successful cleanup considers only files referenced by the previous committed snapshot. Overlapping replacements compare `updatedAt` in the final transaction: the losing request returns `409 PUBLICATION_CHANGED`, keeps the current publication intact and may be retried. A client must retain its local edit and offer to publish again, rather than treating this as the author's list-count limit.

**`GET /lists/pictures?q=&scope=&lang=&page=&web=&part=`**: the catalogues a scope names, asked together.
- `scope`: `all` (default), `film_tv`, `anime`, `games`, `music`, `books`, `people`, `animals`. `music` asks Wikidata (pictures from Wikimedia Commons) only, and only for items that are music (a genre is named, or the item is a band, album, single, song or musical work); its tiles take photos as wide as 3:2, like `all` and `animals`, where the other scopes take only covers and posters, no wider than tall.
- `lang`: a BCP-47 tag like `en` or `pt-BR`; default `en`.
- `page`: 1–20.
- `web=1` (or `web=true`): ask the paid web search even outside `all`.
- `part=quick`: only the fast catalogues; the answer's `rest` says whether the whole search could add more.

`200 {items: PictureHit[], hasMore, notices, rest?, busy?, retryAt?}`, `notices` holding `"webOff"` or `"webDailyLimit"`; `busy` (since 14.11.2026) names the catalogues of this search that are busy (they answered `429` or `5xx`, now or before and still resting; see below), so what they would have found is missing, and `retryAt` (epoch ms) is when all of them may be asked again. `503 {code: "SOURCE_BUSY", retryAt, busy}` with `Retry-After` (seconds): nothing was found while a catalogue the search needs is busy, so "nothing by that name" is not known; ask again at `retryAt` (a quick answer with `rest: true` is a `200`, the whole search to come). `400 QUERY_TOO_SHORT`, `502 SOURCES_DOWN` (every catalogue failed and none of them is busy). Answers are cached three days; one with a busy catalogue's gap is never kept.

**The whole search builds on the quick one.** Each catalogue's answer to a `part=quick` search is kept three days on its own; the whole search with the same `q`, `scope`, `lang` and `page` takes those answers as they are and asks only the catalogues they lack (the slow ones, and any that failed). The merged hits are the same as if every catalogue had been asked at once.

**A catalogue that refuses rests.** A catalogue that answers `429` or `5xx` (to its main request or a side one, such as iNaturalist's observations) is not asked by any instance until its `Retry-After` passes (seconds or an HTTP date, at most one hour), or for 5 minutes when it names none. Meanwhile it leaves a gap: the others answer as usual, the answer names it in `busy` with `retryAt`, and an answer with a gap is not kept. When nothing was found and one of them is busy, the answer is `503 SOURCE_BUSY` (above); `502 SOURCES_DOWN` only when every catalogue failed otherwise. A `4xx` about the request itself (Open Library's `422` for a short query) is no rest.

**`429 SEARCH_LIMIT`**: the account (guests too, by uid) has used its searches: 1000 in this UTC hour or 3000 this UTC day. Body `{error: "Too many picture searches", code: "SEARCH_LIMIT", retryAt}`, `retryAt` the epoch milliseconds when the full window opens again (the next UTC hour, or UTC midnight), and header `Retry-After` in whole seconds to that moment. What counts: a request that has to ask at least one catalogue and builds on no quick answer already kept, so a quick search and the whole one after it count once, a next page counts, and an answer already kept (served from the cache) counts nothing and is served even past the limit. The refusal itself is not counted, so asking again while refused does not move `retryAt`. A client should not ask again before `retryAt` (a pasted list stops looking up the titles left). A client from before this limit treats it as any refused search: the app falls back to asking TMDB and Wikidata from the phone, the website says the catalogues are down.

Outgoing requests (searches, picture downloads, `refreshPictures`) carry `User-Agent: TierYourLife/1.0 (https://tieryourlife.web.app/privacy)`: Wikimedia and Open Library allow more to a client that says how to reach it, and the privacy page gives the contact address. A picture download that a source answers with 429 or 5xx is tried once more after its `Retry-After` when that is at most 3 seconds (1 second when it gives none); otherwise it is `SOURCE_BUSY`, and a host that answered 429 or 503 is left alone by that instance until its `Retry-After` (5 minutes when it gives none, at most an hour). iNaturalist's observations are asked only for taxa still without an open photo after their own photos (at most 6).

**Deezer is not a picture source** (not in the first release: the right to show its covers publicly is unclear). No answer holds `source: "deezer"` or a `*.dzcdn.net` address, and answers cached before it was turned off are not served. A client must not expect `deezer` among the sources, but must still draw a card whose `imageUrl` is on `cdn-images.dzcdn.net` or `e-cdns-images.dzcdn.net`: boards kept in the account (`PUT /boards`) keep those covers as sent, and a published list may hold them until `scripts/remove-deezer-covers.ts` is run.

**Publishing and ranking drop Deezer's covers.** In `POST /lists` and `POST /lists/{id}` (and a ranking sent through them), an `imageUrl`, `coverImageUrl` or `coverImageUrls` entry on `dzcdn.net` or any of its subdomains is treated as if it had not been sent: the card is stored by its title with `imageUrl: null`, the cover and collage go without it, and when no chosen collage picture is left `previewImages` is the first cards' art, as usual. Such a card is never refused for having no picture, nothing is fetched or copied, and it is not counted in `droppedPictures`. For telling whether a board is a ranking of a list, a Deezer cover counts as no picture, so the card is matched by its title.

**`POST /lists/pictures/link`**: account (a guest gets `403 NOT_SIGNED_IN`). Body `{url, link?, credit?}`: a card's picture by its address, with the page it was found on (`link`, https, at most 500 characters) and whom to credit (`credit`, cleaned like a card's). A catalogue's own address (see `CATALOGUE_HOSTS` above) is not fetched or counted: `200 {imageUrl, attribution, credit?}`, `imageUrl` the address as it is (a Commons address as a card keeps it, **Commons addresses** below) and `attribution` the catalogue's, with its page where the address says one or the `link` sent is that catalogue's own page (a Commons file also gets its author and licence). Any other picture is fetched (as `/keep`: https, no private address, at most three redirects, 4 MiB, JPEG, PNG, WebP or GIF), looked at by Vision SafeSearch and kept in the caller's own folder: `200 {pictureId, attribution: {source: "web", link?}, credit?}`. Publishing looks at it again. Vision out of reach keeps the picture, and publication decides. Refusals: `400 NO_URL`; `422 {code}` with `BAD_URL`, `NOT_ALLOWED` (not https, a login or port, or a private address), `UNREACHABLE`, `NOT_A_PICTURE`, `TOO_BIG`, `BAD_LINK` (a `link` that is not such a page); `422 {code: "PICTURE_REFUSED", because}`; **`503 {code: "SOURCE_BUSY", retryAt}`** with `Retry-After` (the picture's own site answered 429 or 5xx, or asked us to slow down: worth sending again after `retryAt`; not counted, and not remembered); `429 {code: "LINK_LIMIT", retryAt}` with `Retry-After`, after 400 fetches in a UTC day or 200 in an hour (`pictureWeb/{day}/links/{uid}`). Every fetch counts, refused or not, except `SOURCE_BUSY`. The same address again on the same day answers as before without fetching or counting, while the kept picture is still there. Every answer after the request is read (`200`, the `422`s of a fetch, `PICTURE_REFUSED`, `SOURCE_BUSY`, `429`) also carries `quota: {left, limit, resetsAt}`: the fetches left today out of `limit` (400), and when the UTC day starts again, in milliseconds since the epoch. A catalogue address leaves `left` as it was. The hour's limit shows only as a `429` whose `retryAt` is before `resetsAt`.

**`GET /lists/pictures/link`**: account (a guest gets `403 NOT_SIGNED_IN`). `200 {quota: {left, limit, resetsAt}}`, the same as above, before anything is sent.

**`POST /lists/pictures/keep`**: body `{url}`: copies a web picture into the caller's own folder, for a browser that cannot read another site's bytes. `200 {pictureId}`. `400 NO_URL`, `422 {code}` with `BAD_URL`, `KEEP_LIMIT`, `NOT_ALLOWED` (not https, or a private address), `UNREACHABLE` (a busy source included), `NOT_A_PICTURE` (only JPEG, PNG, WebP, GIF), `TOO_BIG`.

## `boards`

The copy of a person's boards their account keeps. Not the published list: the board itself, pool and trash included. All routes: App Check and user.

**`GET /boards?after=`**: `200 {boards: BoardIndexEntry[], next: string | null}`, ordered by uid, 100 a page; **cursor** `next` is the last uid, passed back as `after`. A guest gets `{boards: [], next: null}`, not a refusal.

**`GET /boards/{uid}`**: `200 Board`. `404 NOT_FOUND`.

**`PUT /boards/{uid}`**: account. Body: the board (below) plus `basedOn` (the revision the device worked from; the key is left out on a first write) and `deviceName?`. Answers:
- `200 {uid, revision, copies?}`: stored, `revision` one higher. `copies` (absent when none): `{[catalogueAddress]: ourAddress}`, the catalogue pictures this board now shows from our shared copies (below).
- `200 {uid, revision}` with the stored revision unchanged: the same board again (its `fingerprint` equals the stored one). This makes a retried PUT idempotent.
- `409 {code: "CONFLICT", board: Board}`: the account moved on since `basedOn` and the content differs. Nothing is merged: the device keeps both.

Refusals: `403 NOT_SIGNED_IN`, `409 TOO_MANY_BOARDS`, `413 TOO_LARGE`, `400 INVALID` (`error` says what).

Board body: `{title, displayMode?, category?, coverImageUrl?, coverPictureId?, coverImageUrls?, authorName?, publishedId?, deletedAt?, fingerprint?, anonymous?, tiers, items, play?, takenFrom?, origin?, rankingChoice?}`:
- `origin`: `{listId, version}`, where version is the original public list's `updatedAt` when copied. `takenFrom` is the legacy list-id alias; writing an origin also writes its matching alias. Supplied aliases must agree. Once either field names an original, its list id is immutable: rebinding to another list is `400 INVALID`, including rebinding a legacy alias to a new origin. A newer version of the same original is allowed. Metadata is private backup, including when the public source is later gone; a public write validates the actual source separately.
- `rankingChoice`: `"offered" | "private" | "ranking"`. Clients write `offered` when they first show the question after **strictly more than 30% of their own progress**, then `private` or `ranking` after the explicit decision. Any stored state suppresses another offer on reopen or after withdrawal; `offered` cannot downgrade a completed decision. This is memory of an offer/decision, **not proof of a currently public Ranking**: the actual Rankings API determines public state after withdrawal or a failed save. This field never publishes anything. Omission or explicit `null` for these three metadata fields preserves their stored values, so a legacy client or withdrawal cannot erase the choice or lineage. Guests keep the same metadata locally and transfer it on sign-in; cloud board storage remains account-only.
- `items[].sourceIndex`: optional zero-based source position bound to `origin.version`; it distinguishes duplicate cards. Omission preserves the stored index for the same item uid only while the origin id/version is unchanged; changing the origin unbinds omitted indices. Explicit `null` clears a replaced card's binding. Invalid types/ranges are `400 INVALID`. It is a mapping hint, never the public content identity.
- `tiers`: 1–20 of `{uid, position, label, caption?, colorLight, colorDark, isPool?}`, uids distinct. The 20 includes the pool: 19 ranked tiers and the pool.
- `items`: up to 2000 live cards (no `deletedAt`) plus up to 2000 in the trash, so at most 4000, of `{uid, tierUid, position, title, imageUrl?, pictureId?, source?, deletedAt?, credit?, attribution?}`; `attribution` (**PictureAttribution**, kept on a card with a picture, cleaned to its fields and limits; an `originalUrl` not on a catalogue is dropped) is there so a card picked on one device publishes with its page link from another. A card needs a title or a picture that is kept (a `pictureId`, or an `imageUrl` another device can fetch); a card with only a picture is stored with `title: ""`. `tierUid` must name a tier of the board; `source` is `MANUAL` (default), `TMDB` or `GENERATED`; `pictureId` is `[A-Za-z0-9_-]{1,100}`; `deletedAt` set means in the trash.
- `coverPictureId`: the owner's own photograph as the whole cover, a file in their `users/{uid}/pictures/`, by the same rule as an item's `pictureId` (`[A-Za-z0-9_-]{1,100}`; one that is not is dropped, as an item's is). `null` clears it. Absent keeps the one stored, so a writer that does not know the field cannot wipe it, unless the body has a non-null `coverImageUrl` another device can fetch, or a `coverImageUrls` collage of 2 or more: another cover was chosen, and it is cleared. In the board's fingerprint the cover term is `coverPictureId ?? coverImageUrl`, as `pictureOf` is for a card.
- `play`: a game under way, `{kind: "swiss" | "hill" | "bracket", count, seed, refine, ids, history, round, startedAt, scope?, keepTier?}`. The wire still uses outcome triples and distinct ordered participant IDs, with strict bounds on counts, indices, winners, scopes and timestamps. Malformed supplied games are refused with `400 INVALID`, not silently discarded. Updated clients explicitly send `play: null` to finish/clear a game. For compatibility, omitting the field preserves an existing game that an old client cannot read (more than 64 participants or 2000 outcomes); omission still clears a small legacy game as before. Explicit clear is respected even if the board fingerprint is unchanged.

The board's 2000-live-card / 700000-byte content limits stay unchanged. Long histories may be stored internally as bounded `u16le-v1` bytes encoded in base64; old flat numeric histories remain readable. If board plus game will not fit, the game is stored privately at `accounts/{uid}/plays/{boardUid}`, with the board revision, in the same transaction. Reads and conflicts reassemble the original wire game from one consistent snapshot. Missing/corrupt auxiliary data fails visibly instead of dropping the game. Clear, board deletion and account erasure remove the auxiliary copy; board writes/deletes also read the erased-account marker inside the transaction, so a retry cannot recreate private state after erasure. A board without a game retains its previous response shape; this is no new public endpoint or client Firestore permission.

When a legacy omission preserves a large game, `fingerprint` is `game-v1:<SHA-256>` of the normalized combined board and game, excluding the opaque fingerprint itself. Upgraded clients track the remote fingerprint they actually downloaded separately from their local fingerprint. An unseen `game-v1:` fingerprint requires a full restore/conflict recovery even at an already-known revision; acknowledging only the legacy writer's incomplete local contents is not enough. Once learned, the same remote fingerprint must not cause repeated downloads. Explicit completion still clears the game and uses the client's normal full-content fingerprint.
- **`displayMode`**: `WRAP` (default, also for anything unknown), `HORIZONTAL_SCROLL`, `FLAT_RANKED`. The first builds' `RANKED` is read as `FLAT_RANKED`.

When a legacy writer omits retained origin/choice/source-index metadata, the combined fingerprint uses `state-v1:<SHA-256>` of normalized content and game. A retained large game keeps the existing `game-v1:` prefix and includes that metadata in its hash. Changes to metadata cannot hide behind an unchanged opaque client hash. Clients track the downloaded remote fingerprint separately; an unseen `state-v1:` (like `game-v1:`) requires restoration even at an acknowledged revision, while an already-learned marker must not cause a download loop. Sending the complete current metadata uses the client's ordinary full-content fingerprint.

**Catalogue pictures on a board.** A card picture (and the cover and collage) from a catalogue switched on for copies (**One switch per catalogue**) is shown from one copy shared by every board, `published/catalogue/w-{32 hex}`, named by the catalogue address, so the same poster on many boards is one file. The stored board names our address, and the card's `attribution` keeps its credit with the catalogue address in `originalUrl`; up to 40 new pictures are copied per write within 6 s, the others by the daily upkeep, and a catalogue that does not answer leaves its address. A board whose pictures would not fit 50 KB under its limit keeps the catalogue's addresses. **The board's `revision` and `fingerprint` stay the device's**: the move is not an edit, so the PUT answers `{uid, revision}` as before plus `copies`, and the upkeep and `remove-picture-copies` change a stored board's pictures in place without moving either. Example: `PUT` with `items[0].imageUrl: "https://image.tmdb.org/t/p/w500/x.jpg"` answers `{uid, revision: 4, copies: {"https://image.tmdb.org/t/p/w500/x.jpg": "https://firebasestorage.googleapis.com/v0/b/tieryourlife.firebasestorage.app/o/published%2Fcatalogue%2Fw-…?alt=media"}}`, and `GET` gives that card the second address with `attribution.originalUrl` the first. A client may put each `copies` address in place of its catalogue one (and set `originalUrl`) and send the board again as an ordinary edit; a client that ignores `copies` keeps working with the catalogue's address, which the server swaps on every write. Such a picture is published like any picture of another list's folder (its list takes a copy of its own). A shared copy no board shows for seven days is removed.

**`DELETE /boards/{uid}`**: account. Leaves a marker `{deleted: true}` with a new revision so other phones drop it too: `204`, also for none.

**`DELETE /boards/account`**: account. Erases the account and everything the service holds about it: `204`. A guest gets `403 NOT_SIGNED_IN`. Safe to repeat: a call after an erasure that failed halfway, or after one that finished while the token is still good, is let through and answers `204` too. The first thing it writes is **`erasedAccounts/{uid}`** `{erasedAt}`, which stays: from then on every write with that account's token is `401 ACCOUNT_ERASED` (Conventions), and `checkUpload` deletes what it uploads to Storage. Among what goes:
- its moderator role (`roles/{uid}`), so it leaves `GET /lists/moderators`;
- the sections and topics it proposed or made: one still waiting, declined or rejected is deleted with its pictures; an approved or merged one stays without its proposer (a section's `proposerUid` and `proposerName` become `null`, a topic's `createdBy` and `proposerName` become `""`).

What stays: a ban in force when the account is erased. It is kept as **`bannedIdentities/{key}`** `{until, bannedAt}`, one document per key of the person, and nothing else about them. A key is the lower-case hex SHA-256 of the UTF-8 text `email:<address>` for the account's verified e-mail (trimmed, lower-cased), and `<provider>:<id>` for each federated sign-in (`google.com:<Google's sub>`; `firebase.identities` in an ID token, `providerData` in Auth). `password`, `email`, `anonymous` and `custom` give no key. A new account whose token gives one of these keys counts as banned until that ban's `until`. Two bans on one key keep the one that lifts last.
- The erased account's own `bans/{uid}` stays, and gains `identityKeys: string[]`, the keys it left. The `auditLog` row `{who: <uid>, role: "account", what: "ban.kept_past_erasure", target: "bans/{uid}", before: null, after: {until, keys: <how many>}, at}` records it, with no name.
- A ban staff set later on the new account (`POST /lists/{id}/takedown`) replaces the `until` of every kept record of that person, shorter or longer: the newest decision is the one in force.
- Lifting a ban (`liftBan` in `functions/src/banIdentities.ts`, for the owner's route) deletes `bans/{uid}`, every record its `identityKeys` name, and the records of the account signed in as that uid now, so the erased account's uid and the new one both lift it.
- A record whose ban ran out is deleted when it is next read, and by `sweepGuests` every day.

## `adoptGuestCredits`

**`POST /adoptGuestCredits`**: App Check, account. Body `{guestToken}`: a fresh ID token of the guest the person was before signing into an existing account. Carries the guest's credits over (bought credits add; the free grant counts once). `200 {credits, moved}`; `{credits: null, moved: false}` when the two are one uid. Idempotent: a second call moves nothing. `403 NOT_SIGNED_IN`, `400 INVALID`, `401 UNAUTHENTICATED` (bad guest token), `503 LEDGER_UNAVAILABLE`.

## `credits`

**`GET /credits`**: App Check, user. `200 {credits}`. Creates nothing. `503 LEDGER_UNAVAILABLE`.

## `generate`

**`POST /generate`**: off unless `OFFER_GENERATION=yes`: `503 GENERATION_OFF`, checked before App Check. Then App Check, user. Body `{prompt}`, 1–1000 characters. `200 image/jpeg` with `X-Credits-Remaining`. `402 NO_CREDITS`, `429 BUSY` with `Retry-After`, `503 DAILY_CEILING` with `Retry-After: 3600`, `502 GENERATION_FAILED` (the credit goes back), `503 LEDGER_UNAVAILABLE`. Not idempotent: each success spends a credit.

## `tmdb`

**`GET /tmdb/3/search/multi?query=&language=…`** and **`GET /tmdb/3/search/movie`** (kept for old builds): App Check only, no ID token. TMDB's JSON unchanged; TMDB's own status on its refusal; `502` when TMDB cannot be reached; `404` for any other path.

## Background functions

Not callable:
- `sweepGuests`: daily, deletes guest identities unused for 30 days, and `bannedIdentities` records whose `until` has passed.
- `sweepPictures`: daily, deletes own pictures no board names, after their first day.
- `sweepSearch`: every 15 minutes, adds every language to the search keys of new lists and topics.
- `refreshPictures`: daily, keeps the catalogue pictures of published lists and ranking snapshots alive and within the catalogues' terms. IGDB covers with an `id` are asked again every day (Twitch's 24-hour rule), TMDB pictures with an `id` every 90 days (TMDB's six months), at most 150 a run; every other catalogue address is fetched once a week (HEAD, or one byte), at most 300 a run. An address that answers 404 or 410 is looked up by its card's `id` (AniList, Steam, Open Library, TMDB), and where the catalogue shows something else now, every list and ranking snapshot that shows it is moved to the new address, cover and collage too, with the old one kept in `attribution.formerUrls`; `updatedAt` stays. A catalogue that answers 429 or 5xx is left for the run and rests as for searches. **A catalogue that answers 401 or 403** from its API (our key switched off, access closed), to a search, a refresh by id, Twitch's IGDB token, Commons' file details or the `tmdb` proxy, is counted per catalogue on each instance, and the instance logs at most one ERROR line a minute per catalogue with the running count: `{severity: "ERROR", message: "PICTURE_SOURCE_DENIED", source, status, count}` (`source` one of `tmdb`, `igdb` (Twitch too), `anilist`, `steam`, `openlibrary`, `wikimedia`, `inaturalist`, `wikidata`; the hosts that serve their pictures are not counted, as a 403 there is usually one gone picture's). Cloud Logging files both lines as errors with the fields under `jsonPayload`; this repository defines no alert policy on them, which is the owner's to create. Nothing is deleted: an address with no id, or whose catalogue no longer has the picture, stays and is noted in `pictureChecks/{key}` (`{url, checkedAt, refreshedAt?, status: ok|moved|dead|gone, movedTo?}`). A ranking or a republication that sends a card's former address is matched as that card at its address now. Private boards are not moved yet.
- `houseFill`: answers picture-search jobs that `scripts/house-fill.ts` writes to `houseFillJobs`.
- `checkUpload` (us-east1, beside the bucket): on every file landing in `users/{uid}/pictures/`, removes it if the account was erased (`erasedAccounts/{uid}`), if its first bytes are not JPEG, PNG, GIF or WebP, or if it is the account's 2001st upload that UTC day. The client is not told; its download URL then answers 404, and `keep` or publishing treat the picture as missing.

## Shapes

**ListSummary**: `{id, title, names, authorUid, authorName, authorPhotoUrl, anonymous, mine?, viewerFollowsAuthor?, tierCounts, category, itemCount, coverImageUrl, previewImages, tierColors, topicId, topicName, updatedAt, takeCount, rankingCount, basedOn}`.
- An anonymous list goes out with `authorUid: ""`, `authorName: ""`, `authorPhotoUrl: null`, `anonymous: true`, to everybody but its author on `GET /lists/mine`.
- `mine: true` only on the reader's own list.
- `viewerFollowsAuthor` only for a signed-in reader and a named list.
- `tierCounts`: cards per tier in tier order, then the unranked.
- `basedOn`: `{id, title, authorUid, authorName}` (empty strings when anonymous) or `null`.

**PublishedTier** `{label, caption, colorLight, colorDark}`. **PublishedItem** `{title, imageUrl, tierIndex, credit?, attribution?}`.

**PictureAttribution** `{source, author?, license?, licenseUrl?, link?, originalUrl?, id?, formerUrls?, manual?}`, every field plain text or an https address. `manual: true`: `author`, `license`, `licenseUrl` and `link` are the house editor's (**Editor's credit** above); a client shows them as it shows any other. `source`: `tmdb`, `anilist`, `igdb`, `steam`, `deezer`, `openlibrary`, `inaturalist`, `wikimedia`, `web`; a client treats any other as unknown. `author` (≤300): the person the licence asks to be named. `license` (≤100): `CC BY 4.0`, `CC BY-SA 4.0`, `CC0 1.0`, `Public domain`, or Commons' own short name. `licenseUrl`, `link` (≤500): the licence, and the page about the picture or its title at the source. `originalUrl`: only while `imageUrl` is our copy, the catalogue address it was copied from. `id`: the catalogue's own id for what the picture shows, as its search hit names it, in one shape per catalogue: `tmdb:{movie|tv|person}:{n}`, `anilist:{n}` (anime or manga), `anilist:c{n}` (character), `igdb:{n}`, `steam:{n}`, `openlibrary:OL{n}W` or `OL{n}M`; none for the others. Clients copy it from `PictureHit.attribution` and send it back with the card; the server keeps a sent id only when it fits the card's catalogue and the address or page says none of its own (Steam and AniList character addresses, and the TMDB, AniList, Steam and Open Library pages, do; then theirs is kept). `formerUrls` (at most 5, oldest first): catalogue addresses the card showed before `refreshPictures` moved it to the catalogue's new one; written only by the server, from the previous snapshot. What each catalogue gives:

| source | author | license | link | copied |
|---|---|---|---|---|
| `tmdb` | — | — | title or person page, `id` | no |
| `anilist` | — | — | anime, manga or character page, `id` | no |
| `igdb` | — | — | game page, `id` | no |
| `steam` | — | — | store page, `id` | no |
| `openlibrary` | — | — | work or edition page, `id` | no |
| `inaturalist` | observer | CC BY / CC BY-SA 4.0, CC0 1.0, Public domain | photo page | yes, when the licence is known and the photo is open-data |
| `wikimedia` | author | Commons' licence name | file page | yes, when Commons names the licence |
| `web` | — | — | — | (copied as any outside picture) |

A client shows TMDB's own notice and logo wherever any card's `source` is `tmdb`, rather than reading the host off `imageUrl`.

**Ranking** `{uid, authorName, authorPhotoUrl, arrangement, rows, tierLabels, updatedAtMs, mine?}`.

**Topic** `{id, name, names, section, status: "pending" | "approved" | "rejected" | "merged", listCount, followerCount, following, createdBy?, mergedInto, pictureUrl, pictureAttribution?}`. `pictureAttribution`: the staff's credit for the picture (**A topic picture's credit** above), only while there is a picture. `createdBy` goes only to its proposer and staff, and for a topic first named by an anonymous list only to its proposer and the owner.

**SectionView** `{id, name, names, icon, pictureUrl, tint, topicBg, topicIcon, status: "approved" | "pending" | "declined" | "merged", builtIn, hidden, rank, approvedAt, listCount, lists30d, newThisWeek, followerCount, following, collage}`. Each colour is `{light, dark}`; `collage` is four picture addresses or none.
- Its proposer, while it is not approved, also gets `fileUnder`, `proposerUid`, `declineNote`, `mergedInto`, `mergedTopicId` and `waitingLists`.
- Staff get those and `proposerName`, `palette`, `unfinished`, `finish?`, `withdrawn`, `createdAt`, `decidedAt`, `decidedBy`, and on the queue `nameClash`: `null`, `{kind: "topic", id, name, section, sectionName}` or `{kind: "section", id, name}`.

**PictureHit** `{id: "<source>:<id>", title, subtitle, imageUrl, thumbUrl, source, kind, credit?, attribution?}`. A client keeps `attribution` on the card and sends it back when it publishes. **Only pictures we may copy** (since 14.11.2026): an `inaturalist` hit is a photo in `inaturalist-open-data.s3.amazonaws.com` licensed CC0, CC BY, CC BY-SA or public domain (by its credit, or else by iNaturalist's `license_code`), with `attribution.license` set; a photo on `static.inaturalist.org`, licensed NC or ND, or not at all is never offered, and a taxon whose photos are all such is left out. A `wikidata` hit (a Commons file) is offered only when Commons states its licence, given in `attribution.license`. Both pass the same test as a copy (`mayCopy`). `source` is one of `tmdb`, `anilist`, `igdb`, `steam`, `openlibrary`, `inaturalist`, `wikidata`, `web`; a client treats any other as unknown.

**Board**: `{uid, revision, updatedAt, deviceName, deleted, fingerprint, title, displayMode, category, coverImageUrl, coverImageUrls, authorName, publishedId, deletedAt, tiers, items, anonymous?, coverPictureId?, play?}`. `coverPictureId` is there only when the board has one, so a board without one reads as it always did. A game untouched for 30 days is left out.

**BoardIndexEntry**: `{uid, revision, updatedAt, deviceName, deleted, fingerprint, title, itemCount}`. `itemCount` counts the cards not in the trash.

## E2E

The website and the app run their end-to-end tests against this code in the Firebase emulators, under the project **`demo-tieryourlife`**. A `demo-` project exists nowhere: the emulators never send it anywhere real.

**What changes there, and only there.** `functions/src/emulator.ts` holds the one switch: `FUNCTIONS_EMULATOR === "true"` and every project id the runtime names (`GCLOUD_PROJECT`, `FIREBASE_CONFIG.projectId`) starts with `demo-`. Anywhere else everything behaves as in production. Under the switch:
- App Check is not asked for.
- Vision SafeSearch passes every picture, and Vision colours find none, so sections get neutral colours.
- The Natural Language classifier finds nothing.
- Picture search answers `{items: [], hasMore: false, notices: []}` (and `rest: false` for `part=quick`).
- `POST /lists/pictures/keep` stores a one-pixel PNG instead of fetching, and so does publishing for each picture from another site (and a face): the list points at a copy of the one-pixel PNG.
- `tmdb` answers `{page: 1, results: [], total_pages: 0, total_results: 0}`.
- Gemini returns no image, so `generate` answers `502 GENERATION_FAILED` with the credit given back; generation is off anyway unless `OFFER_GENERATION=yes`.
- The search sweep translates nothing.
- No function declares its secrets, so the emulator never asks Secret Manager, and no key is needed.

Storage, Firestore and Auth are the emulators' own. Pictures really are copied in the Storage emulator. The addresses lists carry still name `https://firebasestorage.googleapis.com/v0/b/demo-tieryourlife.appspot.com/o/...`; to fetch one in a test, swap the origin for `http://127.0.0.1:9199`.

**Params.** `functions/.env.demo-tieryourlife` names the owner (`MODERATOR_UID=e2eOwner0001`, `MODERATOR_EMAIL=owner@e2e.test`). These are placeholders that only this project reads, so the emulators never prompt for a value. It overrides a local `functions/.env` for the demo project.

**Base URLs.** Ports are those in `firebase.json`:

| Function | URL |
|---|---|
| `lists` | `http://127.0.0.1:5001/demo-tieryourlife/europe-west1/lists` |
| `boards` | `http://127.0.0.1:5001/demo-tieryourlife/europe-west1/boards` |
| `adoptGuestCredits` | `http://127.0.0.1:5001/demo-tieryourlife/europe-west1/adoptGuestCredits` |
| `tmdb` | `http://127.0.0.1:5001/demo-tieryourlife/europe-west1/tmdb` |
| `credits`, `generate` | `http://127.0.0.1:5001/demo-tieryourlife/europe-west1/credits`, `…/generate` |
| Auth | `127.0.0.1:9099` |
| Firestore | `127.0.0.1:8080` |
| Storage | `127.0.0.1:9199` |

Routes go after the function, Hosting-style or not: `…/lists/lists/mine` and `…/lists/mine` are one route, as are `…/boards/boards/{uid}` and `…/boards/{uid}`, and `…/tmdb/tmdb/3/search/multi` and `…/tmdb/3/search/multi`.

**ID tokens from the Auth emulator.** With the Firebase JS SDK, call `connectAuthEmulator(auth, "http://127.0.0.1:9099")` and sign in as usual. Over plain HTTP, the key is not checked:
- **Guest:** `POST http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo` with body `{"returnSecureToken": true}`. The answer's `idToken` goes in `Authorization: Bearer …`.
- **Signed-in account:** the guest becomes one, keeping its uid, with `POST …/v1/accounts:update?key=demo` and body `{"idToken": "<guest token>", "email": "someone@e2e.test", "password": "…", "returnSecureToken": true}`. Or `accounts:signUp` with `email` and `password`. Use the new `idToken`.
- **Owner:** after the seed, `POST …/v1/accounts:signInWithPassword?key=demo` with the owner's e-mail and password from `functions/scripts/seed-e2e.ts`.

Publishing, follows, rankings and keeping boards need a signed-in account; a guest gets `403 NOT_SIGNED_IN`.

**Seed.** `npm --prefix functions run seed:e2e`, with the emulators running, makes:
- the owner account;
- the built-in sections (the proxy also makes them on its first read);
- one approved topic, `Studio Ghibli` in `anime`.

It prints `{owner, sections, topic}` as JSON and is safe to run again. It refuses any host but 127.0.0.1 or localhost. `E2E_FUNCTIONS_URL` and `FIREBASE_AUTH_EMULATOR_HOST` override where it calls.

**Running.**
- Interactively: `npm --prefix functions run emulators:e2e`, which builds and then runs `firebase emulators:start --only functions,firestore,auth,storage --project demo-tieryourlife`.
- **CI** runs from the repository root, with Java 11+ and `firebase-tools` installed:

  ```sh
  npm --prefix functions ci
  npm --prefix functions run emulators:e2e:exec -- "<your test command>"
  ```

  This is the build plus `firebase emulators:exec --only functions,firestore,auth,storage --project demo-tieryourlife "<your test command>"`, which starts the emulators, waits until the functions are loaded, runs the command with `FIREBASE_AUTH_EMULATOR_HOST` and `FIRESTORE_EMULATOR_HOST` set, shuts everything down, and exits with the command's status. The command runs in `functions/`. It never prompts, and needs no login, keys or Application Default Credentials. Running `npm --prefix functions run build` and then that `firebase` line from the repository root does the same.
- The proxy's own smoke test of all this: `npm --prefix functions run test:e2e` (includes default-OFF quota regression). `npm --prefix functions run test:quota:e2e` launches a separate demo-only emulator child with fixture N=2 for real rolling-quota HTTP/concurrency/expiration tests; it never edits production settings. It covers guest sign-up, refusal of a guest's publication, the guest becoming an account, publishing with an own picture, the same `boardUid` again answering `existing`, a board PUT twice and read back, the tier limit, a staff move holding against the author's republish, the withdrawal marker, every catalogue answering empty, carrying credits, and the seed twice.

**Two suites on one machine.** The ports are fixed, so only one suite runs at a time. The Storage emulator keeps its files under the system temp directory, so give a second suite its own `TEMP`/`TMP`, and its own ports in a copy of `firebase.json` passed with `--config`.

## The website's functions (tieryourlife-web/functions)

These are not the proxy. They live in the website's repository (`functions/src/web.ts`, `ranking.ts`, `pages.ts`, `og.ts`, `share.ts`, `userDeleted.ts`) and are deployed from there as the `web` function, plus the `userDeleted` trigger.

Hosting serves them at the site's own paths: `/api/**`, `/l/**`, `/r/**`, `/og/**`, `/img/**`. They read the proxy's `publishedLists/{id}` documents and write only their own:
- `rankings/{code}`;
- share cards under `share/r/{code}/` and `share/l/{id}/` in Storage.

Of the proxy's data they also read, and never write:
- `publishedLists/{id}.underReview`;
- `auditLog` rows with `target == "publishedLists/{id}"` and `what == "report.takedown"`, to tell a list staff took down from one its author withdrew;
- `auditLog` rows with `target == "publishedLists/{id}"` and `what == "list.withdrawn_hidden"`: its author withdrew it while it was out of the feed (`underReview`). Either of these two rows keeps a removed list's rankings hidden.
- `bans/{uid}`: `{until, bannedAt, reason, identityKeys?}`; banned while it exists and `until === null || until > now`. `identityKeys` is only on an erased account's ban.
- `bannedIdentities/{key}`: `{until, bannedAt}`, a ban kept from an erased account, by the same rule. The caller's keys come from its ID token as `DELETE /boards/account` describes; an account is banned when `bans/{uid}` or any of these says so. The proxy's reading of both is `readBan` in `functions/src/banIdentities.ts`.
- `erasedAccounts/{uid}`: `{erasedAt}`, present once the account was erased. Its ID tokens stay valid for up to an hour; the proxy refuses their writes with `401 ACCOUNT_ERASED`.

Renaming those fields or those `what` values is a change to this section, agreed with the website first.

A change to their requests or answers changes this section in the same website PR.

### Who may call
- Every `/api/**` call needs `X-Firebase-AppCheck`, exactly as in the proxy: 401 `APP_UNVERIFIED`.
- **user:** any Firebase ID token in `Authorization: Bearer`, a guest included. Without one: 401 `UNAUTHENTICATED`.
- **account:** a signed-in, non-anonymous user. A guest gets 401 `NOT_SIGNED_IN` (on `PATCH`/`DELETE /api/rank/{code}` and `GET /api/me/rankings` too).

### Rankings
A ranking is one reader's placement of a published list's cards. Its code is 8 characters, `/r/{code}` is its page, and it stores a snapshot of the list as it was ranked.

| Call | Who | Body | Answer |
|---|---|---|---|
| `POST /api/rank` | user | `{listId, rows, version?, tierLabels?}` | 201 `{code, claimToken}` |
| `GET /api/rank/{code}` | anyone; with an account's ID token, `yours` says whether it keeps it | – | 200 ranking |
| `PUT /api/rank/{code}` | user who owns it (a guest owns an unclaimed one they made) | `{rows}` | 200 `{code}`, same link |
| `PATCH /api/rank/{code}` | account | `{claimToken}` | 200 `{code}`: a guest's ranking moves to the account after sign-in |
| `DELETE /api/rank/{code}` | account that owns it | – | 204, its share cards are deleted too |
| `GET /api/me/rankings` | account | – | 200 `{rankings, more}`, newest first, at most 200 |

**Body fields**
- **`rows`:** one array per tier of the list, in the list's tier order. Each array holds card indexes in the list's `items`, in the order they were placed.
  - Each card appears at most once; cards not mentioned stay unranked.
  - At least one card must be placed.
- **`version`:** the list's `updatedAt` (millis) as the reader opened it. If the list was republished since, the answer is 409 `LIST_CHANGED` and the client offers "Load it again". A body without `version` is accepted as before, for older clients.
- **`tierLabels`:** the tier words of the arrangement the reader started from, when they started from another reader's ranking. One string per tier, each at most 40 characters.

**Refusals.** Every one is `{error, code}` with the status shown.
- 400 `INVALID`: rows don't match the tiers, a card isn't on the list, a card is placed twice, nothing is placed, or a bad `listId` or `tierLabels`.
- 404 `NOT_FOUND`: no such list or ranking.
- 409 `LIST_CHANGED`.
- 403 `BANNED` (`{error, code, until}`): an account with a ban in force, on `POST` (checked before the list is read) and `PUT`. Guests are not checked. Deleting one's own ranking stays allowed.
- 403 `NOT_YOURS`: someone else keeps it, or the claim token doesn't match.
- 409 `CLAIMED`: another account already keeps it.
- 413 `TOO_LARGE`: body over 64 KB.
- 429 `BUSY`: one save at a time per person.
- 503 `DAILY_CEILING`: the site-wide daily cap.
- 503 `UNAVAILABLE`.

**Privacy**
- Finishing a ranking never adds the reader's name or photo to the list's public Rankings. Only an explicit request in the client does that.
- A ranking outlives its list, but then it shows no author name or photo.
- When an account is deleted, `userDeleted` takes that author's name and photo out of other people's rankings of their lists (`listAuthorUid`), deletes those rankings' share cards, and leaves the account's own rankings standing without an owner (`ownerUid: null`).

### Pages and pictures
- **`GET /l/{id}`, `GET /r/{code}`:** the site's HTML shell with the page's title, description and `og:image` for chats, and the data the board needs. No auth.
- **`GET /og/l/{id}.png`, `GET /og/r/{code}.png`:** share card images, 1200×630. For house lists, `?hl=` picks the language.
- **`GET /img/{width}/{kind}/{id}/{picture}`:** a section's or topic's picture resized for a page's width.

### Under the emulators
The `web` function honours the same rule as the proxy: App Check is skipped only when `FUNCTIONS_EMULATOR === "true"` and the project id starts with `demo-`.
