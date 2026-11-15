import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { observationIdOf, observationPhoto, photoIdOf } from "../src/inaturalistObservations";
import { catalogueAnswer, readLinkRequest, withObservation, type LinkAsked } from "../src/pictureLinks";

const OBSERVATION = "https://www.inaturalist.org/observations/414906442";
const OPEN = "https://inaturalist-open-data.s3.amazonaws.com/photos/763891835/large.jpg";
const answer = {
  results: [{
    id: 414906442,
    photos: [
      { id: 763891830, url: "https://static.inaturalist.org/photos/763891830/square.jpeg", attribution: "(c) Someone, all rights reserved", license_code: null },
      { id: 763891835, url: "https://inaturalist-open-data.s3.amazonaws.com/photos/763891835/square.jpg", attribution: "(c) WATANABE  Hitoshi, some rights reserved (CC BY)", license_code: "cc-by" },
    ],
  }],
};

function asked(body: unknown): LinkAsked {
  const read = readLinkRequest(body);
  assert.ok(!("error" in read));
  return read;
}

describe("an iNaturalist photo's credit, from its observation", () => {
  it("reads an observation page and a photo's address on either host", () => {
    assert.equal(observationIdOf(OBSERVATION), "414906442");
    assert.equal(observationIdOf("https://inaturalist.org/observations/12/"), "12");
    assert.equal(observationIdOf("https://www.inaturalist.org/photos/12"), null);
    assert.equal(observationIdOf("http://www.inaturalist.org/observations/12"), null);
    assert.equal(observationIdOf("https://www.inaturalist.org.example.com/observations/12"), null);
    assert.equal(observationIdOf(null), null);
    assert.equal(photoIdOf(OPEN), "763891835");
    assert.equal(photoIdOf("https://static.inaturalist.org/photos/12/medium.jpeg?1700000000"), "12");
    assert.equal(photoIdOf("https://example.com/photos/12/large.jpg"), null);
  });

  it("picks the photo asked for, or else the first openly licensed one, at its large size", () => {
    assert.deepEqual(observationPhoto(answer, null), { imageUrl: OPEN, credit: "(c) WATANABE Hitoshi, some rights reserved (CC BY)" });
    assert.deepEqual(observationPhoto(answer, "763891830"), {
      imageUrl: "https://static.inaturalist.org/photos/763891830/large.jpeg",
      credit: "(c) Someone, all rights reserved",
    });
    assert.equal(observationPhoto(answer, "1"), null);
    assert.deepEqual(observationPhoto({ results: [{ photos: [answer.results[0]!.photos[0]] }] }, null)?.imageUrl, "https://static.inaturalist.org/photos/763891830/large.jpeg");
    assert.equal(observationPhoto({ results: [{ photos: [] }] }, null), null);
    assert.equal(observationPhoto({ results: [] }, null), null);
    assert.equal(observationPhoto(null, null), null);
  });

  it("makes a pasted observation page its photo, with the author and the licence", async () => {
    const asks: string[] = [];
    const found = await withObservation(asked({ url: OBSERVATION }), async (id) => (asks.push(id), answer));
    assert.deepEqual(asks, ["414906442"]);
    assert.ok(!("error" in found));
    assert.deepEqual(found, { url: OPEN, catalogue: "inaturalist", link: null, credit: "(c) WATANABE Hitoshi, some rights reserved (CC BY)" });
    assert.deepEqual(catalogueAnswer(found.url, found.link, found.credit), {
      source: "inaturalist",
      author: "WATANABE Hitoshi",
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      link: "https://www.inaturalist.org/photos/763891835",
    });
  });

  it("refuses an observation it cannot read or that has no photo", async () => {
    assert.deepEqual(await withObservation(asked({ url: OBSERVATION }), () => Promise.reject(new Error("down"))), { error: "UNREACHABLE" });
    assert.deepEqual(await withObservation(asked({ url: OBSERVATION }), async () => ({ results: [{ photos: [] }] })), { error: "NOT_A_PICTURE" });
  });

  it("gives a photo's address the credit of that photo when its observation page comes with it", async () => {
    const found = await withObservation(asked({ url: OPEN, link: OBSERVATION }), async () => answer);
    assert.ok(!("error" in found));
    assert.equal(found.credit, "(c) WATANABE Hitoshi, some rights reserved (CC BY)");
    assert.equal(catalogueAnswer(found.url, found.link, found.credit)?.license, "CC BY 4.0");
    // Another photo of the observation is not this one's credit.
    const other = await withObservation(asked({ url: "https://inaturalist-open-data.s3.amazonaws.com/photos/9/large.jpg", link: OBSERVATION }), async () => answer);
    assert.ok(!("error" in other));
    assert.equal(other.credit, null);
  });

  it("asks nothing for a credit already sent, another catalogue, or an address alone", async () => {
    const never = () => Promise.reject(new Error("asked"));
    for (const body of [
      { url: OPEN, link: OBSERVATION, credit: "(c) Me, some rights reserved (CC BY)" },
      { url: OPEN },
      { url: "https://image.tmdb.org/t/p/w500/a.jpg", link: OBSERVATION },
      { url: "https://example.com/a.jpg", link: OBSERVATION },
    ]) assert.deepEqual(await withObservation(asked(body), never), asked(body), JSON.stringify(body));
    // A failed answer leaves the address as it came.
    assert.deepEqual(await withObservation(asked({ url: OPEN, link: OBSERVATION }), never), asked({ url: OPEN, link: OBSERVATION }));
  });
});
