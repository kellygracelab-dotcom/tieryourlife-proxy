import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergePages, type Ranked } from "../src/follows";
import {
  answerFor,
  APPROVED_EDIT_FIELDS,
  base36Of,
  BUILT_IN_SECTION_IDS,
  BUILT_IN_SECTIONS,
  builtInRecord,
  checkName,
  cleanSectionName,
  collageImage,
  countWithout,
  decideDeletion,
  decideOrder,
  decideProposal,
  decideProposalQuota,
  decideSectionAction,
  decideSectionChoice,
  decideWithdrawal,
  DEFAULT_ICON,
  findClash,
  followedSectionRun,
  isSectionId,
  liveTopics,
  MAX_PENDING_SECTIONS_PER_ACCOUNT,
  MAX_PROPOSALS_PER_DAY,
  MAX_SECTION_NAME_LENGTH,
  mayCall,
  nameKey,
  NEUTRAL_COLOURS,
  notYetEditable,
  PENDING_EDIT_FIELDS,
  newSection,
  noStats,
  orderSections,
  ownProposals,
  pickCollage,
  pickSectionId,
  proposalAfterErasure,
  PROPOSAL_WINDOW_MS,
  readNames,
  recentProposals,
  releasedNames,
  reservationClash,
  readSectionEdits,
  SECTION_CALLS,
  SECTION_ICONS,
  SECTION_LOCALES,
  sectionFollowId,
  sectionsListedFor,
  sectionView,
  slugOf,
  TimedCache,
  visibleText,
  type CollageCandidate,
  type SectionRecord,
} from "../src/sections";

function list(some: Partial<CollageCandidate> & { id: string }): CollageCandidate {
  return {
    rankingCount: 9,
    underReview: false,
    coverImageUrl: `https://img.test/${some.id}.jpg`,
    previewImages: [],
    ...some,
  };
}

/** An approved user section unless told otherwise. */
function section(some: Partial<SectionRecord> & { id: string }): SectionRecord {
  return { ...newSection(some.id, some.name ?? some.id, 1000), status: "approved", approvedAtMs: 1000, ...some };
}

const builtIns = () => BUILT_IN_SECTIONS.map(builtInRecord);

describe("the built-in sections", () => {
  it("are the nine the app shipped with, in its order", () => {
    assert.deepEqual(BUILT_IN_SECTION_IDS, ["anime", "film_tv", "games", "music", "books", "food", "sport", "people", "other"]);
  });

  it("carry the app's own label in every locale, English as the name", () => {
    for (const builtIn of BUILT_IN_SECTIONS) {
      assert.deepEqual(Object.keys(builtIn.names), [...SECTION_LOCALES], builtIn.id);
      assert.equal(builtIn.names.en, builtIn.name);
    }
    const film = BUILT_IN_SECTIONS.find((one) => one.id === "film_tv");
    assert.equal(film?.name, "Film & TV");
    assert.equal(film?.names.uk, "Кіно і серіали");
  });

  it("wear their own icons", () => {
    const icons = Object.fromEntries(BUILT_IN_SECTIONS.map((one) => [one.id, one.icon]));
    assert.deepEqual(icons, {
      anime: "animation",
      film_tv: "movie",
      games: "sports_esports",
      music: "music_note",
      books: "menu_book",
      food: "restaurant",
      sport: "sports_soccer",
      people: "person",
      other: "category",
    });
  });

  it("are approved since the start, never hidden, and drawn in the stored colours", () => {
    const food = builtInRecord(BUILT_IN_SECTIONS[5]);
    assert.equal(food.status, "approved");
    assert.equal(food.builtIn, true);
    assert.equal(food.hidden, false);
    assert.equal(food.approvedAtMs, 0);
    assert.equal(food.picture, null);
    assert.deepEqual(food.tint, { light: "#9A5638", dark: "#794732" });
    assert.deepEqual(food.topicIcon, { light: "#9A5638", dark: "#FBAF8F" });
  });

  it("lend Other's colours to a section that has no picture yet", () => {
    assert.deepEqual(newSection("x1", "X", 0).tint, { light: "#55566A", dark: "#454656" });
    assert.deepEqual(NEUTRAL_COLOURS, BUILT_IN_SECTIONS[8].colours);
  });
});

describe("SECTION_ICONS", () => {
  it("are the twenty-four offered, the built-ins' own first", () => {
    assert.deepEqual(SECTION_ICONS, [
      "category", "movie", "animation", "sports_esports", "music_note", "menu_book", "restaurant", "sports_soccer", "person",
      "pets", "flight", "directions_car", "palette", "checkroom", "science", "computer", "local_cafe", "park",
      "theater_comedy", "mic", "photo_camera", "sports_basketball", "celebration", "star",
    ]);
    assert.equal(DEFAULT_ICON, "category");
  });
});

describe("isSectionId", () => {
  it("takes the built-ins, slugs and random ids", () => {
    for (const id of ["food", "film_tv", "street-food", "s-0a1b2c3d", "2024"]) assert.equal(isSectionId(id), true, id);
  });

  it("refuses anything that could not address a section", () => {
    for (const id of ["Food", "", "a", "-food", "street food", "../other", "x".repeat(41), undefined, ["food"]]) {
      assert.equal(isSectionId(id), false, String(id));
    }
  });
});

describe("cleanSectionName", () => {
  it("collapses the spaces and trims", () => {
    assert.equal(cleanSectionName("  Street    food "), "Street food");
  });

  it("is two to twenty-four characters, counting an emoji as one", () => {
    assert.equal(cleanSectionName("S"), null);
    assert.equal(cleanSectionName("S".repeat(MAX_SECTION_NAME_LENGTH + 1)), null);
    assert.equal(cleanSectionName(`${"S".repeat(MAX_SECTION_NAME_LENGTH - 1)}🍜`), `${"S".repeat(MAX_SECTION_NAME_LENGTH - 1)}🍜`);
  });

  it("wants a letter or a digit somewhere, in any script", () => {
    assert.equal(cleanSectionName("!!"), null);
    assert.equal(cleanSectionName("Вулична їжа"), "Вулична їжа");
    assert.equal(cleanSectionName(42), null);
  });
});

