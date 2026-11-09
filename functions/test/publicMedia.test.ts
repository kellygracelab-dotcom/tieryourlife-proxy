import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Response } from "express";
import { publicMediaJson, publicMediaResponses, publicMediaUrl, storageMediaUrl } from "../src/publicMedia";
import { addressOf, foreignCopyOf, publishedNamesIn } from "../src/publishedPictures";
import { checkedFace, committedOutsideCopies, isOurCopy, outsideAddressesIn, outsideName, type OutsideTools } from "../src/outsidePictures";
import { decidePublish, settle } from "../src/publishing";
import { arrangementOver, sameCards } from "../src/rankings";
import { replacedSectionPicture, storedPathOf } from "../src/sectionPictures";

const BUCKET = "tieryourlife.firebasestorage.app";
const PREFIX = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/`;
const SITE = "https://tieryourlife.web.app/img/original/";
const LIST = "AbCdEfGhIjKlMnOpQrSt";
const PICTURE = "w-0123456789abcdef0123456789abcdef_p_11888bec-19d6-48d1-b81c-d57119c6f4cd";
const path = `published/${LIST}/${PICTURE}`;
const raw = addressOf(BUCKET, path);
const shown = SITE + path;

describe("public image API compatibility", () => {
  it("lets a legacy image loader fetch all four already-public kinds without Storage headers", () => {
    for (const kind of ["published", "avatars", "sections", "topics"]) {
      const object = `${kind}/old-id/${PICTURE}`;
      const old = addressOf(BUCKET, object);
      assert.equal(publicMediaUrl(old), SITE + object);
      assert.equal(publicMediaUrl(old.replace(/%2F/g, "%2f") + "&token=legacy-download-token"), SITE + object);
      assert.equal(storageMediaUrl(SITE + object), old);
      assert.equal(publicMediaUrl(SITE + object), SITE + object);
    }
  });

  it("does not route private proposals, user pictures, other buckets or malformed paths through the site", () => {
    const excluded = [
      `${PREFIX}users%2Fowner%2Fpictures%2Fphoto?alt=media&token=private`,
      `${PREFIX}proposals%2Fpending%2Fphoto?alt=media&token=private`,
      `${PREFIX}published%2Flist%2F..%2Fusers?alt=media`,
      `${PREFIX}published%252Flist%252Fphoto?alt=media`,
      `${PREFIX}published/list/photo?alt=media`,
      `${PREFIX}published%2Flist%2Fphoto`,
      raw.replace(BUCKET, "other-bucket"),
      raw.replace("https://", "http://"),
      raw.replace("googleapis.com/", "googleapis.com.evil.test/"),
      raw.replace("https://", "https://user:password@"),
      raw.replace("googleapis.com/", "googleapis.com:8443/"),
      `${SITE}users/owner/photo`, `${SITE}proposals/pending/photo`,
      `${SITE}published/list/../photo`, `${SITE}published/list/encoded%2Fname`,
      `${SITE}published/${"a".repeat(129)}/photo`,
      `${SITE}published/list/${"p".repeat(1024)}`,
      shown.replace("web.app/", "web.app.evil.test/"),
      "https://image.tmdb.org/t/p/w500/poster.jpg",
    ];
    for (const url of excluded) {
      assert.equal(publicMediaUrl(url), url, url);
      assert.equal(storageMediaUrl(url), url, url);
    }
  });

  it("changes image fields in feed/detail/House/sections/faces, without mutating records or identity fields", () => {
    const pending = `${PREFIX}proposals%2Fpending%2Fphoto?alt=media&token=private`;
    const stored = {
      id: LIST, title: raw, authorUid: raw, credit: raw,
      lists: [{ coverImageUrl: raw, previewImages: [raw], authorPhotoUrl: raw }],
      items: [{ title: "Card", imageUrl: raw, credit: "© Author" }],
      sections: [{ pictureUrl: raw, collage: [raw] }, { pictureUrl: pending }],
      topics: [{ picture: { url: raw } }],
      authors: [{ photoUrl: raw }], url: raw,
    };
    const untouched = structuredClone(stored);
    const wire = publicMediaJson(stored) as typeof stored;
    assert.deepEqual(wire.lists, [{ coverImageUrl: shown, previewImages: [shown], authorPhotoUrl: shown }]);
    assert.equal(wire.items[0].imageUrl, shown);
    assert.equal(wire.sections[0].pictureUrl, shown);
    assert.deepEqual(wire.sections[0].collage, [shown]);
    assert.equal(wire.sections[1].pictureUrl, pending);
    assert.equal(wire.topics[0].picture.url, shown);
    assert.equal(wire.authors[0].photoUrl, shown);
    assert.equal(wire.url, shown);
    assert.equal(wire.id, LIST);
    assert.equal(wire.title, raw);
    assert.equal(wire.authorUid, raw);
    assert.equal(wire.credit, raw);
    assert.deepEqual(stored, untouched);
  });

  it("uses the community JSON boundary while preserving existing non-plain JSON serialization", () => {
    let body: unknown;
    const response = { json(value: unknown) { body = JSON.stringify(value); return this; } } as Response;
    publicMediaResponses(response);
    const date = new Date("2026-11-09T00:00:00Z");
    assert.equal(response.json({ imageUrl: raw, at: date }), response);
    assert.deepEqual(JSON.parse(body as string), { imageUrl: shown, at: date.toISOString() });
  });

  it("round-trips an existing cover and cards without changing stored object names or fetching them outside", () => {
    const decision = decidePublish({
      isAnonymous: false, listsAlreadyPublished: 0, uploaderUid: "owner",
      body: { title: "Round trip", category: "film_tv", tiers: [{ label: "S", caption: null, colorLight: "#112233", colorDark: "#445566" }],
        items: [{ title: "Card", imageUrl: shown }], coverImageUrl: shown, coverImageUrls: [shown] },
    });
    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    const list = settle(decision.draft, new Map());
    assert.equal(list.items[0].imageUrl, raw);
    assert.equal(list.coverImageUrl, raw);
    assert.deepEqual(list.previewImages, [raw]);
    assert.deepEqual(outsideAddressesIn(list, LIST, BUCKET), []);
    assert.deepEqual(publishedNamesIn(LIST, [shown, raw]), [PICTURE, PICTURE]);
    assert.equal(foreignCopyOf(LIST, shown), null);
    assert.deepEqual(foreignCopyOf("copy-list", shown), {
      from: path, to: `published/copy-list/${LIST}-${PICTURE}`, list: LIST,
    });
  });

  it("preserves card matching and duplicate order across old raw and new public addresses", () => {
    const original = [{ title: "First", imageUrl: raw }, { title: "Second", imageUrl: raw }];
    const placed = [{ title: "Renamed", imageUrl: shown, tierIndex: 2 }, { title: "Again", imageUrl: shown, tierIndex: 0 }];
    assert.equal(sameCards(original, placed), true);
    assert.deepEqual(arrangementOver(original, placed), [2, 0]);
    assert.equal(sameCards(original, [{ ...placed[0], imageUrl: shown + "-other" }, placed[1]]), false);
  });

  it("reuses committed copies with their existing names after a display-address round trip", () => {
    const outside = "https://example.org/picture.jpg";
    const name = `${outsideName(outside)}_p_11888bec-19d6-48d1-b81c-d57119c6f4cd`;
    const url = addressOf(BUCKET, `published/${LIST}/${name}`);
    const list = { items: [{ imageUrl: publicMediaUrl(url) }], coverImageUrl: null, previewImages: [] };
    assert.equal(committedOutsideCopies(list, [outside], `published/${LIST}/`, BUCKET).get(outside), url);
    assert.equal(isOurCopy(shown, BUCKET, `published/${LIST}/`), true);
    assert.equal(isOurCopy(shown, BUCKET, "published/someone-else/"), false);
  });

  it("keeps the approved avatar as the same own copy, without another fetch, review or quota charge", async () => {
    const avatar = addressOf(BUCKET, "avatars/owner/photo-id");
    const unexpected = async (): Promise<never> => { throw new Error("Must reuse the own avatar"); };
    const tools: OutsideTools = { bucket: BUCKET, namesIn: unexpected, save: unexpected, remove: unexpected,
      fetch: unexpected, lookAt: unexpected, reserve: unexpected, giveBack: unexpected };
    assert.equal(await checkedFace("owner", publicMediaUrl(avatar), tools), avatar);
  });

  it("retains section replacement cleanup paths and never turns a pending proposal into a public URL", () => {
    const old = addressOf(BUCKET, "sections/animals/old-picture");
    const replacement = addressOf(BUCKET, "sections/animals/new-picture");
    assert.equal(storedPathOf(publicMediaUrl(old)), "sections/animals/old-picture");
    assert.equal(replacedSectionPicture("animals", publicMediaUrl(old), publicMediaUrl(replacement)), "sections/animals/old-picture");
    assert.equal(replacedSectionPicture("animals", publicMediaUrl(old), old), null);
    const privateUrl = `${PREFIX}proposals%2Fpending%2Fphoto?alt=media&token=private`;
    assert.equal((publicMediaJson({ pictureUrl: privateUrl }) as { pictureUrl: string }).pictureUrl, privateUrl);
  });
});
