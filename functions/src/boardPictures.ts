/**
 * Catalogue pictures on the boards an account keeps (`boards.ts`) are copied
 * once into one shared folder, `published/catalogue/`, named by the catalogue
 * address (`outsideName`), so a poster on a thousand boards is one file. The
 * same switches decide as for publications (`pictureCopies.ts`); a card keeps
 * its credit, the catalogue address in `attribution.originalUrl`.
 *
 * A board's revision and fingerprint stay the device's: a picture moving from
 * a catalogue to us is not an edit, and a fingerprint the device did not make
 * would read to it as a change made elsewhere (two boards where it has one).
 */
import { getStorage } from "firebase-admin/storage";
import { copyCataloguePictures, withCatalogueCopies } from "./cataloguePictures";
import { outsideName, type OutsideTools } from "./outsidePictures";
import type { PictureAttribution } from "./pictureAttribution";
import { addressOf } from "./publishedPictures";
import { MAX_BOARD_BYTES } from "./sync";

export const SHARED_COPIES = "published/catalogue/";

/** Room left under a board's limit after its pictures move to us, so the device can send it back as it is. */
export const BOARD_COPY_MARGIN_BYTES = 50_000;

type BoardCard = { imageUrl: string | null; attribution?: PictureAttribution };
interface BoardPictures {
  items: readonly BoardCard[];
  coverImageUrl: string | null;
  coverImageUrls: readonly string[];
}

/** [board] showing the copies in [copies] (catalogue address -> ours); the same object when none of them is on it. */
export function withBoardCopies<T extends BoardPictures>(board: T, copies: ReadonlyMap<string, string>): T {
  if (copies.size === 0) return board;
  const shown = withCatalogueCopies(
    { items: board.items as BoardCard[], coverImageUrl: board.coverImageUrl ?? null, previewImages: [...board.coverImageUrls] },
    copies,
  );
  return { ...board, items: shown.items, coverImageUrl: shown.coverImageUrl, coverImageUrls: shown.previewImages };
}

/** Whether a board with its pictures moved to us still leaves the margin under the board limit. */
export function fitsWithCopies(board: object): boolean {
  return Buffer.byteLength(JSON.stringify(board), "utf8") <= MAX_BOARD_BYTES - BOARD_COPY_MARGIN_BYTES;
}

/** Which of [copies] [after] shows where [before] showed the catalogue: what a device is told was moved. */
export function copiesShown(before: BoardPictures, after: BoardPictures, copies: ReadonlyMap<string, string>): Map<string, string> {
  const shown = new Map<string, string>();
  const look = (from: string | null | undefined, to: string | null | undefined) => {
    if (from && to && from !== to && copies.get(from) === to) shown.set(from, to);
  };
  before.items.forEach((item, at) => look(item.imageUrl, after.items[at]?.imageUrl));
  look(before.coverImageUrl, after.coverImageUrl);
  before.coverImageUrls.forEach((url, at) => look(url, after.coverImageUrls[at]));
  return shown;
}

/** The shared copies a stored board already shows, by the catalogue address each was made from. */
export function copiesOnBoard(items: unknown): Map<string, string> {
  const found = new Map<string, string>();
  if (!Array.isArray(items)) return found;
  for (const item of items as BoardCard[]) {
    const original = item?.attribution?.originalUrl;
    if (typeof original === "string" && typeof item.imageUrl === "string" && item.imageUrl.includes(`/o/${encodeURIComponent(SHARED_COPIES)}`)) {
      found.set(original, item.imageUrl);
    }
  }
  return found;
}

/**
 * Copies of [urls] in the shared folder: the ones there already, and as many
 * of the rest as the catalogues give within [withinMs]. Each name is looked
 * up on its own, as the folder is everybody's and only grows.
 */
export async function copyToShared(urls: readonly string[], tools: OutsideTools, withinMs: number): Promise<Map<string, string>> {
  if (urls.length === 0) return new Map();
  const bucket = getStorage().bucket();
  const there = await Promise.all(urls.map(async (url) => [url, (await bucket.file(SHARED_COPIES + outsideName(url)).exists())[0]] as const));
  const committed = new Map(there.filter(([, exists]) => exists).map(([url]) => [url, addressOf(tools.bucket, SHARED_COPIES + outsideName(url))]));
  const { copies } = await copyCataloguePictures(SHARED_COPIES, urls, { ...tools, namesIn: async () => new Set<string>() }, { committed, withinMs });
  return copies;
}