describe("visible text", () => {
  it("takes out format characters and folds compatibility forms", () => {
    assert.equal(visibleText("Str\u200Beet\u200C \u200Dfo\uFEFFod\u2060"), "Street food");
    assert.equal(visibleText("ｆｏｏｄ"), "food");
  });

  it("cannot be used to make a name that looks taken into a new one", () => {
    const food = builtInRecord(BUILT_IN_SECTIONS[5]);
    assert.equal(cleanSectionName("Fo\u200Bod"), "Food");
    assert.equal(nameKey("F\u200Dood\uFEFF"), nameKey("Food"));
    assert.equal(findClash(["ＦＯＯＤ"], [food], null), "food");
    assert.equal(findClash(["F\u2060ood"], [food], null), "food");
  });

  it("counts only what can be seen towards a name's length", () => {
    assert.equal(cleanSectionName("A\u200B\u200B\u200B"), null);
  });

  it("slugs what can be seen", () => {
    assert.equal(slugOf("Street\u200B food"), "street-food");
    assert.equal(slugOf("Ｓｔｒｅｅｔ ｆｏｏｄ"), "street-food");
  });
});

describe("nameKey and findClash", () => {
  const food = builtInRecord(BUILT_IN_SECTIONS[5]);

  it("compares without case or accents", () => {
    assert.equal(nameKey("  Café  CRÈME "), "cafe creme");
  });

  it("finds a section going by the name in any language", () => {
    assert.equal(findClash(["FOOD"], [food], null), "food");
    assert.equal(findClash(["еда"], [food], null), "food");
    assert.equal(findClash(["Street food"], [food], null), null);
  });

  it("counts approved and waiting sections, not declined or merged ones", () => {
    const waiting = section({ id: "ramen", name: "Ramen", status: "pending" });
    const declined = section({ id: "noodles", name: "Noodles", status: "declined" });
    const merged = section({ id: "snacks", name: "Snacks", status: "merged", mergedInto: "food" });
    const all = [waiting, declined, merged];
    assert.equal(findClash(["ramen"], all, null), "ramen");
    assert.equal(findClash(["noodles"], all, null), null);
    assert.equal(findClash(["snacks"], all, null), null);
  });

  it("never finds the section itself", () => {
    assert.equal(findClash(["Food"], [food], "food"), null);
  });
});

describe("readNames", () => {
  it("keeps the app's locales and drops an empty translation", () => {
    assert.deepEqual(readNames({ uk: " Вулична  їжа ", "pt-BR": "Comida de rua", de: "" }), {
      uk: "Вулична їжа",
      "pt-BR": "Comida de rua",
    });
  });

  it("refuses an unknown locale, a bad name or something that is not a map", () => {
    assert.equal(readNames({ xx: "Street food" }), null);
    assert.equal(readNames({ uk: "!" }), null);
    assert.equal(readNames(["uk"]), null);
    assert.equal(readNames("uk"), null);
  });
});

describe("slugOf", () => {
  it("is the ASCII of the name, lower-cased and hyphenated", () => {
    assert.equal(slugOf("Street food"), "street-food");
    assert.equal(slugOf("Café Crème & Co."), "cafe-creme-co");
  });

  it("gives nothing for a name in a script that leaves too little", () => {
    assert.equal(slugOf("Вулична їжа"), null);
    assert.equal(slugOf("ラーメン"), null);
    assert.equal(slugOf("Кіно 2"), null);
  });

  it("stops at forty characters, never on a hyphen", () => {
    const slug = slugOf(`${"a".repeat(39)} b`);
    assert.equal(slug, "a".repeat(39));
  });
});

describe("pickSectionId", () => {
  const random = () => "k3j9x0aa";

  it("is the slug when it is free", () => {
    assert.equal(pickSectionId("Street food", new Set(), random), "street-food");
  });

  it("adds -2, -3 on a clash", () => {
    assert.equal(pickSectionId("Street food", new Set(["street-food"]), random), "street-food-2");
    assert.equal(pickSectionId("Street food", new Set(["street-food", "street-food-2"]), random), "street-food-3");
  });

  it("never takes a word the paths use", () => {
    assert.equal(pickSectionId("Queue", new Set(), random), "queue-2");
    assert.equal(pickSectionId("Proposals", new Set(), random), "proposals-2");
    assert.equal(pickSectionId("Order", new Set(), random), "order-2");
    assert.equal(pickSectionId("Name check", new Set(), random), "name-check-2");
  });

  it("is s- and random characters when the name gives no slug, tried again on a clash", () => {
    const draws = ["aaaaaaaa", "bbbbbbbb"];
    assert.equal(pickSectionId("Вулична їжа", new Set(["s-aaaaaaaa"]), () => draws.shift() ?? ""), "s-bbbbbbbb");
  });

  it("keeps a numbered id within forty characters", () => {
    const long = "a".repeat(40);
    const id = pickSectionId(long, new Set([long]), random);
    assert.equal(id, `${"a".repeat(38)}-2`);
    assert.equal(isSectionId(id), true);
  });

  it("draws eight base36 characters from random bytes", () => {
    assert.equal(base36Of(Uint8Array.from([0, 1, 10, 35, 36, 71, 255, 200, 9])), "01az0z3k");
  });
});

