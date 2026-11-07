import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commonsCredit, MAX_CREDIT_LENGTH } from "../src/pictureCredit";
import { commonsPictures } from "../src/pictureSources";
import { decidePublish, settle } from "../src/publishing";

const page = { pageid: 12345, title: "File:A fox.jpg" };
const meta = (values: Record<string, string>) => ({ extmetadata: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])) });

describe("Commons attribution", () => {
  it("keeps the author, their link, licence and canonical source in the existing credit field", () => {
    const credit = commonsCredit(page, meta({ Artist: '<a href="/wiki/User:Jane">Jane &amp; Doe</a>', LicenseShortName: "CC BY 4.0", LicenseUrl: "https://creativecommons.org/licenses/by/4.0/" }));
    assert.equal(credit, "Jane & Doe (https://commons.wikimedia.org/wiki/User:Jane) · CC BY 4.0 · https://creativecommons.org/licenses/by/4.0/ · https://commons.wikimedia.org/?curid=12345");
  });

  it("uses the supplied custom attribution rather than inventing a photographer from the uploader", () => {
    const credit = commonsCredit(page, { user: "Uploader", ...meta({ Attribution: "Photo by the museum", Artist: "Other", Credit: "Elsewhere", LicenseShortName: "Public domain" }) });
    assert.equal(credit, "Photo by the museum · Public domain · https://commons.wikimedia.org/?curid=12345");
  });

  it("supplies no credit when no attribution was returned", () => {
    assert.equal(commonsCredit(page, { width: 500, height: 700, user: "Uploader" }), undefined);
    assert.equal(commonsCredit(page, meta({ Artist: "   " })), undefined);
  });

  it("treats markup as text and drops executable links, scripts and styles", () => {
    const credit = commonsCredit(page, meta({ Artist: '<script>bad()</script><a href="&#x6a;avascript:bad()">Jane &#169;</a><style>hidden</style>' }));
    assert.equal(credit, "Jane © · https://commons.wikimedia.org/?curid=12345");
    assert.equal(commonsCredit(page, meta({ LicenseUrl: "not a URL" })), undefined);
  });

  it("retains multiple supplied licence links and never truncates a URL", () => {
    const urls = "https://creativecommons.org/licenses/by/4.0/ https://www.gnu.org/licenses/fdl-1.3.html";
    const credit = commonsCredit(page, meta({ Artist: "Jane", LicenseUrl: urls }));
    for (const url of urls.split(" ")) assert.ok(credit?.includes(url));
    assert.equal(commonsCredit(page, meta({ Artist: "a".repeat(MAX_CREDIT_LENGTH) })), null);
  });

  it("carries a real-shaped 200+ character attribution through search, publication and the serialized public snapshot", () => {
    const artist = "The Museum Photographic Collection, " + "Department of Natural History ".repeat(7);
    const info = { width: 800, height: 1000, ...meta({ Artist: artist, LicenseShortName: "CC BY-SA 4.0", LicenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/" }) };
    const pictures = commonsPictures({ query: { pages: { "12345": { ...page, imageinfo: [info] } } } }, true);
    const credit = pictures.get("A fox.jpg")?.credit;
    assert.ok(credit && credit.length > 200 && credit.length <= MAX_CREDIT_LENGTH);
    const decision = decidePublish({ isAnonymous: false, listsAlreadyPublished: 0, uploaderUid: "u1", body: {
      title: "Wildlife", category: "animals", tiers: [{ label: "S", colorLight: "#B03A32", colorDark: "#F1948C" }],
      items: [{ title: "Fox", imageUrl: "https://commons.wikimedia.org/wiki/Special:FilePath/A_fox.jpg?width=600", credit }],
    } });
    assert.ok(decision.ok);
    const publicSnapshot = JSON.parse(JSON.stringify(settle(decision.draft, new Map())));
    assert.equal(publicSnapshot.items[0].credit, credit);
  });
});
