/**
 * The e2e mode end to end: `npm run test:e2e`. A guest signs up on the Auth
 * emulator and becomes an account, publishes twice from one board, keeps a
 * board, and reaches every proxied function with no App Check token and no
 * keys, by both the direct and the Hosting-style path.
 */
import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import { before, describe, it } from "node:test";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { E2E_NOT_COPIED_PHOTO, STUB_PICTURE } from "../src/emulator";
import { decideStore, MAX_BOARD_BYTES, MAX_PLAY_HISTORY } from "../src/sync";
import { PROJECT, assertEmulatorsOnly, call, identity, passwordAccount, ownerToken, seed } from "./seed-e2e";

const TIER = { label: "S", colorLight: "#FF7F7F", colorDark: "#7F3F3F" };

/** An account of its own: the smoke's main one is banned along the way. */
async function newAuthor(prefix: string): Promise<string> {
  const guest = (await identity("signUp", {})).idToken;
  return (await passwordAccount(guest, `${prefix}-${Date.now().toString(36)}@e2e.test`)).idToken;
}

describe("the proxy under the demo emulators", () => {
  let guest = "";
  let token = "";

  before(async () => {
    assertEmulatorsOnly();
    guest = (await identity("signUp", {})).idToken;
    // The account links a different guest; the guest-only assertions need a still-anonymous live session.
    const accountGuest = (await identity("signUp", {})).idToken;
    const suffix = Date.now().toString(36);
    token = (await passwordAccount(accountGuest, `e2e-${suffix}@e2e.test`)).idToken;
  });

  it("answers a guest without App Check, and refuses it a publication", async () => {
    assert.deepEqual((await call(guest, "GET", "/boards")).body, { boards: [], next: null });
    const refused = await call(guest, "POST", "/lists", { title: "x" });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "NOT_SIGNED_IN");
  });

  it("publishes a board once, and answers its second publication with the first list", async () => {
    const kept = await call(token, "POST", "/lists/pictures/keep", { url: "https://example.invalid/a.png" });
    assert.equal(kept.status, 200);
    const board = `board-${Date.now().toString(36)}`;
    const body = {
      title: "End to end smoke list",
      category: "film_tv",
      tiers: [TIER],
      items: [{ title: "First card", tierIndex: 0 }, { title: "", pictureId: kept.body.pictureId, tierIndex: 0 }],
      boardUid: board,
    };
    const first = await call(token, "POST", "/lists", body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const again = await call(token, "POST", "/lists/lists", body);
    assert.deepEqual(again, { status: 200, body: { id: first.body.id, topicId: null, existing: true, revision: 1 } });

    const list = await call(token, "GET", `/lists/${first.body.id}`);
    assert.equal(list.status, 200);
    assert.match(String((list.body.items as { imageUrl: string }[])[1].imageUrl), /published%2F/);
    const mine = await call(token, "GET", "/lists/lists/mine");
    assert.equal((mine.body.lists as { boardUid?: string }[])[0].boardUid, board);
  });

  it("takes a picture by its link with the page it was found on, for an account and never a guest, and the house must name the page", async () => {
    const url = `https://example.invalid/linked-${Date.now().toString(36)}.png`;
    const page = "https://example.com/found-here";
    const author = await newAuthor("linked");
    assert.deepEqual((await call(guest, "POST", "/lists/pictures/link", { url })).status, 403);
    assert.equal((await call(author, "POST", "/lists/pictures/link", { url, link: "http://example.com/page" })).body.code, "BAD_LINK");
    assert.equal((await call(author, "POST", "/lists/pictures/link", {})).status, 400);

    const linked = await call(author, "POST", "/lists/pictures/link", { url, link: page, credit: " Jane  Doe " });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.deepEqual(linked.body.attribution, { source: "web", link: page });
    assert.equal(linked.body.credit, "Jane Doe");
    const resetsAt = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) + 86_400_000;
    assert.deepEqual(linked.body.quota, { left: 399, limit: 400, resetsAt });
    const again = await call(author, "POST", "/lists/pictures/link", { url });
    assert.equal(again.body.pictureId, linked.body.pictureId);
    assert.equal((again.body.quota as { left: number }).left, 399);
    const poster = "https://image.tmdb.org/t/p/w500/linked.jpg";
    assert.deepEqual((await call(author, "POST", "/lists/pictures/link", { url: poster })).body, { imageUrl: poster, attribution: { source: "tmdb" }, quota: { left: 399, limit: 400, resetsAt } });
    assert.deepEqual((await call(author, "GET", "/lists/pictures/link")).body, { quota: { left: 399, limit: 400, resetsAt } });
    assert.equal((await call(guest, "GET", "/lists/pictures/link")).status, 403);

    const card = { title: "Found", pictureId: linked.body.pictureId, tierIndex: 0, credit: "Jane Doe", attribution: { source: "web", link: page } };
    const published = await call(author, "POST", "/lists", { title: "Linked picture smoke", category: "film_tv", tiers: [TIER], items: [card] });
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const item = ((await call(author, "GET", `/lists/${published.body.id}`)).body.items as { imageUrl: string; attribution?: unknown; credit?: string }[])[0];
    assert.match(item.imageUrl, /published%2F/);
    assert.deepEqual(item.attribution, { source: "web", link: page });
    assert.equal(item.credit, "Jane Doe");

    const owner = await ownerToken();
    const houseLinked = await call(owner, "POST", "/lists/pictures/link", { url: `${url}?house` });
    assert.equal(houseLinked.status, 200, JSON.stringify(houseLinked.body));
    const house = (link?: string) => call(owner, "POST", "/lists/editorial", {
      title: "Linked picture house smoke", category: "film_tv", tiers: [TIER],
      items: [{ title: "Poster", imageUrl: poster, tierIndex: 0 }, { title: "Found", pictureId: houseLinked.body.pictureId, tierIndex: 0, attribution: { source: "web", ...(link ? { link } : {}) } }],
    });
    assert.deepEqual((await house()).body.code, "PICTURE_LINK_NEEDED");
    assert.equal((await house()).body.itemIndex, 1);
    const named = await house(page);
    assert.equal(named.status, 201, JSON.stringify(named.body));

    // The house's editor may credit a picture and the cover themself; a credit needs a licence we know.
    const credit = { source: "web", manual: true, author: "Jane Doe", license: "cc by-sa 4.0", link: page };
    const credited = (items: unknown[], coverAttribution?: unknown) => call(owner, "POST", "/lists/editorial", {
      title: "Credited house smoke", category: "film_tv", tiers: [TIER], coverImageUrl: poster, ...(coverAttribution ? { coverAttribution } : {}), items,
    });
    const refused = await credited([{ title: "Found", pictureId: houseLinked.body.pictureId, tierIndex: 0, attribution: { ...credit, license: undefined } }]);
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.deepEqual([refused.body.code, refused.body.reason, refused.body.itemIndex], ["BAD_ATTRIBUTION", "NO_LICENSE", 0]);
    const badCover = await credited([{ title: "Poster", imageUrl: poster, tierIndex: 0 }], { manual: true, license: "All Rights Reserved", link: page });
    assert.deepEqual([badCover.body.code, badCover.body.reason, badCover.body.cover], ["BAD_ATTRIBUTION", "UNKNOWN_LICENSE", true]);
    const kept = await credited(
      [{ title: "Found", pictureId: houseLinked.body.pictureId, tierIndex: 0, attribution: credit }, { title: "Poster", imageUrl: poster, tierIndex: 0 }],
      { manual: true, license: "Used with permission", link: "https://www.themoviedb.org/movie/603" },
    );
    assert.equal(kept.status, 201, JSON.stringify(kept.body));
    const shown = (await call(owner, "GET", `/lists/${kept.body.id}`)).body;
    const [found, plain] = shown.items as { imageUrl: string; attribution?: unknown }[];
    assert.match(found!.imageUrl, /published%2F/);
    assert.deepEqual(found!.attribution, { source: "web", author: "Jane Doe", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/", link: page, manual: true });
    assert.deepEqual(plain!.attribution, { source: "tmdb" });
    assert.deepEqual(shown.coverAttribution, { license: "Used with permission", link: "https://www.themoviedb.org/movie/603", manual: true });

    // Anybody else's credit is not read: their picture carries only the page it was found on.
    const ordinary = await call(author, "POST", "/lists", { title: "Credited by a person", category: "film_tv", tiers: [TIER], items: [{ ...card, attribution: credit }], coverAttribution: credit });
    assert.equal(ordinary.status, 201, JSON.stringify(ordinary.body));
    const theirs = (await call(author, "GET", `/lists/${ordinary.body.id}`)).body;
    assert.deepEqual((theirs.items as { attribution?: unknown }[])[0]!.attribution, { source: "web", link: page });
    assert.equal(theirs.coverAttribution, undefined);
  });

  it("credits each card's picture, copies an open photo and keeps its catalogue address, and leaves a poster where it is", async () => {
    const photo = "https://inaturalist-open-data.s3.amazonaws.com/photos/82354387/large.jpeg";
    const poster = "https://image.tmdb.org/t/p/w500/uXDfjJbdP4ijW5hWSBrPrlKpxab.jpg";
    const body = {
      title: "End to end attribution",
      category: "film_tv",
      tiers: [TIER],
      items: [
        { title: "Lion", imageUrl: photo, credit: "(c) Douglas Goldman, some rights reserved (CC BY-SA)", tierIndex: 0 },
        { title: "The Matrix", imageUrl: poster, attribution: { source: "tmdb", link: "https://www.themoviedb.org/movie/603", author: "ignored" }, tierIndex: 0 },
      ],
    };
    const published = await call(token, "POST", "/lists", body);
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const list = await call(token, "GET", `/lists/${published.body.id}`);
    const [lion, matrix] = list.body.items as { imageUrl: string; credit?: string; attribution?: Record<string, string> }[];
    assert.match(lion.imageUrl, new RegExp(`published%2F${published.body.id}%2Fw-[0-9a-f]{32}`));
    assert.equal(lion.credit, "(c) Douglas Goldman, some rights reserved (CC BY-SA)");
    assert.deepEqual(lion.attribution, {
      source: "inaturalist",
      author: "Douglas Goldman",
      license: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      link: "https://www.inaturalist.org/photos/82354387",
      originalUrl: photo,
    });
    assert.equal(matrix.imageUrl, poster);
    assert.deepEqual(matrix.attribution, { source: "tmdb", link: "https://www.themoviedb.org/movie/603", id: "tmdb:movie:603" });

    // Published again as the client got it back, the copy and its attribution stay; nothing is copied anew.
    const again = await call(token, "POST", `/lists/${published.body.id}`, { ...body, items: list.body.items });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const after = (await call(token, "GET", `/lists/${published.body.id}`)).body.items as { imageUrl: string; attribution?: Record<string, string> }[];
    assert.equal(after[0].attribution?.originalUrl, photo);
    assert.equal(after[0].attribution?.author, "Douglas Goldman");
    assert.match(after[0].imageUrl, /w-[0-9a-f]{32}/);
  });

  it("publishes a house list only once every licensed catalogue picture is our copy, and anybody else's as before", async () => {
    const owner = await ownerToken();
    const card = { title: "Uncopied", imageUrl: E2E_NOT_COPIED_PHOTO, credit: "(c) Jane Doe, some rights reserved (CC BY)", tierIndex: 0 };
    const body = { title: "House picture not copied", category: "film_tv", tiers: [TIER], items: [card] };
    const lists = getFirestore(initializeApp({ projectId: PROJECT }, "smoke-not-copied")).collection("publishedLists");
    const before = (await lists.where("authorUid", "==", "tyl-editorial").count().get()).data().count;
    const refused = await call(owner, "POST", "/lists/editorial", body);
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
    assert.equal(refused.body.code, "PICTURES_NOT_COPIED");
    assert.deepEqual(refused.body.imageUrls, [E2E_NOT_COPIED_PHOTO]);
    assert.ok(Number(refused.body.retryAt) > Date.now());
    assert.equal((await lists.where("authorUid", "==", "tyl-editorial").count().get()).data().count, before);

    const theirs = await call(token, "POST", "/lists", { ...body, title: "Person's picture not copied" });
    assert.equal(theirs.status, 201, JSON.stringify(theirs.body));
    assert.equal(((await call(token, "GET", `/lists/${theirs.body.id}`)).body.items as { imageUrl: string }[])[0]!.imageUrl, E2E_NOT_COPIED_PHOTO);
  });

  it("copies the catalogues switched on in config/pictureCopies: a house list's cards and cover", async () => {
    const owner = await ownerToken();
    const poster = "https://image.tmdb.org/t/p/w500/copySwitchSmoke.jpg";
    const switches = getFirestore(initializeApp({ projectId: PROJECT }, "smoke-copy-switch")).doc("config/pictureCopies");
    await switches.set({ sources: { tmdb: true } });
    try {
      const published = await call(owner, "POST", "/lists/editorial", {
        title: "Copied poster house smoke", category: "film_tv", tiers: [TIER], coverImageUrl: poster,
        items: [{ title: "Poster", imageUrl: poster, attribution: { source: "tmdb", link: "https://www.themoviedb.org/movie/603" }, tierIndex: 0 }],
      });
      assert.equal(published.status, 201, JSON.stringify(published.body));
      const shown = (await call(owner, "GET", `/lists/${published.body.id}`)).body;
      const card = (shown.items as { imageUrl: string; attribution?: Record<string, string> }[])[0]!;
      assert.match(card.imageUrl, new RegExp(`published%2F${published.body.id}%2Fw-[0-9a-f]{32}`));
      assert.equal(card.attribution?.originalUrl, poster);
      assert.equal(card.attribution?.source, "tmdb");
      assert.equal(shown.coverImageUrl, card.imageUrl);
      // The copy's file says what it was copied from, and when: how a catalogue's copies are fetched again or undone.
      const path = decodeURIComponent(card.imageUrl.split("/o/")[1]!.split("?")[0]!);
      const bucketName = card.imageUrl.split("/v0/b/")[1]!.split("/")[0]!;
      const [meta] = await getStorage(initializeApp({ projectId: PROJECT }, "smoke-copy-meta")).bucket(bucketName).file(path).getMetadata();
      const custom = meta.metadata as Record<string, string>;
      assert.deepEqual([custom.originalUrl, custom.source], [poster, "tmdb"]);
      assert.ok(Math.abs(Number(custom.copiedAt) - Date.now()) < 120_000);
    } finally {
      await switches.delete();
    }
  });

  it("makes a topic with its translations in one call, found by any of them", async () => {
    const owner = await ownerToken();
    const name = `Hand-drawn films ${Date.now().toString(36)}`;
    const made = await call(owner, "POST", "/lists/topics", { name, section: "anime", names: { uk: "Мальовані фільми", de: "Handgezeichnete Filme", fr: "" } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual(made.body.names, { uk: "Мальовані фільми", de: "Handgezeichnete Filme" });
    const found = await call(owner, "GET", `/lists/topics?q=${encodeURIComponent("Handgezeichnete")}`);
    assert.ok((found.body.topics as { id: string }[]).some((topic) => topic.id === made.body.id), JSON.stringify(found.body));
    const refused = await call(owner, "POST", "/lists/topics", { name: `${name} 2`, section: "anime", names: { xx: "Nope" } });
    assert.deepEqual([refused.status, refused.body.code, refused.body.detail], [400, "INVALID", "names"]);
    // An edit of one language keeps the others; an empty one takes its language away.
    const german = await call(owner, "PATCH", `/lists/topics/${made.body.id}`, { names: { de: "Gezeichnete Filme" } });
    assert.deepEqual([german.status, german.body.names], [200, { uk: "Мальовані фільми", de: "Gezeichnete Filme" }]);
    const noGerman = await call(owner, "PATCH", `/lists/topics/${made.body.id}`, { names: { de: "" } });
    assert.deepEqual(noGerman.body.names, { uk: "Мальовані фільми" });
  });

  it("keeps a topic picture's credit while the picture stays", async () => {
    const owner = await ownerToken();
    const { owner: { uid } } = await seed();
    // A topic picture is at least 960 px wide and 16:10: a black 960 x 600 PNG in the owner's own folder.
    const pictureId = `topic-${Date.now().toString(36)}`;
    await getStorage(initializeApp({ projectId: PROJECT }, "smoke-topic-picture")).bucket(`${PROJECT}.appspot.com`)
      .file(`users/${uid}/pictures/${pictureId}`).save(blankPng(960, 600), { contentType: "image/png", resumable: false });
    const kept = { body: { pictureId } };
    const credit = { author: "Jane Doe", license: "cc by-sa 4.0", link: "https://example.com/photos/1" };
    const name = `Credited topic ${Date.now().toString(36)}`;
    const bad = await call(owner, "POST", "/lists/topics", { name, section: "anime", pictureId: kept.body.pictureId, pictureAttribution: { ...credit, license: "All rights reserved" } });
    assert.deepEqual([bad.status, bad.body.code, bad.body.reason], [400, "BAD_ATTRIBUTION", "UNKNOWN_LICENSE"]);
    const made = await call(owner, "POST", "/lists/topics", { name, section: "anime", pictureId: kept.body.pictureId, pictureAttribution: credit });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual(made.body.pictureAttribution, { author: "Jane Doe", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/", link: "https://example.com/photos/1", manual: true });
    const renamed = await call(owner, "PATCH", `/lists/topics/${made.body.id}`, { names: { de: "Bewertetes Thema" } });
    assert.deepEqual(renamed.body.pictureAttribution, made.body.pictureAttribution);
    // A franchise's poster names no licence: credited to its title's catalogue page, kept as the catalogue's.
    const titled = await call(owner, "PATCH", `/lists/topics/${made.body.id}`, { pictureAttribution: { manual: true, author: "", license: "", link: "https://www.themoviedb.org/collection/10-star-wars-collection?language=ru" } });
    assert.equal(titled.status, 200, JSON.stringify(titled.body));
    assert.deepEqual(titled.body.pictureAttribution, { source: "tmdb", link: "https://www.themoviedb.org/collection/10" });
    const unlicensed = await call(owner, "PATCH", `/lists/topics/${made.body.id}`, { pictureAttribution: { link: "https://example.com/photos/2" } });
    assert.deepEqual([unlicensed.status, unlicensed.body.code, unlicensed.body.reason], [400, "BAD_ATTRIBUTION", "NO_LICENSE"]);
    const sentBack = await call(owner, "PATCH", `/lists/topics/${made.body.id}`, { names: { de: "Bewertetes Thema 2" }, pictureAttribution: titled.body.pictureAttribution });
    assert.deepEqual(sentBack.body.pictureAttribution, titled.body.pictureAttribution);
    const bare = await call(owner, "PATCH", `/lists/topics/${made.body.id}`, { pictureId: null });
    assert.deepEqual([bare.status, bare.body.pictureUrl, bare.body.pictureAttribution], [200, null, undefined]);
  });

  it("keeps which part of a cover shows on boards, lists, topics and sections, the centre when none", async () => {
    const focus = { x: 0.5, y: 0.2, zoom: 1.5 };
    const RANGE = "A focus is {x, y, zoom}: x and y from 0 to 1, zoom from 1 to 4";
    const author = await newAuthor("focus");
    const poster = "https://image.tmdb.org/t/p/w500/focusSmoke.jpg";
    const board = { title: "Focused board", fingerprint: "focus-1", coverImageUrl: poster, tiers: [{ ...TIER, uid: "tier-1", position: 0 }], items: [] };
    // Boards: kept as sent, refused out of range, kept for a writer from before that leaves it out, gone on null.
    assert.equal((await call(author, "PUT", "/boards/focused", { ...board, coverFocus: focus })).status, 200);
    assert.deepEqual((await call(author, "GET", "/boards/focused")).body.coverFocus, focus);
    const wide = await call(author, "PUT", "/boards/focused", { ...board, fingerprint: "focus-2", basedOn: 1, coverFocus: { x: 0.5, y: 0.5, zoom: 4.5 } });
    assert.deepEqual([wide.status, wide.body.code, wide.body.error], [400, "INVALID", `coverFocus: ${RANGE}`]);
    assert.equal((await call(author, "PUT", "/boards/focused", { ...board, title: "Renamed by an old phone", fingerprint: "focus-3", basedOn: 1 })).status, 200);
    assert.deepEqual((await call(author, "GET", "/boards/focused")).body.coverFocus, focus);
    assert.equal((await call(author, "PUT", "/boards/focused", { ...board, fingerprint: "focus-4", basedOn: 2, coverFocus: null })).status, 200);
    assert.equal("coverFocus" in (await call(author, "GET", "/boards/focused")).body, false);
    // Lists: told on the card and the page with the cover.
    const published = await call(author, "POST", "/lists", {
      title: "Focused list", category: "film_tv", tiers: [TIER], items: [{ title: "Arrival", imageUrl: poster }], coverImageUrl: poster, coverFocus: focus,
    });
    assert.equal(published.status, 201, JSON.stringify(published.body));
    assert.deepEqual((await call(author, "GET", `/lists/${published.body.id}`)).body.coverFocus, focus);
    const plain = await call(author, "POST", "/lists", { title: "Unfocused list", category: "film_tv", tiers: [TIER], items: [{ title: "Arrival", imageUrl: poster }], coverImageUrl: poster });
    assert.equal("coverFocus" in (await call(author, "GET", `/lists/${plain.body.id}`)).body, false);
    const badList = await call(author, "POST", "/lists", { title: "Bad focus", category: "film_tv", tiers: [TIER], items: [{ title: "Arrival" }], coverFocus: { x: -1, y: 0, zoom: 1 } });
    assert.deepEqual([badList.status, badList.body.code], [400, "INVALID"]);

    // Cards: the same field on a card's picture, kept for a writer that leaves it out.
    const cards = { title: "Focused cards", fingerprint: "cards-1", tiers: [{ ...TIER, uid: "tier-1", position: 0 }],
      items: [{ uid: "c1", tierUid: "tier-1", position: 0, title: "Arrival", imageUrl: poster, pictureFocus: focus }] };
    assert.equal((await call(author, "PUT", "/boards/focused-cards", cards)).status, 200);
    assert.deepEqual(((await call(author, "GET", "/boards/focused-cards")).body.items as { pictureFocus?: unknown }[])[0]?.pictureFocus, focus);
    const { pictureFocus: _left, ...oldCard } = cards.items[0]!;
    assert.equal((await call(author, "PUT", "/boards/focused-cards", { ...cards, fingerprint: "cards-2", basedOn: 1, items: [{ ...oldCard, title: "Arrival (2016)" }] })).status, 200);
    assert.deepEqual(((await call(author, "GET", "/boards/focused-cards")).body.items as { pictureFocus?: unknown }[])[0]?.pictureFocus, focus);
    const badCard = await call(author, "PUT", "/boards/focused-cards", { ...cards, fingerprint: "cards-3", basedOn: 2, items: [{ ...oldCard, pictureFocus: { x: 2, y: 0, zoom: 1 } }] });
    assert.deepEqual([badCard.status, badCard.body.code], [400, "INVALID"]);
    const cardList = await call(author, "POST", "/lists", { title: "Focused card list", category: "film_tv", tiers: [TIER], items: [{ title: "Arrival", imageUrl: poster, pictureFocus: focus }] });
    assert.equal(cardList.status, 201, JSON.stringify(cardList.body));
    assert.deepEqual(((await call(author, "GET", `/lists/${cardList.body.id}`)).body.items as { pictureFocus?: unknown }[])[0]?.pictureFocus, focus);

    // Topics and sections: staff set it with the picture; a new picture without one goes back to the centre.
    const owner = await ownerToken();
    const { owner: { uid } } = await seed();
    const bucket = getStorage(initializeApp({ projectId: PROJECT }, "smoke-focus-pictures")).bucket(`${PROJECT}.appspot.com`);
    const stamp = Date.now().toString(36);
    const [first, second, third, fourth] = ["a", "b", "c", "d"].map((letter) => `focus-${letter}-${stamp}`);
    for (const id of [first, second, third, fourth]) {
      await bucket.file(`users/${uid}/pictures/${id}`).save(blankPng(960, 600), { contentType: "image/png", resumable: false });
    }
    const badTopic = await call(owner, "POST", "/lists/topics", { name: `Bad focus ${stamp}`, section: "anime", pictureId: first, pictureFocus: { x: 0.5, y: 0.5 } });
    assert.deepEqual([badTopic.status, badTopic.body.code, badTopic.body.detail, badTopic.body.error], [400, "INVALID", "pictureFocus", RANGE]);
    const topic = await call(owner, "POST", "/lists/topics", { name: `Focused topic ${stamp}`, section: "anime", pictureId: first, pictureFocus: focus });
    assert.equal(topic.status, 201, JSON.stringify(topic.body));
    assert.deepEqual(topic.body.pictureFocus, focus);
    const moved = await call(owner, "PATCH", `/lists/topics/${topic.body.id}`, { pictureFocus: { x: 0.3, y: 0.3, zoom: 1 } });
    assert.deepEqual([moved.status, moved.body.pictureFocus], [200, { x: 0.3, y: 0.3, zoom: 1 }]);
    const renamed = await call(owner, "PATCH", `/lists/topics/${topic.body.id}`, { names: { de: "Fokussiert" } });
    assert.deepEqual(renamed.body.pictureFocus, { x: 0.3, y: 0.3, zoom: 1 });
    const repictured = await call(owner, "PATCH", `/lists/topics/${topic.body.id}`, { pictureId: second });
    assert.deepEqual([repictured.status, repictured.body.pictureFocus], [200, undefined]);
    const together = await call(owner, "PATCH", `/lists/topics/${topic.body.id}`, { pictureId: first, pictureFocus: focus });
    assert.deepEqual(together.body.pictureFocus, focus);
    const centred = await call(owner, "PATCH", `/lists/topics/${topic.body.id}`, { pictureFocus: null });
    assert.deepEqual([centred.status, centred.body.pictureFocus], [200, undefined]);

    const section = await call(owner, "POST", "/lists/sections", { name: `Focus ${stamp}`.slice(0, 24), icon: "movie", pictureId: third, pictureFocus: focus });
    assert.equal(section.status, 201, JSON.stringify(section.body));
    assert.deepEqual(section.body.pictureFocus, focus);
    const badSection = await call(owner, "PATCH", `/lists/sections/${section.body.id}`, { pictureFocus: { x: 0.5, y: 0.5, zoom: 0.5 } });
    assert.deepEqual([badSection.status, badSection.body.code, badSection.body.detail, badSection.body.error], [400, "INVALID", "pictureFocus", RANGE]);
    const sectionMoved = await call(owner, "PATCH", `/lists/sections/${section.body.id}`, { pictureFocus: { x: 0.7, y: 0.4, zoom: 2 } });
    assert.deepEqual([sectionMoved.status, sectionMoved.body.pictureFocus], [200, { x: 0.7, y: 0.4, zoom: 2 }]);
    const sectionRepictured = await call(owner, "PATCH", `/lists/sections/${section.body.id}`, { pictureId: fourth });
    assert.deepEqual([sectionRepictured.status, sectionRepictured.body.pictureFocus], [200, undefined]);
    // A section's translations are laid over the stored ones too.
    assert.equal((await call(owner, "PATCH", `/lists/sections/${section.body.id}`, { names: { uk: `Фокус ${stamp}` } })).status, 200);
    const sectionGerman = await call(owner, "PATCH", `/lists/sections/${section.body.id}`, { names: { de: `Fokus ${stamp}` } });
    assert.deepEqual([sectionGerman.status, sectionGerman.body.names], [200, { uk: `Фокус ${stamp}`, de: `Fokus ${stamp}` }]);
  });

  it("shows a board's catalogue pictures from one shared copy, the device's fingerprint and revision kept", async () => {
    const poster = "https://image.tmdb.org/t/p/w500/boardCopySmoke.jpg";
    const switches = getFirestore(initializeApp({ projectId: PROJECT }, "smoke-board-copy")).doc("config/pictureCopies");
    await switches.set({ sources: { tmdb: true } });
    try {
      const id = `bc${Date.now().toString(36)}`;
      const board = {
        title: "Board with a poster", fingerprint: "fp-poster", tiers: [{ uid: "t1", position: 0, ...TIER }], coverImageUrl: poster,
        items: [{ uid: "i1", tierUid: "t1", position: 0, title: "Poster", imageUrl: poster, source: "TMDB", attribution: { source: "tmdb", id: "tmdb:movie:603" } }],
      };
      const written = await call(token, "PUT", `/boards/${id}`, board);
      assert.equal(written.status, 200, JSON.stringify(written.body));
      assert.equal(written.body.revision, 1);
      const shared = (written.body.copies as Record<string, string>)[poster]!;
      assert.match(shared, /published%2Fcatalogue%2Fw-[0-9a-f]{32}/);
      const stored = (await call(token, "GET", `/boards/${id}`)).body;
      const card = (stored.items as { imageUrl: string; attribution: Record<string, string> }[])[0]!;
      assert.deepEqual([card.imageUrl, card.attribution.originalUrl, card.attribution.id, stored.coverImageUrl], [shared, poster, "tmdb:movie:603", shared]);
      assert.equal(stored.fingerprint, "fp-poster");
      // The same board sent again is the same board; another board with the poster shows the same file.
      assert.deepEqual((await call(token, "PUT", `/boards/${id}`, { ...board, basedOn: 0 })).body, { uid: id, revision: 1 });
      const again = await call(token, "PUT", `/boards/${id}`, { ...board, title: "Renamed", fingerprint: "fp-renamed", basedOn: 1 });
      assert.deepEqual([again.body.revision, (again.body.copies as Record<string, string>)[poster]], [2, shared]);
      const other = await call(token, "PUT", `/boards/${id}x`, { ...board, fingerprint: "fp-other" });
      assert.equal((other.body.copies as Record<string, string>)[poster], shared);
      // A board too large to show longer addresses keeps the catalogue's: about 673 KB of the 700 KB, over the 650 KB a move allows.
      const filler = Array.from({ length: 1990 }, (_, at) => ({ uid: `f${at}`, tierUid: "t1", position: at + 1, title: "x".repeat(80), imageUrl: `https://example.com/${"a".repeat(115)}` }));
      const heavy = await call(token, "PUT", `/boards/${id}h`, { ...board, fingerprint: "fp-heavy", items: [...board.items, ...filler] });
      assert.equal(heavy.status, 200, JSON.stringify(heavy.body).slice(0, 300));
      assert.equal(heavy.body.copies, undefined);
      await call(token, "DELETE", `/boards/${id}h`);
    } finally {
      await switches.delete();
    }
  });

  it("keeps a board and hands it back", async () => {
    const id = `b${Date.now().toString(36)}`;
    const board = {
      title: "Kept board",
      displayMode: "FLAT_RANKED",
      fingerprint: "fp-1",
      tiers: [{ uid: "t1", position: 0, ...TIER }],
      items: [{ uid: "i1", tierUid: "t1", position: 0, title: "Card" }],
    };
    assert.deepEqual(await call(token, "PUT", `/boards/${id}`, board), { status: 200, body: { uid: id, revision: 1 } });
    assert.deepEqual(await call(token, "PUT", `/boards/boards/${id}`, board), { status: 200, body: { uid: id, revision: 1 } });
    const stored = await call(token, "GET", `/boards/boards/${id}`);
    assert.equal(stored.body.displayMode, "FLAT_RANKED");
    assert.equal(stored.body.revision, 1);
    const index = await call(token, "GET", "/boards");
    assert.ok((index.body.boards as { uid: string }[]).some((one) => one.uid === id));
  });

  it("removes a file in someone's own folder that is not a picture, and leaves one that is", async () => {
    const bucket = getStorage(initializeApp({ projectId: PROJECT, storageBucket: `${PROJECT}.appspot.com` }, "smoke-upload")).bucket();
    const { localId } = await identity("signUp", {});
    const fake = bucket.file(`users/${localId}/pictures/fake`);
    const real = bucket.file(`users/${localId}/pictures/real`);
    await fake.save(Buffer.from("%PDF-1.7 not a picture"), { contentType: "image/jpeg", resumable: false });
    await real.save(STUB_PICTURE, { contentType: "image/png", resumable: false });

    let gone = false;
    for (let tries = 0; tries < 40 && !gone; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      gone = !(await fake.exists())[0];
    }
    assert.ok(gone, "the fake picture is still there");
    assert.ok((await real.exists())[0]);
  });

  it("bans the author of an anonymous list taken down with a ban", async () => {
    const published = await call(token, "POST", "/lists", {
      title: "Anonymous smoke list", category: "film_tv", tiers: [TIER], items: [{ title: "Card", tierIndex: 0 }], anonymous: true,
    });
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const reporter = (await identity("signUp", {})).idToken;
    assert.equal((await call(reporter, "POST", `/lists/${published.body.id}/report`, { reason: "spam" })).status, 204);

    const owner = await ownerToken();
    const queue = await call(owner, "GET", "/lists/reports");
    const row = (queue.body.reports as { listId: string; anonymous: boolean; authorUid: string | null }[]).find((one) => one.listId === published.body.id);
    assert.equal(row?.anonymous, true);
    assert.ok(row?.authorUid);

    assert.equal((await call(owner, "POST", `/lists/${published.body.id}/takedown`, { ban: "week" })).status, 204);
    const ban = await getFirestore(initializeApp({ projectId: PROJECT }, "smoke-ban")).collection("bans").doc(row.authorUid).get();
    assert.ok(ban.exists, "the anonymous author was not banned");

    assert.equal((await call(owner, "DELETE", `/lists/bans/${row.authorUid}`)).status, 204);
    assert.equal((await ban.ref.get()).exists, false, "the owner could not lift the ban");
  });

  it("keeps a hidden list hidden when its author publishes it again", async () => {
    // Its own author: the one above was banned with its anonymous list.
    const guest = (await identity("signUp", {})).idToken;
    const author = (await passwordAccount(guest, `hold-${Date.now().toString(36)}@e2e.test`)).idToken;
    const body = { title: "Hidden smoke list", category: "film_tv", tiers: [TIER], items: [{ title: "Card", tierIndex: 0 }] };
    const published = await call(author, "POST", "/lists", body);
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const id = String(published.body.id);
    const lists = getFirestore(initializeApp({ projectId: PROJECT }, "smoke-hold")).collection("publishedLists");
    await lists.doc(id).set({ underReview: true }, { merge: true });

    const again = await call(author, "POST", `/lists/${id}`, { ...body, title: "Hidden smoke list, again" });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal((await lists.doc(id).get()).get("underReview"), true);
  });

  it("leaves a list its author removed removed when staff dismiss its reports", async () => {
    const published = await call(token, "POST", "/lists", {
      title: "Removed smoke list", category: "film_tv", tiers: [TIER], items: [{ title: "Card", tierIndex: 0 }],
    });
    const reporter = (await identity("signUp", {})).idToken;
    assert.equal((await call(reporter, "POST", `/lists/${published.body.id}/report`, { reason: "spam" })).status, 204);
    assert.equal((await call(token, "DELETE", `/lists/${published.body.id}`)).status, 204);

    assert.equal((await call(await ownerToken(), "POST", `/lists/${published.body.id}/dismiss`, {})).status, 204);
    const lists = getFirestore(initializeApp({ projectId: PROJECT }, "smoke-husk")).collection("publishedLists");
    assert.equal((await lists.doc(String(published.body.id)).get()).exists, false);
  });

  it("keeps a hidden list hidden when its author withdraws it and publishes it again from another board", async () => {
    const guest = (await identity("signUp", {})).idToken;
    const author = (await passwordAccount(guest, `again-${Date.now().toString(36)}@e2e.test`)).idToken;
    const body = { title: "Withdrawn smoke list", category: "film_tv", tiers: [TIER], items: [{ title: "Card", tierIndex: 0 }], boardUid: `held-${Date.now().toString(36)}` };
    const visible = await call(author, "POST", "/lists", { ...body, title: "Visible smoke list", boardUid: `visible-${Date.now().toString(36)}` });
    const first = await call(author, "POST", "/lists", body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const lists = getFirestore(initializeApp({ projectId: PROJECT }, "smoke-again")).collection("publishedLists");
    await lists.doc(String(first.body.id)).set({ underReview: true }, { merge: true });
    assert.equal((await call(author, "DELETE", `/lists/${first.body.id}`)).status, 204);
    const marker = await getFirestore(initializeApp({ projectId: PROJECT }, "smoke-marker")).collection("auditLog")
      .where("target", "==", `publishedLists/${first.body.id}`).where("what", "==", "list.withdrawn_hidden").get();
    assert.equal(marker.size, 1);
    assert.deepEqual(
      (({ role, before, after }) => ({ role, before, after }))(marker.docs[0].data()),
      { role: "author", before: { underReview: true }, after: null },
    );

    const again = await call(author, "POST", "/lists", { ...body, boardUid: `copy-${Date.now().toString(36)}` });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal((await lists.doc(String(again.body.id)).get()).get("underReview"), true);
    const owner = await ownerToken();
    const queue = await call(owner, "GET", "/lists/reports");
    assert.ok((queue.body.reports as { listId: string }[]).some((one) => one.listId === again.body.id));

    // A decoy does not spend the hold: the next one is held too, until staff decide.
    const third = await call(author, "POST", "/lists", { ...body, boardUid: `third-${Date.now().toString(36)}` });
    assert.equal((await lists.doc(String(third.body.id)).get()).get("underReview"), true);
    assert.equal((await call(author, "POST", `/lists/${visible.body.id}`, body)).status, 200);
    assert.equal((await lists.doc(String(visible.body.id)).get()).get("underReview"), true);
    assert.equal((await call(owner, "POST", `/lists/${first.body.id}/dismiss`, {})).status, 204);
    const fourth = await call(author, "POST", "/lists", { ...body, boardUid: `fourth-${Date.now().toString(36)}` });
    assert.equal((await lists.doc(String(fourth.body.id)).get()).get("underReview"), false);
  });

  it("takes nineteen ranked tiers on a new list, and lets a list of twenty keep its twenty", async () => {
    const author = await newAuthor("tiers");
    const tiers = (count: number) => Array.from({ length: count }, (_unused, index) => ({ ...TIER, label: `T${index}` }));
    const body = { title: "Tiers smoke list", category: "film_tv", tiers: tiers(19), items: [{ title: "Card", tierIndex: 0 }] };
    const refused = await call(author, "POST", "/lists", { ...body, tiers: tiers(20) });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "TOO_MANY_TIERS");
    const published = await call(author, "POST", "/lists", body);
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const id = String(published.body.id);

    assert.equal((await call(author, "POST", `/lists/${id}`, { ...body, tiers: tiers(20) })).body.code, "TOO_MANY_TIERS");
    const lists = getFirestore(initializeApp({ projectId: PROJECT }, "smoke-tiers")).collection("publishedLists");
    await lists.doc(id).set({ tiers: tiers(20) }, { merge: true });
    assert.equal((await call(author, "POST", `/lists/${id}`, { ...body, tiers: tiers(20) })).status, 200);
    assert.equal((await call(author, "POST", `/lists/${id}`, { ...body, tiers: tiers(21) })).body.code, "TOO_MANY_TIERS");
  });

  it("keeps a list where staff moved it when its author republishes the same board, until the author says otherwise", async () => {
    const { topic } = await seed();
    const author = await newAuthor("moved");
    const body = { title: "Moved smoke list", category: "film_tv", tiers: [TIER], items: [{ title: "Card", tierIndex: 0 }] };
    const published = await call(author, "POST", "/lists", body);
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const id = String(published.body.id);
    assert.equal((await call(await ownerToken(), "POST", `/lists/${id}/move`, { topicId: topic.id })).status, 204);
    const lists = getFirestore(initializeApp({ projectId: PROJECT }, "smoke-move")).collection("publishedLists");
    assert.deepEqual((await lists.doc(id).get()).get("movedByStaff"), {
      category: { from: "film_tv", to: topic.section },
      topicId: { from: null, to: topic.id },
    });

    // The move moved the list's revision: the author's copy from before it is refused, and nothing is written.
    const stale = await call(author, "POST", `/lists/${id}`, { ...body, category: "games", baseRevision: 1 });
    assert.deepEqual([stale.status, stale.body.code, stale.body.revision], [409, "LIST_CHANGED", 2]);
    assert.equal((await lists.doc(id).get()).get("category"), topic.section);
    assert.deepEqual(await call(author, "POST", `/lists/${id}`, { ...body, baseRevision: 2 }), { status: 200, body: { id, topicId: topic.id, underReview: false, revision: 3 } });
    const kept = await lists.doc(id).get();
    assert.equal(kept.get("category"), topic.section);
    assert.equal(kept.get("topicId"), topic.id);

    assert.deepEqual(await call(author, "POST", `/lists/${id}`, { ...body, category: "games" }), { status: 200, body: { id, topicId: null, underReview: false, revision: 4 } });
    const chosen = await lists.doc(id).get();
    assert.equal(chosen.get("category"), "games");
    assert.equal(chosen.get("topicId"), null);
    assert.equal(chosen.get("movedByStaff"), undefined);
  });

  it("says where a house list comes from, on its page and in the feed, and nobody else's", async () => {
    const owner = await ownerToken();
    const listSource = { label: "Nix's fruit stream", url: "https://www.twitch.tv/videos/123456789" };
    const body = { title: "Fruit ranked on a stream", category: "food", tiers: [TIER], items: [{ title: "Mango", tierIndex: 0 }] };
    const bad = await call(owner, "POST", "/lists/editorial", { ...body, listSource: { label: "Stream", url: "http://www.twitch.tv/x" } });
    assert.deepEqual([bad.status, bad.body.code, bad.body.detail], [400, "INVALID", "listSource"]);
    const published = await call(owner, "POST", "/lists/editorial", { ...body, listSource: { ...listSource, label: "  Nix's   fruit stream " } });
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const id = String(published.body.id);
    assert.deepEqual((await call(owner, "GET", `/lists/${id}`)).body.listSource, listSource);
    const feed = (await call(owner, "GET", "/lists/editorial")).body.lists as { id: string; listSource?: unknown }[];
    assert.deepEqual(feed.find((one) => one.id === id)?.listSource, listSource);
    // An edit that leaves it out keeps it; null takes it away.
    assert.equal((await call(owner, "PUT", `/lists/editorial/${id}`, { ...body, title: "Fruit ranked on a stream, again" })).status, 200);
    assert.deepEqual((await call(owner, "GET", `/lists/${id}`)).body.listSource, listSource);
    assert.equal((await call(owner, "PUT", `/lists/editorial/${id}`, { ...body, listSource: null })).status, 200);
    assert.equal("listSource" in (await call(owner, "GET", `/lists/${id}`)).body, false);
    // A house cover credited to its title's catalogue page, as a topic's picture can be.
    const credited = await call(owner, "POST", "/lists/editorial", {
      ...body, title: "Matrix ranked", coverImageUrl: "https://image.tmdb.org/t/p/w500/matrixCover.jpg",
      coverAttribution: { manual: true, author: "", license: "", link: "https://www.themoviedb.org/movie/603-the-matrix?language=de" },
    });
    assert.equal(credited.status, 201, JSON.stringify(credited.body));
    assert.deepEqual((await call(owner, "GET", `/lists/${credited.body.id}`)).body.coverAttribution, { source: "tmdb", link: "https://www.themoviedb.org/movie/603", id: "tmdb:movie:603" });
    // A person's own list does not carry one.
    const author = await newAuthor("source");
    const own = await call(author, "POST", "/lists", { ...body, title: "My fruit", listSource });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    assert.equal("listSource" in (await call(author, "GET", `/lists/${own.body.id}`)).body, false);
  });

  it("refuses a house edit read at an older revision than the list now has, and writes nothing", async () => {
    const owner = await ownerToken();
    const lists = getFirestore(initializeApp({ projectId: PROJECT }, "smoke-revision")).collection("publishedLists");
    const body = { title: "Revision house smoke", category: "film_tv", tiers: [TIER], items: [{ title: "Card", tierIndex: 0 }] };
    const published = await call(owner, "POST", "/lists/editorial", body);
    assert.equal(published.status, 201, JSON.stringify(published.body));
    assert.equal(published.body.revision, 1);
    const id = String(published.body.id);
    assert.equal((await call(owner, "GET", `/lists/${id}`)).body.revision, 1);

    // A maintenance script fixes the cards: the revision moves, updatedAt (the feed's order) does not.
    const updatedAt = ((await lists.doc(id).get()).get("updatedAt") as { toMillis(): number }).toMillis();
    await lists.doc(id).update({ items: [{ title: "Card", tierIndex: 0, credit: "Fixed" }], revision: FieldValue.increment(1) });
    const opened = (await call(owner, "GET", `/lists/${id}`)).body;
    assert.deepEqual([opened.revision, opened.updatedAt], [2, updatedAt]);

    const stale = await call(owner, "PUT", `/lists/editorial/${id}`, { ...body, title: "Revision house smoke, old copy", baseRevision: 1 });
    assert.deepEqual([stale.status, stale.body.code, stale.body.revision], [409, "LIST_CHANGED", 2]);
    const untouched = await lists.doc(id).get();
    assert.deepEqual([untouched.get("title"), (untouched.get("items") as { credit?: string }[])[0]!.credit, untouched.get("revision")], ["Revision house smoke", "Fixed", 2]);
    const wrong = await call(owner, "PUT", `/lists/editorial/${id}`, { ...body, baseRevision: "2" });
    assert.deepEqual([wrong.status, wrong.body.code, wrong.body.detail], [400, "INVALID", "baseRevision"]);

    const saved = await call(owner, "PUT", `/lists/editorial/${id}`, { ...body, title: "Revision house smoke, edited", baseRevision: 2 });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.revision, 3);
    // New translations move it as well; a client that does not say what it read is written as before.
    assert.equal((await call(owner, "PUT", `/lists/editorial/${id}/translations`, { translations: { ru: { Card: "Карточка" } } })).status, 200);
    assert.equal((await call(owner, "GET", `/lists/${id}`)).body.revision, 4);
    assert.equal((await call(owner, "PUT", `/lists/editorial/${id}`, { ...body, baseRevision: 3 })).body.code, "LIST_CHANGED");
    const legacy = await call(owner, "PUT", `/lists/editorial/${id}`, body);
    assert.deepEqual([legacy.status, legacy.body.revision], [200, 5]);
  });

  it("answers every catalogue empty, with no keys", async () => {
    for (const path of ["/tmdb/3/search/multi?query=alien", "/tmdb/tmdb/3/search/multi?query=alien"]) {
      assert.deepEqual(await call(token, "GET", path), { status: 200, body: { page: 1, results: [], total_pages: 0, total_results: 0 } });
    }
    assert.deepEqual((await call(token, "GET", "/lists/pictures?q=alien&part=quick")).body, { items: [], hasMore: false, notices: [], rest: false });
    assert.deepEqual((await call(token, "GET", "/lists/lists/pictures?q=alien")).body, { items: [], hasMore: false, notices: [] });
  });

  it("carries a guest's credits and reads them", async () => {
    const carried = await call(token, "POST", "/adoptGuestCredits", { guestToken: (await identity("signUp", {})).idToken });
    assert.equal(carried.status, 200);
    assert.equal((await call(token, "GET", "/credits")).status, 200);
  });

  it("seeds the owner and a topic, twice over", async () => {
    const first = await seed();
    const second = await seed();
    assert.deepEqual(second, first);
    assert.ok(first.sections.includes("other"));
  });

  it("says on a board's marker why it is gone: deleted for good, or only the account's copy", async () => {
    const author = await newAuthor("removal");
    const uid = JSON.parse(Buffer.from(author.split(".")[1], "base64url").toString()).user_id as string;
    const db = getFirestore(initializeApp({ projectId: PROJECT }, "removal-smoke"));
    const board = { title: "Gone board", fingerprint: "gone-1", tiers: [{ ...TIER, uid: "tier-1", position: 0 }], items: [] };
    const markerOf = async (id: string) => ((await call(author, "GET", "/boards")).body.boards as { uid: string; deleted: boolean; removal?: string; revision: number }[]).find((x) => x.uid === id);
    for (const id of ["gone-forever", "gone-cloud", "gone-old", "gone-upgraded"]) assert.equal((await call(author, "PUT", `/boards/${id}`, board)).status, 200);
    // A live board says nothing about removal.
    assert.equal((await markerOf("gone-forever"))?.removal, undefined);
    assert.deepEqual([(await call(author, "DELETE", "/boards/gone-forever?removal=sideways")).status, (await markerOf("gone-forever"))?.deleted], [400, false]);
    assert.equal((await call(author, "DELETE", "/boards/gone-forever?removal=forever")).status, 204);
    const forever = await markerOf("gone-forever");
    assert.deepEqual([forever?.deleted, forever?.removal, forever?.revision], [true, "forever", 2]);
    assert.equal((await call(author, "GET", "/boards/gone-forever")).body.removal, "forever");
    // "cloud" asked or nothing asked (every client before): only the account's copy.
    assert.equal((await call(author, "DELETE", "/boards/gone-cloud?removal=cloud")).status, 204);
    assert.equal((await markerOf("gone-cloud"))?.removal, "cloud");
    assert.equal((await call(author, "DELETE", "/boards/gone-old")).status, 204);
    assert.equal((await markerOf("gone-old"))?.removal, "cloud");
    // "forever" is never taken back; "cloud" turns into it.
    assert.equal((await call(author, "DELETE", "/boards/gone-forever?removal=cloud")).status, 204);
    assert.deepEqual([(await markerOf("gone-forever"))?.removal, (await markerOf("gone-forever"))?.revision], ["forever", 3]);
    assert.equal((await call(author, "DELETE", "/boards/gone-upgraded")).status, 204);
    assert.equal((await call(author, "DELETE", "/boards/gone-upgraded?removal=forever")).status, 204);
    assert.deepEqual([(await markerOf("gone-upgraded"))?.removal, (await markerOf("gone-upgraded"))?.revision], ["forever", 3]);
    // A marker from before says "cloud".
    await db.collection("accounts").doc(uid).collection("boards").doc("gone-legacy").set({ revision: 4, deviceName: null, deleted: true, updatedAt: new Date() });
    assert.equal((await markerOf("gone-legacy"))?.removal, "cloud");
    // A board changed on a device still goes back up over the marker, as before.
    const back = await call(author, "PUT", "/boards/gone-forever", { ...board, fingerprint: "gone-2", basedOn: 3 });
    assert.deepEqual([back.status, (await markerOf("gone-forever"))?.deleted, (await markerOf("gone-forever"))?.removal], [200, false, undefined]);
  });

  it("keeps a near-limit board and long game atomically, including legacy edit, explicit clear and account erasure", async () => {
    const author = await newAuthor("large-play");
    const uid = JSON.parse(Buffer.from(author.split(".")[1], "base64url").toString()).user_id as string;
    const db = getFirestore(initializeApp({ projectId: PROJECT }, "large-play-smoke"));
    const ref = db.collection("accounts").doc(uid).collection("boards").doc("large-play");
    const gameRef = db.collection("accounts").doc(uid).collection("plays").doc("large-play");
    const items = Array.from({ length: 2000 }, (_, i) => ({ uid: `card-${i}`, tierUid: "tier-1", position: i, title: "Card", imageUrl: "" }));
    const base = { title: "Large board", fingerprint: "large-1", tiers: [{ ...TIER, uid: "tier-1", position: 0 }], items };
    let bytes = 0;
    for (const item of items) {
      const decision = decideStore({ body: base, isAnonymous: false, boardsAlreadyKept: 0, nowMs: Date.now() });
      assert.ok(decision.ok);
      bytes = Buffer.byteLength(JSON.stringify(decision.board), "utf8");
      if (bytes > MAX_BOARD_BYTES - 3000) break;
      item.imageUrl = `https://img.test/${"x".repeat(1800)}`;
    }
    assert.ok(bytes > MAX_BOARD_BYTES - 3000 && bytes < MAX_BOARD_BYTES);
    const play = { kind: "swiss", count: 2000, seed: 42, refine: true, ids: items.map((x) => x.uid),
      history: Array.from({ length: MAX_PLAY_HISTORY }, (_, i) => [i % 2000, (i + 1) % 2000, i % 3 === 0 ? null : i % 2000]),
      round: 12, startedAt: Date.now() - 1000 };
    const created = await call(author, "PUT", "/boards/large-play", { ...base, play });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal((await ref.get()).get("separatePlay"), true);
    assert.equal((await ref.get()).get("play"), undefined);
    assert.equal((await gameRef.get()).get("play.historyEncoding"), "u16le-v1");
    assert.deepEqual((await call(author, "GET", "/boards/large-play")).body.play, play);

    const renamed = { ...base, title: "Legacy rename", fingerprint: "large-2", basedOn: 1 };
    assert.equal((await call(author, "PUT", "/boards/large-play", renamed)).status, 200);
    const recovered = (await call(author, "GET", "/boards/large-play")).body;
    assert.deepEqual(recovered.play, play);
    assert.match(recovered.fingerprint as string, /^game-v1:[a-f0-9]{64}$/);
    const index = await call(author, "GET", "/boards");
    assert.equal((index.body.boards as { uid: string; fingerprint: string }[]).find((x) => x.uid === "large-play")?.fingerprint, recovered.fingerprint);
    // A repeated legacy request whose acknowledgement was lost remains idempotent.
    assert.equal((await call(author, "PUT", "/boards/large-play", renamed)).body.revision, 2);
    const stale = await call(author, "PUT", "/boards/large-play", { ...renamed, play: null });
    assert.equal(stale.status, 409);
    assert.deepEqual((stale.body.board as { play: unknown }).play, play);

    // The opaque board fingerprint may not have changed; explicit clear must still be applied.
    assert.equal((await call(author, "PUT", "/boards/large-play", { ...renamed, fingerprint: recovered.fingerprint, basedOn: 2, play: null })).status, 200);
    assert.equal((await gameRef.get()).exists, false);
    assert.equal((await call(author, "GET", "/boards/large-play")).body.play, undefined);
    assert.equal((await call(author, "PUT", "/boards/large-play", { ...renamed, basedOn: 3, fingerprint: "large-3" })).status, 200);
    assert.equal((await call(author, "GET", "/boards/large-play")).body.play, undefined);

    const withGame = await call(author, "PUT", "/boards/large-play", { ...base, fingerprint: "large-4", basedOn: 4, play });
    assert.equal(withGame.status, 200);
    const concurrent = await Promise.all([
      call(author, "PUT", "/boards/large-play", { ...base, fingerprint: "concurrent-edit", basedOn: 5 }),
      call(author, "PUT", "/boards/large-play", { ...base, fingerprint: "concurrent-clear", basedOn: 5, play: null }),
    ]);
    assert.deepEqual(concurrent.map((x) => x.status).sort(), [200, 409]);
    const current = await call(author, "GET", "/boards/large-play");
    assert.equal(current.status, 200);
    const reset = await call(author, "PUT", "/boards/large-play", { ...base, fingerprint: "large-5", basedOn: current.body.revision, play });
    assert.equal(reset.status, 200);
    assert.equal((await call(author, "DELETE", "/boards/large-play")).status, 204);
    assert.equal((await gameRef.get()).exists, false);
    assert.equal((await call(author, "PUT", "/boards/erase-play", { ...base, fingerprint: "erase", play })).status, 200);
    assert.equal((await db.collection("accounts").doc(uid).collection("plays").doc("erase-play").get()).exists, true);
    // Race writes already entering the handler against the erasure marker and cleanup.
    const inflight = [0, 1, 2].map((i) => call(author, "PUT", "/boards/erase-play", { ...base, fingerprint: `inflight-${i}`, basedOn: 1, play }));
    const erasure = call(author, "DELETE", "/boards/account");
    const replies = await Promise.all(inflight);
    assert.ok(replies.every((x) => [200, 401, 409].includes(x.status)), JSON.stringify(replies.map((x) => x.status)));
    assert.equal((await erasure).status, 204);
    assert.equal((await db.collection("accounts").doc(uid).collection("plays").get()).size, 0);
    assert.equal((await db.collection("accounts").doc(uid).collection("boards").get()).size, 0);
    assert.equal((await db.collection("accounts").doc(uid).get()).exists, false);
    assert.equal((await call(author, "PUT", "/boards/resurrect", { ...base, play })).status, 401);
  });
});

/** A black PNG of [width] x [height]: a picture big enough to be a section's or a topic's. */
function blankPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(height * (1 + width * 3));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