describe("decideProposal", () => {
  const sections = [
    ...builtIns(),
    section({ id: "secret", name: "Secret", hidden: true }),
    section({ id: "ramen", name: "Ramen", status: "pending", proposerUid: "somebody" }),
  ];
  const body = (some: Record<string, unknown> = {}) => ({
    name: "Street food",
    icon: "local_cafe",
    pictureId: "pic_1",
    fileUnder: "food",
    ...some,
  });
  const propose = (some: Record<string, unknown> = {}, among: SectionRecord[] = sections) =>
    decideProposal({ body: body(some), callerUid: "me", sections: among });

  it("takes a proposal", () => {
    assert.deepEqual(propose(), { ok: true, name: "Street food", icon: "local_cafe", fileUnder: "food", pictureId: "pic_1" });
  });

  it("gives a proposal without an icon the default one", () => {
    assert.equal(propose({ icon: undefined }).ok && (propose({ icon: undefined }) as { icon: string }).icon, DEFAULT_ICON);
  });

  it("refuses a name that is not one", () => {
    assert.deepEqual(propose({ name: "x" }), { ok: false, code: "BAD_NAME" });
  });

  it("refuses a name another section goes by, saying which", () => {
    assert.deepEqual(propose({ name: "Comida" }), { ok: false, code: "NAME_TAKEN", id: "food" });
    assert.deepEqual(propose({ name: "RAMEN" }), { ok: false, code: "NAME_TAKEN", id: "ramen" });
  });

  it("refuses an icon that is not offered", () => {
    assert.deepEqual(propose({ icon: "ramen_dining" }), { ok: false, code: "BAD_ICON" });
  });

  it("files the lists only under an open section", () => {
    assert.deepEqual(propose({ fileUnder: "secret" }), { ok: false, code: "BAD_FILE_UNDER" });
    assert.deepEqual(propose({ fileUnder: "ramen" }), { ok: false, code: "BAD_FILE_UNDER" });
    assert.deepEqual(propose({ fileUnder: undefined }), { ok: false, code: "BAD_FILE_UNDER" });
    assert.equal(propose({ fileUnder: "other" }).ok, true);
  });

  it("wants a picture", () => {
    assert.deepEqual(propose({ pictureId: undefined }), { ok: false, code: "BAD_PICTURE", why: "missing" });
    assert.deepEqual(propose({ pictureId: "../x" }), { ok: false, code: "BAD_PICTURE", why: "missing" });
  });

  it("allows three of one account's proposals waiting at once", () => {
    const mine = (n: number, status: SectionRecord["status"] = "pending") =>
      Array.from({ length: n }, (_, at) => section({ id: `mine-${at}`, name: `Mine ${at}`, status, proposerUid: "me" }));
    assert.equal(propose({}, [...sections, ...mine(MAX_PENDING_SECTIONS_PER_ACCOUNT - 1)]).ok, true);
    assert.deepEqual(propose({}, [...sections, ...mine(MAX_PENDING_SECTIONS_PER_ACCOUNT)]), { ok: false, code: "TOO_MANY_PENDING" });
    assert.equal(propose({}, [...sections, ...mine(5, "declined")]).ok, true);
  });
});

describe("recentProposals and decideProposalQuota", () => {
  const now = 10 * PROPOSAL_WINDOW_MS;

  it("keeps the proposals of the last day, and only times", () => {
    assert.deepEqual(recentProposals([now - PROPOSAL_WINDOW_MS, now - PROPOSAL_WINDOW_MS + 1, now, "x", null], now), [
      now - PROPOSAL_WINDOW_MS + 1,
      now,
    ]);
    assert.deepEqual(recentProposals(undefined, now), []);
  });

  it("allows three waiting and ten a day, however they ended", () => {
    const day = (n: number) => Array.from({ length: n }, (_, at) => now - at);
    assert.equal(decideProposalQuota(MAX_PENDING_SECTIONS_PER_ACCOUNT - 1, day(MAX_PROPOSALS_PER_DAY - 1)), null);
    assert.equal(decideProposalQuota(MAX_PENDING_SECTIONS_PER_ACCOUNT, day(0)), "TOO_MANY_PENDING");
    assert.equal(decideProposalQuota(0, day(MAX_PROPOSALS_PER_DAY)), "TOO_MANY_PROPOSALS");
  });
});

describe("reservationClash", () => {
  const ramen = section({ id: "ramen", name: "Ramen", status: "pending" });
  const holders = new Map([
    ["ramen", ramen],
    ["gone", section({ id: "gone", name: "Noodles", status: "declined" })],
    ["renamed", section({ id: "renamed", name: "Soba now" })],
  ]);
  const reservations = [
    { key: "ramen", sectionId: "ramen" },
    { key: "noodles", sectionId: "gone" },
    { key: "soba", sectionId: "renamed" },
    { key: "udon", sectionId: "deleted" },
  ];

  it("finds the waiting or approved section that holds the name", () => {
    assert.equal(reservationClash(["RAMEN"], reservations, holders, null), "ramen");
  });

  it("lets a name go once its holder was declined, renamed away or deleted", () => {
    assert.equal(reservationClash(["Noodles"], reservations, holders, null), null);
    assert.equal(reservationClash(["Soba"], reservations, holders, null), null);
    assert.equal(reservationClash(["Udon"], reservations, holders, null), null);
  });

  it("never counts a section's own reservation against it", () => {
    assert.equal(reservationClash(["Ramen"], reservations, holders, "ramen"), null);
  });
});

describe("readSectionEdits", () => {
  it("reads only what this call may change", () => {
    const read = readSectionEdits({ name: "Street food", rank: 2, hidden: true }, ["name"]);
    assert.deepEqual(read, { ok: true, edits: { name: "Street food" } });
  });

  it("reads a rank, a pin taken away, and hidden", () => {
    assert.deepEqual(readSectionEdits({ rank: 0 }, ["rank"]), { ok: true, edits: { rank: 0 } });
    assert.deepEqual(readSectionEdits({ rank: null }, ["rank"]), { ok: true, edits: { rank: null } });
    assert.deepEqual(readSectionEdits({ hidden: false }, ["hidden"]), { ok: true, edits: { hidden: false } });
  });

  it("refuses what is not one", () => {
    assert.deepEqual(readSectionEdits({ name: "!" }, ["name"]), { ok: false, code: "BAD_NAME" });
    assert.deepEqual(readSectionEdits({ names: { xx: "Food" } }, ["names"]), { ok: false, code: "BAD_NAME" });
    assert.deepEqual(readSectionEdits({ icon: "rocket" }, ["icon"]), { ok: false, code: "BAD_ICON" });
    assert.equal(readSectionEdits({ rank: 1.5 }, ["rank"]).ok, false);
    assert.equal(readSectionEdits({ hidden: "yes" }, ["hidden"]).ok, false);
    assert.deepEqual(readSectionEdits({ pictureId: "../x" }, ["pictureId"]), { ok: false, code: "BAD_PICTURE", why: "missing" });
  });

  it("reads a chosen tint as one hex colour, and refuses anything else", () => {
    assert.deepEqual(readSectionEdits({ tint: "#7a4a33" }, ["tint"]), { ok: true, edits: { tint: "#7A4A33" } });
    assert.equal(readSectionEdits({ tint: { light: "#7a4a33", dark: "#5f3d2d" } }, ["tint"]).ok, false);
    assert.equal(readSectionEdits({ tint: "7a4a33" }, ["tint"]).ok, false);
  });
});

