# TierYourLife proxy: the contract

The one description of what the proxy answers, read by the website and by the Android app. It is written from `functions/src`; where this file and the code disagree, the code is right and this file has a bug.

> **Rule.** A PR that changes a request or a response shape (a path, a method, a field, a status, an error `code`, a limit, a cursor) updates CONTRACT.md in the same PR. `functions/test/contract.test.ts` fails when a path word the routers answer is missing here, and when an exported function is not named here.

## Contents

- [Conventions](#conventions)
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
| user | `Authorization: Bearer <Firebase ID token>`, a guest's (anonymous sign-in) included. Missing or invalid: `401 UNAUTHENTICATED`. Every route of `lists`, `boards`, `credits`, `adoptGuestCredits`, `generate` needs it. |
| account | A user whose sign-in provider is not `anonymous`. A guest gets `403 NOT_SIGNED_IN` unless the route says otherwise. |
| not banned | An account without a live ban: else `403 {error, code: "BANNED", until}` (`until` is epoch ms, or `null` for forever). |
| staff | The owner or a moderator. Else `403 NOT_YOURS`. |
| owner | The owner alone: the account whose uid is `MODERATOR_UID` or whose verified e-mail is `MODERATOR_EMAIL`. A moderator gets `403 {code: "NOT_YOURS", detail: "owner_only"}`, anybody else `403 NOT_YOURS`. |

**Errors.** A refusal is JSON `{error, code, detail?}`: `error` is English for logs, `code` is what a client branches on. A few old refusals carry no `code`: `405 {error: "Use GET…"}` for a wrong method, `400 {error: "Which list?"}` / `"Which board?"`, `404 {error: "No such address"}` on `boards`, `400 Empty prompt` / `Prompt too long` on `generate`, and `tmdb`'s `404 Unknown path` / `502`. Any error the code did not expect is `503 UNAVAILABLE` on `lists` and `boards`.

**Times** are epoch milliseconds. **Colours** are `#RRGGBB`. **Text** is collapsed (runs of whitespace become one space), trimmed, and cut to its limit rather than refused, unless a limit says it refuses.

**Ids.** A list id or topic id is `[A-Za-z0-9_-]{1,64}`. A section id is `[a-z0-9][a-z0-9_-]{1,39}`. An author uid for follows is `[A-Za-z0-9]{8,128}`. A picture id (a file in the caller's `users/{uid}/pictures/` in Storage) is `[A-Za-z0-9_-]{1,64}`.

**Locales.** Sections and topics carry `names` keyed by `en uk ru es pt-BR de fr pl tr ja ar`. House-list translations are keyed by the same set without `en`.

**Built-in sections**, in their order: `anime`, `film_tv`, `games`, `music`, `books`, `food`, `sport`, `people`, `other`. They are made the first time anything reads sections, and `other` is always last and never hidden.

## Limits

| What | Limit | Where |
|---|---|---|
| List title, tier label, card title, board title, tier name in a ranking | 80 characters | `publishing.ts`, `sync.ts` |
| Tier caption | 60 | `publishing.ts`, `sync.ts` |
| Picture credit | 200 | `publishing.ts`, `sync.ts` |
| Picture address (`https://` only, others dropped) | 2000 | `publishing.ts`, `sync.ts` |
| Ranked tiers per list | 19 on a new list, else `400 TOO_MANY_TIERS`; a replace keeps up to as many as the stored list has, if that is more (some lists have 20) | `MAX_RANKED_TIERS`, `tierLimitFor` |
| Tiers per board | 20, **the pool included**: 19 ranked tiers and the pool | `MAX_TIERS_PER_BOARD` |
| Tier names in a ranking | 20 | `MAX_TIERS_PER_LIST` |
| Cards per list | 2000 (at least 1) | `MAX_ITEMS_PER_LIST` |
| Cards per board | 2000 live (without `deletedAt`, 0 allowed), plus up to 2000 more in the trash: at most 4000 in the body | `MAX_ITEMS_PER_BOARD`, `MAX_TRASHED_ITEMS_PER_BOARD` |
| A list snapshot, a board, as JSON | 700 000 bytes, else `413 TOO_LARGE` | `MAX_SNAPSHOT_BYTES`, `MAX_BOARD_BYTES` |
| Own photographs (distinct picture ids) per list | 200 | `MAX_OWN_PICTURES_PER_LIST` |
| Cover collage (`coverImageUrls`) | 6, deduplicated | `MAX_PREVIEW_IMAGES` |
| Published lists per author | 50 (the house has none) | `MAX_LISTS_PER_AUTHOR` |
| Boards kept per account | 200 not deleted | `MAX_BOARDS_PER_ACCOUNT` |
| Board uid, tier uid, item uid, `boardUid` of a publication | 1–100 characters | `sync.ts`, `readBoardUid` |
| Board fingerprint | 128 | `MAX_FINGERPRINT_LENGTH` |
| Device name | 40 | `MAX_DEVICE_NAME_LENGTH` |
| A game on a board | 2–64 cards, 2000 answers, kept 30 days after its last write | `sync.ts` |
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

**`GET /lists/{id}`**: `200 ListSummary + {tiers: PublishedTier[], items: PublishedItem[], translations}`. `404 NOT_FOUND` when there is none, or it is under review and the caller is not staff.

**`GET /lists/mine`**: the caller's own lists, newest first, not paged: `200 {lists: (ListSummary + {authorUid, authorName, authorPhotoUrl, anonymous} as stored + {proposedSection, proposedSectionName} + boardUid?)[]}`. `proposedSection` is the waiting proposal the list will move into, or `null`. `boardUid` is present when the publication said it.

**`GET /lists/following`**: whom and what the caller follows: `200 {authors: {uid, name, photoUrl}[], topics: Topic[], sections: {id, followerCount}[]}`. An author with no named list left has `name: ""`.

### Publishing

**`POST /lists`**: publish a board. **`POST /lists/{id}`**: replace a list the caller published. Account, not banned. A list out of the feed (`underReview`) stays out after it is replaced, until staff dismiss its reports; the new snapshot is not kept (`reviewed` false). An author who withdraws a list while it is out of the feed is held: each list they publish or replace starts out of the feed, with a note naming the withdrawn list in the reports queue, until staff take down or dismiss the withdrawn list's reports, take down a held list, or 14 days pass. Dismissing a held list puts that one back and leaves the hold.

Body:
- `title`: string, required.
- `category`: section id, required. It must be an approved, not hidden section; or one the list already sits in (a republish keeps a section after it is hidden); or the caller's own waiting or declined proposal, in which case the list is filed under the proposal's `fileUnder` (or `other`) and, while the proposal waits, moves in when it is approved; or a merged section, followed to where it went. Else `400 {code: "INVALID", detail: "category"}`.
- `tiers`: the ranked tiers, 1–19 of `{label, caption?, colorLight, colorDark}` (the pool is not a tier here: its cards are the unranked ones). More is `400 TOO_MANY_TIERS`. A replace may keep as many as the stored list already has, when that is more than 19.
- `items`: 1–2000 of `{title?, imageUrl?, pictureId?, tierIndex?, credit?}`. A card needs a title or a picture. `tierIndex` out of range, or absent, means unranked. `pictureId` names the caller's own photograph, which is copied to `published/{listId}/` after Vision SafeSearch passes it. An `imageUrl` or `coverImageUrl` into the caller's own folder (`/o/users%2F{uid}%2Fpictures%2F{id}`) is taken as that `pictureId` or `coverPictureId`; one into anyone else's folder is dropped, and so are own-folder addresses in `coverImageUrls`. A board kept in the account (`PUT /boards`) keeps its own-folder collage as sent.
- `coverImageUrl`, `coverPictureId`, `coverImageUrls` (the chosen collage, up to 6): optional.
- `anonymous`: `true` publishes without the author's name; `false` with it; absent keeps what a republished list was (a new one is named).
- Topic, at most one of: `topicId` (an existing topic; one merged into another means the topic it ended up at), `newTopic` (a name; reuses an approved topic of that name, or the caller's own waiting one, else proposes a new one, which holds the list in `other` until a moderator decides), or **`noTopic: true`**, which takes the topic off. Sending none of them (or `null`) on a republish keeps the list's topic while it stays in the same section, and moves it into the topic its proposal became. Two at once: `400 INVALID`.
- **Staff moves hold.** On a replace of a list staff moved (`movedByStaff`, see `POST /lists/{id}/move`), each moved field is judged on its own. A body that brings the field's `from` value, or does not bring the field at all (for the topic: none of `topicId`, `newTopic`, `noTopic`), keeps the staff's `to`. A body that brings another value, `newTopic`, or `noTopic: true` for the topic, wins, and that part of `movedByStaff` is cleared. The `topicId` in the answer is what was stored.
- `takenFrom`: the id of the list this board was copied from; the new list then carries `basedOn` crediting it (nobody by name when that list is anonymous, and nobody for one's own list or one under review).
- **`boardUid`**: the device's own uid of the board, 1–100 characters.

Answers:
- `201 {id, topicId, underReview}`: a new list.
- `200 {id, topicId, underReview}`: `POST /lists/{id}` replaced it.
- `underReview: true` means the list was kept but starts out of the feed (held, or replacing a hidden list): its link answers 404 to others until staff look. Tell the author it waits for moderation.
- **`200 {id, topicId, existing: true}`**: this author already published this `boardUid` (on `POST /lists` only). Nothing is written and the existing list is named, even for an author at the 50-list limit. This is what makes a retried publish idempotent. Once that list is unpublished the same `boardUid` publishes anew.

Refusals: `403 NOT_SIGNED_IN`, `403 BANNED`, `409 TOO_MANY_LISTS`, **`400 TOO_MANY_TIERS`** (`error` names the limit), `413 TOO_LARGE` (`error` names which limit), `400 INVALID` (`error` says what), `400 TOPIC_UNAVAILABLE` (someone else's waiting topic, or a rejected or merged one), `409 TOO_MANY_PENDING_TOPICS`, `422 {code: "PICTURE_REFUSED", because: "adult" | "racy" | "violence"}`, and for `POST /lists/{id}` `404 NOT_FOUND` and `403 NOT_YOURS`. A photograph that is missing from Storage is not a refusal: its card publishes without art.

Words of 20 characters or more go to the Natural Language classifier. It never refuses: a doubtful board is put in the reports queue, and a very doubtful one is also taken out of the feed until someone looks.

**`DELETE /lists/{id}`**: unpublish. `204`, also when there is no such list. `403 NOT_YOURS`. Its pictures, share cards and app rankings go with it. Withdrawing a list that is `underReview` also writes, in the same batch, the `auditLog` row `{who: <author uid>, role: "author", what: "list.withdrawn_hidden", target: "publishedLists/{id}", before: {underReview: true}, after: null, at}`.

**`PATCH /lists`**: account. Copies the caller's current name and face onto every list they published: `200 {updated: n}`.

**`POST /lists/face/{pictureId}`**: account. Copies one of the caller's photographs to `avatars/` after SafeSearch: `200 {url}`. `400 INVALID`, `422 PICTURE_REFUSED`.

### Follows and takes

**`GET /lists/follow`**: up to 12 suggested authors from the most taken lists, without the caller and whoever they follow: `200 {authors: {uid, name, photoUrl, takeCount}[]}`.

**`GET /lists/follow/{uid}`**: `200 {following: boolean, followers: n}`. `400 INVALID`.

**`POST /lists/follow/{uid}`**: account. Idempotent: `200 {following: true}`. `403 NOT_SIGNED_IN`, `409 YOURSELF`, `409 TOO_MANY_FOLLOWING` (200), `400 INVALID`.

**`DELETE /lists/follow/{uid}`**: idempotent, `200 {following: false}`.

**`POST /lists/{id}/taken`**: somebody put this list on their phone. Counted once per person, never for the author: `200 {counted: boolean}`. `404 NOT_FOUND`.

### Reports and moderation

**`POST /lists/{id}/report`**: body `{reason, note?}`, `reason` one of `sexual`, `violence`, `hate`, `spam`, `other`, `wrong_category`. One report per person per list (a second replaces the first). `204`, also for a list already gone. `400 INVALID` for another reason. The list leaves the feed (`underReview`) on the first `sexual` report or the third report of any reason but `wrong_category`, unless staff already kept this snapshot. Reports from guests, banned accounts and accounts younger than 7 days are filed and shown to staff but do not count towards that, and never take a list out themselves.

**`GET /lists/reports`**: staff. `200 {reports: QueuedList[]}` from the 50 newest reports, one row per list, hidden lists first: `{listId, listTitle, authorName, authorUid, authorPhotoUrl, anonymous, coverImageUrl, reasons, notes, reportCount, newestAtMs, hidden, reviewed}`. On an anonymous list (`anonymous: true`), and on a list already removed whose reports do not say it was named, only the owner is told the author; a moderator gets `authorName: ""`, `authorUid: null`, `authorPhotoUrl: null`.

**`POST /lists/{id}/takedown`**: staff. Body `{ban?}`, `ban` one of `week`, `month`, `three_months`, `six_months`, `forever` (a month is 30 days). Deletes the list and its reports, and bans the author when asked: `204`.

**`POST /lists/{id}/dismiss`**: staff. Puts the list back and marks this snapshot kept, so complaints no longer hide it: `204`. A list already removed stays removed; only its reports go.

**`POST /lists/{id}/move`**: staff. Body `{topicId}` (an approved topic; the list takes its section) or `{category, topicId?: null}` (an approved section; the list keeps its topic only if that topic is in the section, and loses it when `topicId: null` is sent). `204`. `400 INVALID`, `404 NOT_FOUND`. The list remembers the move as **`movedByStaff: {category?: {from, to}, topicId?: {from, to}}`** (`topicId` sides may be `null`), one entry per field that changed; `from` stays the author's value across later moves, and a move back to it drops that entry. The author's replace keeps these unless the body says otherwise (`POST /lists`, "Staff moves hold").

**`GET /lists/anonymous?after=`**: owner. Every anonymous list, newest first, with who published it: `200 {lists: (ListSummary + {publishedBy: {uid, name}})[], nextCursor}`. Cursor is the last id; `409 CURSOR_GONE`.

**`GET /lists/admin/counts`**: staff. `200 {reports: n, proposals: n}`.

**`GET /lists/admin/lists?section=&topic=&sort=&after=`**: staff. One section's lists, under review included. `topic` is a topic id, `none` (lists without a topic) or `other` (lists whose topic is not an approved topic of the section); absent means all. `200 {lists: (ListSummary + {underReview, publishedBy, proposedSection, proposedSectionName})[], nextCursor}`; `publishedBy` is `null` to a moderator on an anonymous list. `400 {code: "INVALID", detail: "section" | "topic" | "after"}`, `409 CURSOR_GONE`.

**`GET /lists/moderators`**: staff. `200 {moderators: {uid, name, photoUrl, email?, appointedAt}[]}`; `email` goes to the owner only.

**`GET /lists/moderators/candidates?q=`**: owner. Up to 10 signed-in accounts whose name, a word of it, or e-mail starts with `q` (2 characters or more): `200 {people: {uid, name, email, photoUrl}[]}`.

**`POST /lists/moderators/{uid}`**: owner. Body `{name?, photoUrl?}`. `200 {uid, moderator: true}`. `409 YOURSELF`, `404 NOT_FOUND`, `400 {code: "INVALID", detail: "uid"}` for a guest account.

**`DELETE /lists/moderators/{uid}`**: owner. `204`.

**`POST /lists/search-misses`**: body `{q}`. Notes a search that found nothing anywhere (only the folded words, never who). Always `204`.

**`GET /lists/search-misses`**: staff. The 100 most asked: `200 {misses: {q, count, lastAt}[]}`.

### Rankings

A reader's own placing of somebody's list, kept beside it.

**`GET /lists/{id}/rankings?after=`**: `200 {rankings: Ranking[], nextCursor}`, newest first, 30 a page; on the first page the caller's own comes first with `mine: true`. The website's account-less rankings are not shown. **Cursor:** a ranking id, or `~<seconds>.<nanoseconds>` after a run of rankings that are not shown. `409 CURSOR_GONE`.

**`PUT /lists/{id}/rankings/mine`**: account, not banned. Body `{tierLabels, rows}` or, the old way, `{tierLabels, arrangement}`:
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

**`POST /lists/topics`**: staff. Body `{name, section, pictureId?}`: an approved topic outright, in an open section. `201 Topic`. `400 {code: "INVALID", detail: "name" | "section"}`, `409 {code: "NAME_TAKEN", id, detail: id}`, `400 BAD_PICTURE`.

**`PATCH /lists/topics/{id}`**: staff. Body `{name?, names?, pictureId?}` (`pictureId: null` removes the picture; an empty translation removes it). `200 Topic`. `400 INVALID`, `400 BAD_PICTURE`, `409 NAME_TAKEN`, `409 SETTLED`.

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

**`POST /lists/editorial`**: staff. Publish body as `POST /lists`: `201 {id, topicId}`. No count limit; no classifier. The same 19 ranked tiers, `400 TOO_MANY_TIERS`.

**`PUT /lists/editorial/{id}`**: staff. Replace: `200 {id, topicId}`. Its translations stay, pruned to the texts it still shows. Tiers and staff moves as for `POST /lists/{id}`.

**`DELETE /lists/editorial/{id}`**: staff. `204`.

**`PUT /lists/editorial/{id}/translations`**: staff. Body `{translations: {<locale>: {<text as written>: <text in that locale>}}}`: locales as above without `en`; the keys are the list's own title, tier labels and captions and card titles. Replaces the translations whole and keeps only those the list shows: `200 {id, translations, dropped}`. `404 NOT_FOUND` (not a house list), `400 {code: "INVALID", detail}` (`detail` like `locale:xx`, `too_many:xx`, `too_long:xx`, `not_text:xx`), `413 TOO_LARGE`.

**House translations and `names`.** A reader shows `translations[locale]?.[text] ?? text` for every text of a house list (`GET /lists/{id}` carries `translations`). Every list summary carries `names`: its title in each locale it has been translated into (empty for a list that is not the house's), so a feed card needs no second read. A copy of a house list keeps those words. Topics and sections carry `names` of their own.

### Picture search

**`GET /lists/pictures?q=&scope=&lang=&page=&web=&part=`**: the catalogues a scope names, asked together.
- `scope`: `all` (default), `film_tv`, `anime`, `games`, `music`, `books`, `people`, `animals`.
- `lang`: a BCP-47 tag like `en` or `pt-BR`; default `en`.
- `page`: 1–20.
- `web=1` (or `web=true`): ask the paid web search even outside `all`.
- `part=quick`: only the fast catalogues; the answer's `rest` says whether the whole search could add more.

`200 {items: PictureHit[], hasMore, notices, rest?}`, `notices` holding `"webOff"` or `"webDailyLimit"`. `400 QUERY_TOO_SHORT`, `502 SOURCES_DOWN` (every catalogue failed). Answers are cached three days.

**`POST /lists/pictures/keep`**: body `{url}`: copies a web picture into the caller's own folder, for a browser that cannot read another site's bytes. `200 {pictureId}`. `400 NO_URL`, `422 {code}` with `BAD_URL`, `KEEP_LIMIT`, `NOT_ALLOWED` (not https, or a private address), `UNREACHABLE`, `NOT_A_PICTURE` (only JPEG, PNG, WebP, GIF), `TOO_BIG`.

## `boards`

The copy of a person's boards their account keeps. Not the published list: the board itself, pool and trash included. All routes: App Check and user.

**`GET /boards?after=`**: `200 {boards: BoardIndexEntry[], next: string | null}`, ordered by uid, 100 a page; **cursor** `next` is the last uid, passed back as `after`. A guest gets `{boards: [], next: null}`, not a refusal.

**`GET /boards/{uid}`**: `200 Board`. `404 NOT_FOUND`.

**`PUT /boards/{uid}`**: account. Body: the board (below) plus `basedOn` (the revision the device worked from; absent for a first write) and `deviceName?`. Answers:
- `200 {uid, revision}`: stored, `revision` one higher.
- `200 {uid, revision}` with the stored revision unchanged: the same board again (its `fingerprint` equals the stored one). This makes a retried PUT idempotent.
- `409 {code: "CONFLICT", board: Board}`: the account moved on since `basedOn` and the content differs. Nothing is merged: the device keeps both.

Refusals: `403 NOT_SIGNED_IN`, `409 TOO_MANY_BOARDS`, `413 TOO_LARGE`, `400 INVALID` (`error` says what).

Board body: `{title, displayMode?, category?, coverImageUrl?, coverImageUrls?, authorName?, publishedId?, deletedAt?, fingerprint?, anonymous?, tiers, items, play?}`:
- `tiers`: 1–20 of `{uid, position, label, caption?, colorLight, colorDark, isPool?}`, uids distinct. The 20 includes the pool: 19 ranked tiers and the pool.
- `items`: up to 2000 live cards (no `deletedAt`) plus up to 2000 in the trash, so at most 4000, of `{uid, tierUid, position, title, imageUrl?, pictureId?, source?, deletedAt?, credit?}`. A card needs a title or a picture that is kept (a `pictureId`, or an `imageUrl` another device can fetch); a card with only a picture is stored with `title: ""`. `tierUid` must name a tier of the board; `source` is `MANUAL` (default), `TMDB` or `GENERATED`; `pictureId` is `[A-Za-z0-9_-]{1,100}`; `deletedAt` set means in the trash.
- `play`: a game under way, `{kind: "swiss" | "hill" | "bracket", count, seed, refine, ids, history, round, startedAt, scope?, keepTier?}`. One that does not read strictly, or would push the board past its size, is dropped and the board kept.
- **`displayMode`**: `WRAP` (default, also for anything unknown), `HORIZONTAL_SCROLL`, `FLAT_RANKED`. The first builds' `RANKED` is read as `FLAT_RANKED`.

**`DELETE /boards/{uid}`**: account. Leaves a marker `{deleted: true}` with a new revision so other phones drop it too: `204`, also for none.

**`DELETE /boards/account`**: account. Erases the account and everything the service holds about it: `204`. A guest gets `403 NOT_SIGNED_IN`.

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
- `sweepGuests`: daily, deletes guest identities unused for 30 days.
- `sweepPictures`: daily, deletes own pictures no board names, after their first day.
- `sweepSearch`: every 15 minutes, adds every language to the search keys of new lists and topics.
- `houseFill`: answers picture-search jobs that `scripts/house-fill.ts` writes to `houseFillJobs`.
- `checkUpload` (us-east1, beside the bucket): on every file landing in `users/{uid}/pictures/`, removes it if its first bytes are not JPEG, PNG, GIF or WebP, or if it is the account's 2001st upload that UTC day. The client is not told; its download URL then answers 404, and `keep` or publishing treat the picture as missing.

## Shapes

**ListSummary**: `{id, title, names, authorUid, authorName, authorPhotoUrl, anonymous, mine?, viewerFollowsAuthor?, tierCounts, category, itemCount, coverImageUrl, previewImages, tierColors, topicId, topicName, updatedAt, takeCount, rankingCount, basedOn}`.
- An anonymous list goes out with `authorUid: ""`, `authorName: ""`, `authorPhotoUrl: null`, `anonymous: true`, to everybody but its author on `GET /lists/mine`.
- `mine: true` only on the reader's own list.
- `viewerFollowsAuthor` only for a signed-in reader and a named list.
- `tierCounts`: cards per tier in tier order, then the unranked.
- `basedOn`: `{id, title, authorUid, authorName}` (empty strings when anonymous) or `null`.

**PublishedTier** `{label, caption, colorLight, colorDark}`. **PublishedItem** `{title, imageUrl, tierIndex, credit?}`.

**Ranking** `{uid, authorName, authorPhotoUrl, arrangement, rows, tierLabels, updatedAtMs, mine?}`.

**Topic** `{id, name, names, section, status: "pending" | "approved" | "rejected" | "merged", listCount, followerCount, following, createdBy?, mergedInto, pictureUrl}`. `createdBy` goes only to its proposer and staff, and for a topic first named by an anonymous list only to its proposer and the owner.

**SectionView** `{id, name, names, icon, pictureUrl, tint, topicBg, topicIcon, status: "approved" | "pending" | "declined" | "merged", builtIn, hidden, rank, approvedAt, listCount, lists30d, newThisWeek, followerCount, following, collage}`. Each colour is `{light, dark}`; `collage` is four picture addresses or none.
- Its proposer, while it is not approved, also gets `fileUnder`, `proposerUid`, `declineNote`, `mergedInto`, `mergedTopicId` and `waitingLists`.
- Staff get those and `proposerName`, `palette`, `unfinished`, `finish?`, `withdrawn`, `createdAt`, `decidedAt`, `decidedBy`, and on the queue `nameClash`: `null`, `{kind: "topic", id, name, section, sectionName}` or `{kind: "section", id, name}`.

**PictureHit** `{id: "<source>:<id>", title, subtitle, imageUrl, thumbUrl, source, kind, credit?}`.

**Board**: `{uid, revision, updatedAt, deviceName, deleted, fingerprint, title, displayMode, category, coverImageUrl, coverImageUrls, authorName, publishedId, deletedAt, tiers, items, anonymous?, play?}`. A game untouched for 30 days is left out.

**BoardIndexEntry**: `{uid, revision, updatedAt, deviceName, deleted, fingerprint, title, itemCount}`. `itemCount` counts the cards not in the trash.

## E2E

The website and the app run their end-to-end tests against this code in the Firebase emulators, under the project **`demo-tieryourlife`**. A `demo-` project exists nowhere: the emulators never send it anywhere real.

**What changes there, and only there.** `functions/src/emulator.ts` holds the one switch: `FUNCTIONS_EMULATOR === "true"` and every project id the runtime names (`GCLOUD_PROJECT`, `FIREBASE_CONFIG.projectId`) starts with `demo-`. Anywhere else everything behaves as in production. Under the switch:
- App Check is not asked for.
- Vision SafeSearch passes every picture, and Vision colours find none, so sections get neutral colours.
- The Natural Language classifier finds nothing.
- Picture search answers `{items: [], hasMore: false, notices: []}` (and `rest: false` for `part=quick`).
- `POST /lists/pictures/keep` stores a one-pixel PNG instead of fetching.
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
- The proxy's own smoke test of all this: `npm --prefix functions run test:e2e`. It covers guest sign-up, refusal of a guest's publication, the guest becoming an account, publishing with an own picture, the same `boardUid` again answering `existing`, a board PUT twice and read back, the tier limit, a staff move holding against the author's republish, the withdrawal marker, every catalogue answering empty, carrying credits, and the seed twice.

**Two suites on one machine.** The ports are fixed, so only one suite runs at a time. The Storage emulator keeps its files under the system temp directory, so give a second suite its own `TEMP`/`TMP`, and its own ports in a copy of `firebase.json` passed with `--config`.

## The website's functions (tieryourlife-web/functions)

These are not the proxy. They live in the website's repository (`functions/src/web.ts`, `ranking.ts`, `pages.ts`, `og.ts`, `share.ts`, `userDeleted.ts`) and are deployed from there as the `web` function, plus the `userDeleted` trigger.

Hosting serves them at the site's own paths: `/api/**`, `/l/**`, `/r/**`, `/og/**`, `/img/**`. They read the proxy's `publishedLists/{id}` documents and write only their own:
- `rankings/{code}`;
- share cards under `share/r/{code}/` and `share/l/{id}/` in Storage.

Of the proxy's data they also read, and never write:
- `publishedLists/{id}.underReview`;
- `auditLog` rows with `target == "publishedLists/{id}"` and `what == "report.takedown"`, to tell a list staff took down from one its author withdrew;
- `auditLog` rows with `target == "publishedLists/{id}"` and `what == "list.withdrawn_hidden"`: its author withdrew it while it was out of the feed (`underReview`).

Renaming those fields or those `what` values is a change to this section, agreed with the website first.

A change to their requests or answers changes this section in the same website PR.

### Who may call
- Every `/api/**` call needs `X-Firebase-AppCheck`, exactly as in the proxy: 401 `APP_UNVERIFIED`.
- **user:** any Firebase ID token in `Authorization: Bearer`, a guest included. Without one: 401 `UNAUTHENTICATED`.
- **account:** a signed-in, non-anonymous user. A guest gets 401 `NOT_SIGNED_IN`.

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
