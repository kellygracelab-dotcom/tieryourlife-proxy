import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { addressOf } from "../src/publishedPictures";
import { keepUploadedPhoto, pointsAt, readPhotoSlot, removeUploadedPhoto } from "../src/facePhoto";
import { settingsWire } from "../src/settings";
import { install, type Fakes } from "./fakeFirebase";
import { chooseUpload, uploadsByAccount } from "../scripts/face-slots";

const BUCKET = "fake-bucket";
const first = addressOf(BUCKET, "avatars/me/up1");
const second = addressOf(BUCKET, "avatars/me/up2");
const card = "https://image.tmdb.org/t/p/w500/a.jpg";

let fakes: Fakes;
beforeEach(() => {
  fakes = install();
  fakes.users.set("me", { uid: "me", providerData: [], photoURL: first });
});
afterEach(() => fakes.restore());

function seedShowing(face: string | null) {
  fakes.db.seed("publishedLists/l1", { authorUid: "me", authorPhotoUrl: face });
  fakes.db.seed("publishedLists/l2", { authorUid: "me", authorPhotoUrl: card });
  fakes.db.seed("publishedLists/theirs", { authorUid: "them", authorPhotoUrl: face });
  fakes.db.seed("rankings/x_me", { uid: "me", authorPhotoUrl: face });
  fakes.db.seed("rankings/l1_them", { uid: "them", listId: "l1", authorPhotoUrl: card, snapshot: { authorPhotoUrl: face, title: "Mine" } });
}

describe("the photo slot", () => {
  it("knows the address of its copy, whatever the token", () => {
    assert.equal(pointsAt(first, BUCKET, "avatars/me/up1"), true);
    assert.equal(pointsAt(`${first}&token=abc`, BUCKET, "avatars/me/up1"), true);
    assert.equal(pointsAt(addressOf(BUCKET, "avatars/me/up10"), BUCKET, "avatars/me/up1"), false);
    assert.equal(pointsAt(null, BUCKET, "avatars/me/up1"), false);
    assert.equal(readPhotoSlot({ pictureId: "../x", url: first, setAt: 1 }), null);
    assert.equal(readPhotoSlot(null), null);
  });

  it("keeps an upload, and is read with the settings", async () => {
    const slot = await keepUploadedPhoto("me", "up1", first, 1000);
    assert.deepEqual(slot, { pictureId: "up1", url: first, setAt: 1000 });
    const stored = fakes.db.get("accounts/me/settings/appearance") as Record<string, unknown>;
    assert.deepEqual(settingsWire(stored), { colour: null, photo: slot });
    assert.ok(!fakes.log.includes("deleteFile avatars/me/up1"));
  });

  it("stays while the letter or a card is worn: nothing but an upload or a removal touches it", async () => {
    await keepUploadedPhoto("me", "up1", first, 1000);
    fakes.users.get("me")!.photoURL = null;
    assert.deepEqual(readPhotoSlot((fakes.db.get("accounts/me/settings/appearance") as Record<string, unknown>).photo), { pictureId: "up1", url: first, setAt: 1000 });
  });

  it("a new upload replaces the old photo everywhere it was shown, then deletes it", async () => {
    await keepUploadedPhoto("me", "up1", first, 1000);
    seedShowing(first);
    await keepUploadedPhoto("me", "up2", second, 2000);
    assert.equal((fakes.db.get("publishedLists/l1") as Record<string, unknown>).authorPhotoUrl, second);
    assert.equal((fakes.db.get("publishedLists/l2") as Record<string, unknown>).authorPhotoUrl, card);
    assert.equal((fakes.db.get("publishedLists/theirs") as Record<string, unknown>).authorPhotoUrl, first);
    assert.equal((fakes.db.get("rankings/x_me") as Record<string, unknown>).authorPhotoUrl, second);
    const theirs = fakes.db.get("rankings/l1_them") as { authorPhotoUrl: string; snapshot: Record<string, unknown> };
    assert.equal(theirs.authorPhotoUrl, card);
    assert.deepEqual(theirs.snapshot, { authorPhotoUrl: second, title: "Mine" });
    assert.equal(fakes.users.get("me")!.photoURL, second);
    assert.ok(fakes.log.includes("deleteFile avatars/me/up1"));
  });

  it("the same upload again deletes nothing", async () => {
    await keepUploadedPhoto("me", "up1", first, 1000);
    await keepUploadedPhoto("me", "up1", first, 2000);
    assert.ok(!fakes.log.some((line) => line.startsWith("deleteFile")));
  });

  it("Remove your photo: the face showing it becomes the letter, the file goes, the slot is empty", async () => {
    await keepUploadedPhoto("me", "up1", first, 1000);
    seedShowing(first);
    assert.deepEqual(await removeUploadedPhoto("me"), { pictureId: "up1", url: first, setAt: 1000 });
    assert.equal((fakes.db.get("publishedLists/l1") as Record<string, unknown>).authorPhotoUrl, null);
    assert.equal((fakes.db.get("rankings/x_me") as Record<string, unknown>).authorPhotoUrl, null);
    assert.equal(fakes.users.get("me")!.photoURL, null);
    assert.ok(fakes.log.includes("deleteFile avatars/me/up1"));
    assert.deepEqual(settingsWire(fakes.db.get("accounts/me/settings/appearance") as Record<string, unknown>).photo, null);
    assert.equal(await removeUploadedPhoto("me"), null);
  });

  it("leaves a face that is not the photo alone when the photo goes", async () => {
    await keepUploadedPhoto("me", "up1", first, 1000);
    fakes.users.get("me")!.photoURL = card;
    await removeUploadedPhoto("me");
    assert.equal(fakes.users.get("me")!.photoURL, card);
  });
});

describe("filling the slots of accounts from before (npm run face-slots)", () => {
  const files = [
    { name: "avatars/me/up1", createdMs: 1000 },
    { name: "avatars/me/up2", createdMs: 3000 },
    { name: "avatars/me/w-0123456789abcdef0123456789abcdef", createdMs: 9000 },
    { name: "avatars/you/up9", createdMs: 2000 },
    { name: "avatars/me/deeper/x", createdMs: 5000 },
  ];

  it("counts only uploads, never copies of other pictures", () => {
    const byUid = uploadsByAccount(files);
    assert.deepEqual([...byUid.keys()].sort(), ["me", "you"]);
    assert.deepEqual(byUid.get("me")!.map((one) => one.pictureId), ["up1", "up2"]);
  });

  it("takes the upload worn, else the newest", () => {
    const mine = uploadsByAccount(files).get("me")!;
    assert.equal(chooseUpload(mine, first, BUCKET)!.pictureId, "up1");
    assert.equal(chooseUpload(mine, null, BUCKET)!.pictureId, "up2");
    assert.equal(chooseUpload(mine, card, BUCKET)!.pictureId, "up2");
  });
});