describe("decideSectionAction", () => {
  const pending = section({ id: "street-food", status: "pending", fileUnder: "food", proposerUid: "me" });
  const approved = section({ id: "ramen" });
  const food = builtInRecord(BUILT_IN_SECTIONS[5]);

  it("approving moves the waiting lists in", () => {
    assert.deepEqual(decideSectionAction("approve", pending, null), {
      ok: true,
      resume: false,
      status: "approved",
      mergedInto: null,
      waiting: { category: "street-food", proposedSection: null },
      filed: null,
    });
  });

  it("declining leaves the lists where they were filed, no longer waiting", () => {
    assert.deepEqual(decideSectionAction("decline", pending, null), {
      ok: true,
      resume: false,
      status: "declined",
      mergedInto: null,
      waiting: { proposedSection: null },
      filed: null,
    });
  });

  it("approves and declines only what is still waiting", () => {
    assert.deepEqual(decideSectionAction("approve", approved, null), { ok: false, reason: "settled" });
    assert.deepEqual(decideSectionAction("decline", approved, null), { ok: false, reason: "settled" });
  });

  it("merging moves the filed and the waiting lists to the target", () => {
    assert.deepEqual(decideSectionAction("merge", approved, food), {
      ok: true,
      resume: false,
      status: "merged",
      mergedInto: "food",
      waiting: { category: "food", proposedSection: null },
      filed: { category: "food" },
    });
    assert.equal(decideSectionAction("merge", pending, food).ok, true);
  });

  it("merges only into another approved section", () => {
    assert.deepEqual(decideSectionAction("merge", approved, null), { ok: false, reason: "no_target" });
    assert.deepEqual(decideSectionAction("merge", approved, approved), { ok: false, reason: "itself" });
    assert.deepEqual(decideSectionAction("merge", approved, pending), { ok: false, reason: "target_not_approved" });
    const declined = section({ id: "gone", status: "declined" });
    assert.deepEqual(decideSectionAction("merge", declined, food), { ok: false, reason: "settled" });
  });

  it("finishes a decision left half done when the same word comes again", () => {
    const approving = section({ id: "street-food", status: "approved", unfinished: true });
    assert.deepEqual(decideSectionAction("approve", approving, null), {
      ok: true,
      resume: true,
      status: "approved",
      mergedInto: null,
      waiting: { category: "street-food", proposedSection: null },
      filed: null,
    });
    const merging = section({ id: "ramen", status: "merged", mergedInto: "food", unfinished: true });
    assert.deepEqual(decideSectionAction("merge", merging, food), {
      ok: true,
      resume: true,
      status: "merged",
      mergedInto: "food",
      waiting: { category: "food", proposedSection: null },
      filed: { category: "food" },
    });
  });

  it("tells any other word on a decided section, finished or not, that it is too late", () => {
    const approving = section({ id: "street-food", status: "approved", unfinished: true });
    assert.deepEqual(decideSectionAction("decline", approving, null), { ok: false, reason: "settled" });
    assert.deepEqual(decideSectionAction("approve", section({ id: "done" }), null), { ok: false, reason: "settled" });
    const merging = section({ id: "ramen", status: "merged", mergedInto: "food", unfinished: true });
    assert.deepEqual(decideSectionAction("merge", merging, approved), { ok: false, reason: "settled" });
    const withdrawn = section({ id: "gone", status: "declined", unfinished: true });
    assert.deepEqual(decideSectionAction("approve", withdrawn, null), { ok: false, reason: "settled" });
  });

  it("never declines or merges a built-in away", () => {
    assert.deepEqual(decideSectionAction("merge", food, approved), { ok: false, reason: "built_in" });
    assert.deepEqual(decideSectionAction("decline", food, null), { ok: false, reason: "built_in" });
  });
});

