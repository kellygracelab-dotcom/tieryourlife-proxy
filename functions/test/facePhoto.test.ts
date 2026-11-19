import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { addressOf } from "../src/publishedPictures";
import {
  finishRemoval,
  isPhotoUpload,
  keepUploadedPhoto,
  pointsAt,
  readPhotoSlot,
  removeUploadedPhoto,
  restoreUploadedPhoto,
  slotAfterFace,
  sweepRemovedPhotos,
  UNDO_WINDOW_MS,
} from "../src/facePhoto";
import { settingsWire } from "../src/settings";
import { install, type Fakes } from "./fakeFirebase";
import { chooseUpload, uploadsByAccount } from "../scripts/face-slots";

const NOW = 1_800_000_000_000;

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

  it("Remove your photo: the face showing it becomes the letter at once, the slot is empty, the file waits for Undo", async () => {
    await keepUploadedPhoto("me", "up1", first, 1000);
    seedShowing(first);
    assert.deepEqual(await removeUploadedPhoto("me", NOW), { pictureId: "up1", url: first, setAt: 1000, removedAt: NOW, wasWorn: true });
    assert.equal((fakes.db.get("publishedLists/l1") as Record<string, unknown>).authorPhotoUrl, null);
    assert.equal((fakes.db.get("rankings/x_me") as Record<string, unknown>).authorPhotoUrl, null);
    assert.equal(fakes.users.get("me")!.photoURL, null);
    assert.ok(!fakes.log.includes("deleteFile avatars/me/up1"));
    assert.deepEqual(settingsWire(fakes.db.get("accounts/me/settings/appearance") as Record<string, unknown>).photo, null);
    assert.equal(await removeUploadedPhoto("me", NOW + 1), null);
  });

  it("Undo puts it back in the slot while the copy is kept, saying it was worn", async () => {
    fakes.files.push("avatars/me/up1");
    await keepUploadedPhoto("me", "up1", first, 1000);
    await removeUploadedPhoto("me", NOW);
    assert.deepEqual(await restoreUploadedPhoto("me", NOW + 5000), { ok: true, photo: { pictureId: "up1", url: first, setAt: 1000 }, wasWorn: true });
    assert.deepEqual(readPhotoSlot((fakes.db.get("accounts/me/settings/appearance") as Record<string, unknown>).photo), { pictureId: "up1", url: first, setAt: 1000 });
    assert.deepEqual(await restoreUploadedPhoto("me", NOW + 6000), { ok: false, why: "taken", photo: { pictureId: "up1", url: first, setAt: 1000 } });
    assert.equal(await finishRemoval("me", (fakes.db.get("accounts/me/settings/appearance") as Record<string, unknown>).removedPhoto, NOW + UNDO_WINDOW_MS + 1), false);
    assert.ok(!fakes.log.includes("deleteFile avatars/me/up1"));
  });

  it("has nothing to put back once the window is over, or once a new photo came", async () => {
    fakes.files.push("avatars/me/up1");
    await keepUploadedPhoto("me", "up1", first, 1000);
    await removeUploadedPhoto("me", NOW);
    assert.deepEqual(await restoreUploadedPhoto("me", NOW + UNDO_WINDOW_MS + 1), { ok: false, why: "nothing", photo: null });
    await keepUploadedPhoto("me", "up2", second, NOW + 10);
    assert.deepEqual(await restoreUploadedPhoto("me", NOW + 20), { ok: false, why: "taken", photo: { pictureId: "up2", url: second, setAt: NOW + 10 } });
  });

  it("deletes the copy after the window, as read or by the daily sweep, and an earlier removal's at the next one", async () => {
    fakes.files.push("avatars/me/up1", "avatars/me/up2");
    await keepUploadedPhoto("me", "up1", first, 1000);
    await removeUploadedPhoto("me", NOW);
    assert.equal(await sweepRemovedPhotos(NOW + UNDO_WINDOW_MS), 0);
    assert.ok(!fakes.log.includes("deleteFile avatars/me/up1"));
    assert.equal(await sweepRemovedPhotos(NOW + UNDO_WINDOW_MS + 1), 1);
    assert.ok(fakes.log.includes("deleteFile avatars/me/up1"));
    assert.equal((fakes.db.get("accounts/me/settings/appearance") as Record<string, unknown>).removedPhoto, null);

    await keepUploadedPhoto("me", "up2", second, NOW + 10);
    await removeUploadedPhoto("me", NOW + 20);
    fakes.files.push("avatars/me/up3");
    await keepUploadedPhoto("me", "up3", addressOf(BUCKET, "avatars/me/up3"), NOW + 30);
    await removeUploadedPhoto("me", NOW + 40);
    assert.ok(fakes.log.includes("deleteFile avatars/me/up2"), "only the last removal waits for Undo");
    assert.ok(!fakes.log.includes("deleteFile avatars/me/up3"));
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

describe("POST /lists/face without ?upload=1 (a card's picture worn as a face)", () => {
  it("knows an upload only by the flag", () => {
    assert.equal(isPhotoUpload({ upload: "1" }), true);
    assert.equal(isPhotoUpload({ upload: "true" }), true);
    assert.equal(isPhotoUpload({ upload: ["1"] }), true);
    for (const query of [{}, { upload: "0" }, { upload: "" }, { upload: "yes" }, { photo: "1" }]) assert.equal(isPhotoUpload(query), false, JSON.stringify(query));
  });

  it("leaves the slot and the uploaded photo alone, as every client before sent it", async () => {
    fakes.files.push("avatars/me/up1", "avatars/me/card7");
    await keepUploadedPhoto("me", "up1", first, 1000);
    seedShowing(first);
    const before = structuredClone(fakes.db.get("accounts/me/settings/appearance"));
    assert.equal(await slotAfterFace("me", "card7", addressOf(BUCKET, "avatars/me/card7"), {}, NOW), null);
    assert.deepEqual(fakes.db.get("accounts/me/settings/appearance"), before);
    assert.ok(!fakes.log.some((line) => line.startsWith("deleteFile")), "no file deleted");
    assert.equal((fakes.db.get("publishedLists/l1") as Record<string, unknown>).authorPhotoUrl, first);
    assert.equal(fakes.users.get("me")!.photoURL, first);
  });

  it("with ?upload=1 the new photo takes the slot and the old one goes", async () => {
    await keepUploadedPhoto("me", "up1", first, 1000);
    assert.deepEqual(await slotAfterFace("me", "up2", second, { upload: "1" }, NOW), { pictureId: "up2", url: second, setAt: NOW });
    assert.ok(fakes.log.includes("deleteFile avatars/me/up1"));
  });
});