describe("decideSectionChoice", () => {
  const known = new Map(
    [
      ...builtIns(),
      section({ id: "ramen" }),
      section({ id: "secret", hidden: true }),
      section({ id: "street-food", status: "pending", fileUnder: "food", proposerUid: "me" }),
      section({ id: "hidden-holder", status: "pending", fileUnder: "secret", proposerUid: "me" }),
      section({ id: "theirs", status: "pending", fileUnder: "food", proposerUid: "somebody" }),
      section({ id: "noodles", status: "merged", mergedInto: "ramen" }),
      section({ id: "into-hidden", status: "merged", mergedInto: "secret" }),
      section({ id: "nope", status: "declined", proposerUid: "me" }),
      section({ id: "declined-mine", status: "declined", fileUnder: "food", proposerUid: "me" }),
      section({ id: "withdrawn-mine", status: "declined", fileUnder: "games", proposerUid: "me", withdrawn: true, dismissed: true }),
      section({ id: "declined-hidden-holder", status: "declined", fileUnder: "secret", proposerUid: "me" }),
      section({ id: "declined-theirs", status: "declined", fileUnder: "food", proposerUid: "somebody" }),
      section({ id: "merged-mine", status: "merged", mergedInto: "ramen", fileUnder: "food", proposerUid: "me" }),
    ].map((one) => [one.id, one]),
  );
  const choose = (id: string) => decideSectionChoice(id, known, "me");

  it("files a list under an approved section", () => {
    assert.deepEqual(choose("ramen"), { ok: true, category: "ramen", proposedSection: null });
    assert.deepEqual(choose("film_tv"), { ok: true, category: "film_tv", proposedSection: null });
  });

  it("holds a list for the author's own proposal where the proposal is filed", () => {
    assert.deepEqual(choose("street-food"), { ok: true, category: "food", proposedSection: "street-food" });
  });

  it("holds it under Other when the proposal's own place has since been hidden", () => {
    assert.deepEqual(choose("hidden-holder"), { ok: true, category: "other", proposedSection: "hidden-holder" });
  });

  it("follows a merged id to where it went", () => {
    assert.deepEqual(choose("noodles"), { ok: true, category: "ramen", proposedSection: null });
  });

  it("lets a republished list keep its own section once that is hidden, and nobody else choose it", () => {
    assert.deepEqual(decideSectionChoice("secret", known, "me", "secret"), { ok: true, category: "secret", proposedSection: null });
    assert.deepEqual(decideSectionChoice("secret", known, "me", "ramen"), { ok: false });
  });

  it("refuses a hidden section, somebody else's proposal, waiting or declined, and an unknown id", () => {
    for (const id of ["secret", "theirs", "declined-theirs", "into-hidden", "cooking"]) assert.deepEqual(choose(id), { ok: false }, id);
  });

  // A board on the proposer's phone still names the proposal after it was turned down.
  it("files a list for the author's own declined proposal where the proposal was filed, waiting for nothing", () => {
    assert.deepEqual(choose("declined-mine"), { ok: true, category: "food", proposedSection: null });
  });

  it("does the same for a proposal the author withdrew", () => {
    assert.deepEqual(choose("withdrawn-mine"), { ok: true, category: "games", proposedSection: null });
  });

  it("files it under Other when the declined proposal had nowhere open to file it", () => {
    assert.deepEqual(choose("nope"), { ok: true, category: "other", proposedSection: null });
    assert.deepEqual(choose("declined-hidden-holder"), { ok: true, category: "other", proposedSection: null });
  });

  it("follows the author's own merged proposal to where it went, not to where it was filed", () => {
    assert.deepEqual(choose("merged-mine"), { ok: true, category: "ramen", proposedSection: null });
  });
});

describe("orderSections", () => {
  const nothing = () => 0;
  const ids = (sections: SectionRecord[]) => sections.map((one) => one.id);

  it("keeps the built-ins in their old order when nothing tells them apart", () => {
    assert.deepEqual(ids(orderSections(builtIns().reverse(), new Set(), nothing)), [...BUILT_IN_SECTION_IDS]);
  });

  it("puts followed sections first, then pinned ones by rank, then the busiest", () => {
    const sections = [
      ...builtIns(),
      section({ id: "pinned-2", rank: 2 }),
      section({ id: "pinned-1", rank: 1 }),
      section({ id: "busy" }),
    ];
    const activity = (id: string) => ({ busy: 50, games: 10 })[id as "busy" | "games"] ?? 0;
    assert.deepEqual(ids(orderSections(sections, new Set(["music", "pinned-2"]), activity)), [
      "pinned-2",
      "music",
      "pinned-1",
      "busy",
      "games",
      "anime",
      "film_tv",
      "books",
      "food",
      "sport",
      "people",
      "other",
    ]);
  });

  it("breaks a tie by who was approved first, built-ins before everything", () => {
    const sections = [section({ id: "late", approvedAtMs: 9000 }), section({ id: "early", approvedAtMs: 5000 }), builtInRecord(BUILT_IN_SECTIONS[0])];
    assert.deepEqual(ids(orderSections(sections, new Set(), nothing)), ["anime", "early", "late"]);
  });

  it("puts Other last even when it is followed, pinned and busiest", () => {
    const other = { ...builtInRecord(BUILT_IN_SECTIONS[8]), rank: 0 };
    const sections = [other, section({ id: "ramen" })];
    assert.deepEqual(ids(orderSections(sections, new Set(["other"]), (id) => (id === "other" ? 99 : 0))), ["ramen", "other"]);
  });
});

describe("decideOrder", () => {
  const sections = [
    ...builtIns(),
    section({ id: "ramen", rank: 4 }),
    section({ id: "secret", hidden: true }),
    section({ id: "waiting", status: "pending" }),
  ];

  it("ranks the listed sections by place, unpins the rest and hides exactly what is listed hidden", () => {
    assert.deepEqual(decideOrder({ ids: ["food", "secret"], hidden: ["games"] }, sections), {
      ok: true,
      changes: [
        { id: "games", fields: { hidden: true } },
        { id: "food", fields: { rank: 0 } },
        { id: "ramen", fields: { rank: null } },
        { id: "secret", fields: { rank: 1, hidden: false } },
      ],
    });
  });

  it("unpins and shows everything for two empty lists, writing only what changes", () => {
    assert.deepEqual(decideOrder({ ids: [], hidden: [] }, sections), {
      ok: true,
      changes: [
        { id: "ramen", fields: { rank: null } },
        { id: "secret", fields: { hidden: false } },
      ],
    });
  });

  it("wants each id once, each an approved section", () => {
    assert.deepEqual(decideOrder({ ids: ["food", "food"] }, sections), { ok: false });
    assert.deepEqual(decideOrder({ ids: ["cooking"] }, sections), { ok: false });
    assert.deepEqual(decideOrder({ ids: ["waiting"] }, sections), { ok: false });
    assert.deepEqual(decideOrder({ ids: "food" }, sections), { ok: false });
    assert.deepEqual(decideOrder({ ids: [7] }, sections), { ok: false });
    assert.deepEqual(decideOrder({ ids: [], hidden: ["secret", "secret"] }, sections), { ok: false });
    assert.deepEqual(decideOrder({ ids: [], hidden: ["waiting"] }, sections), { ok: false });
  });

  it("never hides Other: lists fall back to it", () => {
    assert.deepEqual(decideOrder({ ids: [], hidden: ["other"] }, sections), { ok: false });
  });
});

describe("liveTopics", () => {
  it("counts the approved and waiting topics, not the rejected or merged ones", () => {
    assert.equal(liveTopics(["approved", "pending", "rejected", "merged", undefined]), 2);
  });
});

describe("decideDeletion", () => {
  it("removes a section nothing is in", () => {
    assert.deepEqual(decideDeletion(section({ id: "ramen" }), { lists: 0, topics: 0 }), { ok: true });
  });

  it("keeps a section lists or topics are still in", () => {
    assert.deepEqual(decideDeletion(section({ id: "ramen" }), { lists: 1, topics: 0 }), { ok: false, reason: "not_empty" });
    assert.deepEqual(decideDeletion(section({ id: "ramen" }), { lists: 0, topics: 2 }), { ok: false, reason: "not_empty" });
  });

  it("never removes a built-in, empty or not", () => {
    assert.deepEqual(decideDeletion(builtInRecord(BUILT_IN_SECTIONS[0]), { lists: 0, topics: 0 }), { ok: false, reason: "built_in" });
  });
});

describe("checkName", () => {
  const sections = [...builtIns(), section({ id: "ramen", name: "Ramen", status: "pending" })];

  it("says a name nobody has is free", () => {
    assert.deepEqual(checkName("Street food", sections), { free: true });
  });

  it("names the section that has it, the way a proposal is compared", () => {
    assert.deepEqual(checkName("  ÉDA ", [...sections, section({ id: "eda", name: "Eda" })]), { free: false, id: "eda" });
    assert.deepEqual(checkName("Еда", sections), { free: false, id: "food" });
    assert.deepEqual(checkName("ramen", sections), { free: false, id: "ramen" });
  });

  it("says when what was typed is not a name at all", () => {
    assert.deepEqual(checkName("x", sections), { free: false, code: "BAD_NAME" });
    assert.deepEqual(checkName(undefined, sections), { free: false, code: "BAD_NAME" });
  });
});

describe("mayCall", () => {
  it("lets the owner do everything", () => {
    for (const call of Object.keys(SECTION_CALLS) as (keyof typeof SECTION_CALLS)[]) assert.equal(mayCall("owner", call), true, call);
  });

  it("lets a moderator decide proposals and name topics, and nothing that reshapes the sections", () => {
    for (const call of ["queue", "approve", "decline", "createTopic"] as const) assert.equal(mayCall("moderator", call), true, call);
    for (const call of ["merge", "edit", "order", "delete", "create"] as const) assert.equal(mayCall("moderator", call), false, call);
  });

  it("lets nobody else do any of it", () => {
    for (const call of Object.keys(SECTION_CALLS) as (keyof typeof SECTION_CALLS)[]) assert.equal(mayCall(null, call), false, call);
  });
});

describe("decideWithdrawal", () => {
  it("takes back a waiting proposal and puts away a declined or merged one's notice", () => {
    assert.equal(decideWithdrawal(section({ id: "a", status: "pending", proposerUid: "me" }), "me"), "withdraw");
    assert.equal(decideWithdrawal(section({ id: "a", status: "declined", proposerUid: "me" }), "me"), "dismiss");
    assert.equal(decideWithdrawal(section({ id: "a", status: "merged", mergedInto: "food", proposerUid: "me" }), "me"), "dismiss");
  });

  it("is too late for an approved one", () => {
    assert.equal(decideWithdrawal(section({ id: "a", proposerUid: "me" }), "me"), "settled");
  });

  it("finds nothing of anybody else's, of a built-in, or of a section that is gone", () => {
    assert.equal(decideWithdrawal(section({ id: "a", status: "pending", proposerUid: "somebody" }), "me"), "missing");
    assert.equal(decideWithdrawal(builtInRecord(BUILT_IN_SECTIONS[0]), "me"), "missing");
    assert.equal(decideWithdrawal(null, "me"), "missing");
  });
});

describe("answerFor", () => {
  const stranger = { uid: "somebody", moderator: false };
  const proposer = { uid: "me", moderator: false };
  const staff = { uid: "mod", moderator: true };
  const waiting = section({ id: "a", status: "pending", proposerUid: "me", approvedAtMs: null });
  const mergedWaiting = section({ id: "b", status: "merged", mergedInto: "food", proposerUid: "me", approvedAtMs: null });
  const mergedApproved = section({ id: "c", status: "merged", mergedInto: "food", proposerUid: "me", approvedAtMs: 5 });

  it("shows an approved section to everybody", () => {
    assert.equal(answerFor(section({ id: "ramen" }), stranger), "view");
  });

  it("shows a proposal only to its proposer and the moderators", () => {
    assert.equal(answerFor(waiting, stranger), "missing");
    assert.equal(answerFor(waiting, proposer), "view");
    assert.equal(answerFor(waiting, staff), "view");
  });

  it("points everybody on from a section merged after it was approved", () => {
    assert.equal(answerFor(mergedApproved, stranger), "merged");
  });

  it("keeps a proposal merged before approval its proposer's and the moderators'", () => {
    assert.equal(answerFor(mergedWaiting, stranger), "missing");
    assert.equal(answerFor(mergedWaiting, proposer), "merged");
    assert.equal(answerFor(mergedWaiting, staff), "merged");
  });

  it("finds nothing where there is nothing", () => {
    assert.equal(answerFor(null, staff), "missing");
  });
});

describe("sectionView", () => {
  const stats = { ...noStats("street-food"), listCount: 41, lists30d: 12, newThisWeek: 3, followerCount: 9, collage: [] };
  const pending = section({
    id: "street-food",
    name: "Street food",
    status: "pending",
    fileUnder: "food",
    proposerUid: "me",
    proposerName: "Me",
    proposalPicture: "proposals/street-food/pic_1",
    proposalPictureUrl: "https://firebasestorage.googleapis.com/x?alt=media&token=t",
    approvedAtMs: null,
  });
  const stranger = { uid: "somebody", moderator: false };

  it("tells everybody the common fields of an approved section and nothing about who proposed it", () => {
    const approved = { ...pending, status: "approved" as const, picture: { url: "https://pic", width: 1600, height: 1000 }, approvedAtMs: 7 };
    const view = sectionView(approved, stranger, stats, true);
    assert.equal(view.pictureUrl, "https://pic");
    assert.equal(view.listCount, 41);
    assert.equal(view.following, true);
    assert.equal(view.hidden, false);
    assert.equal(view.approvedAt, 7);
    for (const key of ["proposerUid", "proposerName", "fileUnder", "declineNote", "waitingLists", "decidedBy"]) {
      assert.equal(key in view, false, key);
    }
  });

  it("tells the proposer where their waiting lists are, with the picture's private address", () => {
    const view = sectionView(pending, { uid: "me", moderator: false }, noStats("street-food"), false, 2);
    assert.equal(view.pictureUrl, pending.proposalPictureUrl);
    assert.equal(view.fileUnder, "food");
    assert.equal(view.proposerUid, "me");
    assert.equal(view.declineNote, null);
    assert.equal(view.waitingLists, 2);
    assert.equal("proposerName" in view, false);
  });

  it("never hands anybody else a waiting picture's address", () => {
    assert.equal(sectionView(pending, stranger, noStats("street-food"), false).pictureUrl, null);
  });

  it("tells the proposer where a merged proposal went", () => {
    const gone = { ...pending, status: "merged" as const, mergedInto: "food" };
    assert.equal(sectionView(gone, { uid: "me", moderator: false }, noStats("x"), false).mergedInto, "food");
    assert.equal("mergedInto" in sectionView(gone, stranger, noStats("x"), false), false);
  });

  it("tells a moderator everything, the picture's palette too", () => {
    const view = sectionView({ ...pending, palette: ["#7A4A33"] }, { uid: "mod", moderator: true }, noStats("street-food"), false, 2);
    assert.equal(view.pictureUrl, pending.proposalPictureUrl);
    assert.deepEqual(view.palette, ["#7A4A33"]);
    assert.equal(view.unfinished, false);
    assert.equal(view.proposerName, "Me");
    assert.equal(view.createdAt, 1000);
    assert.equal(view.waitingLists, 2);
  });

  it("stops showing the proposer a decline note once they have put it away", () => {
    const declined = { ...pending, status: "declined" as const, declineNote: "Too close to Food", dismissed: true };
    assert.equal(sectionView(declined, { uid: "me", moderator: false }, noStats("x"), false).declineNote, null);
    assert.equal(sectionView({ ...declined, dismissed: false }, { uid: "me", moderator: false }, noStats("x"), false).declineNote, "Too close to Food");
    assert.equal(sectionView(declined, { uid: "mod", moderator: true }, noStats("x"), false).declineNote, "Too close to Food");
  });

  it("never gives a built-in a picture: clients draw their own art", () => {
    assert.equal(sectionView(builtInRecord(BUILT_IN_SECTIONS[0]), stranger, noStats("anime"), false).pictureUrl, null);
  });
});

describe("sectionsListedFor", () => {
  const open = section({ id: "ramen" });
  const hidden = section({ id: "secret", hidden: true });
  const others = [
    section({ id: "mine-late", status: "pending", proposerUid: "me", createdAtMs: 9 }),
    section({ id: "mine-early", status: "declined", proposerUid: "me", createdAtMs: 2 }),
    section({ id: "mine-read", status: "declined", proposerUid: "me", dismissed: true, createdAtMs: 3 }),
    section({ id: "mine-merged", status: "merged", mergedInto: "ramen", proposerUid: "me", createdAtMs: 4 }),
    section({ id: "mine-merged-read", status: "merged", mergedInto: "ramen", proposerUid: "me", dismissed: true, createdAtMs: 6 }),
    section({ id: "theirs", status: "pending", proposerUid: "somebody", createdAtMs: 1 }),
    section({ id: "gone", status: "merged", mergedInto: "ramen", createdAtMs: 5 }),
  ];
  const ids = (sections: SectionRecord[]) => sections.map((one) => one.id);

  it("gives a reader the open sections and their own proposals still to be seen", () => {
    const listed = sectionsListedFor({ uid: "me", moderator: false }, [open, hidden], others);
    assert.deepEqual(ids(listed.tiles), ["ramen"]);
    assert.deepEqual(ids(listed.proposals), ["mine-early", "mine-merged", "mine-late"]);
  });

  it("gives a moderator the hidden sections and the whole history, oldest first", () => {
    const listed = sectionsListedFor({ uid: "mod", moderator: true }, [open, hidden], others);
    assert.deepEqual(ids(listed.tiles), ["ramen", "secret"]);
    assert.deepEqual(ids(listed.proposals), ["theirs", "mine-early", "mine-read", "mine-merged", "gone", "mine-merged-read", "mine-late"]);
  });
});

describe("ownProposals", () => {
  it("is nothing for somebody who proposed nothing", () => {
    assert.deepEqual(ownProposals([section({ id: "ramen", proposerUid: "me" })], "me"), []);
  });
});

describe("proposalAfterErasure", () => {
  it("takes a proposal nobody approved with the account, and keeps a section people use", () => {
    assert.equal(proposalAfterErasure("pending"), "remove");
    assert.equal(proposalAfterErasure("declined"), "remove");
    assert.equal(proposalAfterErasure("approved"), "forget");
    assert.equal(proposalAfterErasure("merged"), "forget");
  });
});

describe("sectionFollowId", () => {
  it("is one document per person and section", () => {
    assert.equal(sectionFollowId("uid123", "food"), "uid123_food");
  });
});

describe("collageImage", () => {
  it("takes the list's own cover when it is on the web", () => {
    assert.equal(collageImage({ coverImageUrl: "https://a/c.jpg", previewImages: ["https://a/p.jpg"] }), "https://a/c.jpg");
  });

  it("falls back to the first card picture on the web", () => {
    assert.equal(
      collageImage({ coverImageUrl: "file:///phone/c.jpg", previewImages: ["content://x", "https://a/p.jpg"] }),
      "https://a/p.jpg",
    );
  });

  it("is nothing for a list without a picture", () => {
    assert.equal(collageImage({ coverImageUrl: null, previewImages: [] }), null);
  });
});

describe("pickCollage", () => {
  it("takes the first four that qualify, in the order given", () => {
    const candidates = ["a", "b", "c", "d", "e"].map((id) => list({ id }));
    assert.deepEqual(pickCollage(candidates, new Set()), [
      "https://img.test/a.jpg",
      "https://img.test/b.jpg",
      "https://img.test/c.jpg",
      "https://img.test/d.jpg",
    ]);
  });

  it("skips lists with few rankings, under review or with an open report", () => {
    const candidates = [
      list({ id: "few", rankingCount: 4 }),
      list({ id: "hidden", underReview: true }),
      list({ id: "reported" }),
      ...["a", "b", "c", "d"].map((id) => list({ id })),
    ];
    assert.deepEqual(pickCollage(candidates, new Set(["reported"])), [
      "https://img.test/a.jpg",
      "https://img.test/b.jpg",
      "https://img.test/c.jpg",
      "https://img.test/d.jpg",
    ]);
  });

  it("never repeats a picture", () => {
    const same = "https://img.test/poster.jpg";
    const candidates = [
      list({ id: "a", coverImageUrl: same }),
      list({ id: "b", coverImageUrl: same }),
      ...["c", "d", "e"].map((id) => list({ id })),
    ];
    assert.deepEqual(pickCollage(candidates, new Set()), [same, "https://img.test/c.jpg", "https://img.test/d.jpg", "https://img.test/e.jpg"]);
  });

  it("draws nothing when fewer than four qualify", () => {
    const candidates = ["a", "b", "c"].map((id) => list({ id }));
    assert.deepEqual(pickCollage(candidates, new Set()), []);
  });
});

describe("countWithout", () => {
  it("never goes below nothing", () => {
    assert.equal(countWithout(10, 3), 7);
    assert.equal(countWithout(1, 2), 0);
  });
});

describe("followedSectionRun", () => {
  it("reads every followed section for the whole feed", () => {
    assert.deepEqual(followedSectionRun(["games", "food"], null), ["games", "food"]);
  });

  it("reads only the narrowed section, and only if it is followed", () => {
    assert.deepEqual(followedSectionRun(["games", "food"], "food"), ["food"]);
    assert.deepEqual(followedSectionRun(["games"], "food"), []);
  });
});

describe("a following page with sections", () => {
  const row = (id: string, updatedAt: number): Ranked => ({ id, updatedAt, takeCount: 0 });

  it("merges a section run with people and topics, once per list, newest first", () => {
    const people = [row("p1", 50), row("shared", 40)];
    const topics = [row("t1", 45)];
    const sections = [row("shared", 40), row("s1", 48), row("s2", 10)];
    assert.deepEqual(
      mergePages([people, topics, sections], "recent", 20).map((one) => one.id),
      ["p1", "s1", "t1", "shared", "s2"],
    );
  });
});

describe("TimedCache", () => {
  it("reads once while the value is fresh, and again once it is old", async () => {
    let now = 0;
    let reads = 0;
    const cache = new TimedCache<number>(1000, () => now);
    const load = async () => ++reads;

    assert.equal(await cache.get(load), 1);
    now = 999;
    assert.equal(await cache.get(load), 1);
    now = 1000;
    assert.equal(await cache.get(load), 2);
  });

  it("shares one read between callers asking at once", async () => {
    let reads = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cache = new TimedCache<number>(1000, () => 0);
    const load = async () => {
      reads += 1;
      await gate;
      return 7;
    };

    const both = Promise.all([cache.get(load), cache.get(load)]);
    release();
    assert.deepEqual(await both, [7, 7]);
    assert.equal(reads, 1);
  });

  it("keeps nothing from a read that failed", async () => {
    let fail = true;
    const cache = new TimedCache<number>(1000, () => 0);
    const load = async () => {
      if (fail) throw new Error("offline");
      return 3;
    };

    await assert.rejects(cache.get(load));
    fail = false;
    assert.equal(await cache.get(load), 3);
  });

  it("reads again once told what it holds has changed", async () => {
    let reads = 0;
    const cache = new TimedCache<number>(1000, () => 0);
    const load = async () => ++reads;

    assert.equal(await cache.get(load), 1);
    cache.invalidate();
    assert.equal(await cache.get(load), 2);
  });

  it("does not keep a read that began before it was told", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cache = new TimedCache<number>(1000, () => 0);
    const stale = cache.get(async () => {
      await gate;
      return 1;
    });
    cache.invalidate();
    release();
    assert.equal(await stale, 1);
    assert.equal(await cache.get(async () => 2), 2);
  });
});

describe("editing a waiting section", () => {
  it("may change how it reads and looks, never its place or visibility", () => {
    assert.deepEqual([...PENDING_EDIT_FIELDS], ["name", "names", "icon", "pictureId", "tint"]);
    assert.deepEqual([...APPROVED_EDIT_FIELDS], ["name", "names", "icon", "rank", "hidden", "pictureId", "tint"]);
  });

  it("names the field that has to wait for approval", () => {
    assert.equal(notYetEditable("pending", { name: "Ramen", rank: 2 }), "rank");
    assert.equal(notYetEditable("pending", { hidden: false }), "hidden");
    assert.equal(notYetEditable("pending", { name: "Ramen", tint: "#7A4A33" }), null);
    assert.equal(notYetEditable("approved", { rank: 2, hidden: true }), null);
  });

  it("only takes what the owner may change on it, whatever else is sent", () => {
    assert.deepEqual(readSectionEdits({ name: "Ramen", rank: 2, hidden: true, tint: "#7a4a33" }, PENDING_EDIT_FIELDS), {
      ok: true,
      edits: { name: "Ramen", tint: "#7A4A33" },
    });
  });
});

describe("releasedNames", () => {
  it("is the compared forms of the names a section stops going by", () => {
    assert.deepEqual(releasedNames(["Ramen", "Рамен"], ["Noodles", "рамен"]), ["ramen"]);
    assert.deepEqual(releasedNames(["Ramen"], ["RAMEN"]), []);
  });
});

describe("a withdrawn proposal", () => {
  it("says so to the moderators, rather than leaving them to read it from who decided", () => {
    const withdrawn = section({ id: "w", status: "declined", proposerUid: "me", decidedBy: "me", withdrawn: true, dismissed: true });
    assert.equal(sectionView(withdrawn, { uid: "mod", moderator: true }, noStats("w"), false).withdrawn, true);
    assert.equal("withdrawn" in sectionView(section({ id: "x" }), { uid: "somebody", moderator: false }, noStats("x"), false), false);
  });
});
