import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  coloursFromChosenTint,
  coloursFromPicture,
  coloursFromTint,
  DARK_BASE,
  dominantColour,
  hexToRgb,
  mix,
  paletteOf,
  rgbToHex,
  tintLightFrom,
  TINT_MAX_LIGHTNESS,
  TINT_MIN_LIGHTNESS,
  toOklab,
  type WeightedColour,
} from "../src/sectionColours";
import { BUILT_IN_SECTIONS, NEUTRAL_COLOURS } from "../src/sections";

const colour = (hex: string, weight: number): WeightedColour => ({ ...hexToRgb(hex), weight });

describe("hex colours", () => {
  it("go to channels and back, upper-cased", () => {
    assert.deepEqual(hexToRgb("#9a5638"), { r: 154, g: 86, b: 56 });
    assert.equal(rgbToHex({ r: 154, g: 86, b: 56 }), "#9A5638");
  });

  it("clip a channel out of range rather than wrap it", () => {
    assert.equal(rgbToHex({ r: 300, g: -4, b: 127.6 }), "#FF0080");
  });
});

describe("mix", () => {
  it("is all of the colour at one and all of the base at nothing", () => {
    assert.equal(mix("#9A5638", DARK_BASE, 1), "#9A5638");
    assert.equal(mix("#9A5638", DARK_BASE, 0), DARK_BASE);
  });
});

describe("coloursFromTint", () => {
  // Claude Design's own vector, which the derivation has to reproduce exactly.
  it("derives Food's colours from its light tint", () => {
    assert.deepEqual(coloursFromTint("#9A5638"), {
      tint: { light: "#9A5638", dark: "#794732" },
      topicBg: { light: "#E7D3D1", dark: "#3A2824" },
      topicIcon: { light: "#9A5638", dark: "#FBAF8F" },
    });
  });

  // The built-ins are stored as given, never recomputed; that the same rule
  // gives the same numbers is what lets user sections sit beside them.
  it("gives every built-in's stored colours from its light tint", () => {
    for (const builtIn of BUILT_IN_SECTIONS) {
      assert.deepEqual(coloursFromTint(builtIn.colours.tint.light), builtIn.colours, builtIn.id);
    }
  });

  it("reads a lower-case tint the same", () => {
    assert.deepEqual(coloursFromTint("#9a5638"), coloursFromTint("#9A5638"));
  });
});

describe("tintLightFrom", () => {
  const lightness = (hex: string) => toOklab(hex).L;
  // Eight bits a channel cannot land exactly on a lightness.
  const near = 0.006;

  it("lifts a dark colour to the bottom of the range", () => {
    const tint = tintLightFrom(hexToRgb("#1E2A4A"));
    assert.ok(Math.abs(lightness(tint) - TINT_MIN_LIGHTNESS) < near, tint);
  });

  it("brings a pale colour down to the top of the range", () => {
    const tint = tintLightFrom(hexToRgb("#F2C9A8"));
    assert.ok(Math.abs(lightness(tint) - TINT_MAX_LIGHTNESS) < near, tint);
  });

  it("leaves a colour already in range as it is", () => {
    assert.equal(tintLightFrom(hexToRgb("#62508A")), "#62508A");
  });

  it("keeps the hue: a warm colour stays warm", () => {
    const { r, g, b } = hexToRgb(tintLightFrom(hexToRgb("#F2C9A8")));
    assert.ok(r > g && g > b);
  });
});

describe("dominantColour", () => {
  it("is the mean of the fullest group", () => {
    const found = dominantColour([colour("#C04020", 0.2), colour("#C24222", 0.2), colour("#2050A0", 0.3)]);
    assert.deepEqual(found, { r: 193, g: 65, b: 33 });
  });

  it("ignores near-black and near-white while there is anything else", () => {
    const found = dominantColour([colour("#050505", 0.6), colour("#FAFAFA", 0.3), colour("#2050A0", 0.1)]);
    assert.deepEqual(found, hexToRgb("#2050A0"));
  });

  it("falls back to them when they are all there is", () => {
    const found = dominantColour([colour("#050505", 0.6), colour("#FAFAFA", 0.3)]);
    assert.deepEqual(found, hexToRgb("#050505"));
  });

  it("is nothing for nothing", () => {
    assert.equal(dominantColour([]), null);
    assert.equal(dominantColour([colour("#2050A0", 0)]), null);
  });

  it("settles a tie the same way every time", () => {
    const one = colour("#2050A0", 0.5);
    const other = colour("#A05020", 0.5);
    assert.deepEqual(dominantColour([one, other]), dominantColour([other, one]));
  });
});

describe("coloursFromPicture", () => {
  it("derives everything from the picture's colour, held in range", () => {
    const colours = coloursFromPicture([colour("#F2C9A8", 1)], NEUTRAL_COLOURS);
    assert.deepEqual(colours, coloursFromTint(tintLightFrom(hexToRgb("#F2C9A8"))));
  });

  it("falls back when Vision saw nothing", () => {
    assert.deepEqual(coloursFromPicture([], NEUTRAL_COLOURS), NEUTRAL_COLOURS);
  });
});

describe("coloursFromChosenTint", () => {
  it("holds a user section's chosen tint in range, then derives the rest", () => {
    assert.deepEqual(coloursFromChosenTint("#F2C9A8", false), coloursFromTint(tintLightFrom(hexToRgb("#F2C9A8"))));
    assert.notEqual(coloursFromChosenTint("#F2C9A8", false).tint.light, "#F2C9A8");
  });

  it("takes a built-in's chosen tint as given", () => {
    assert.equal(coloursFromChosenTint("#F2C9A8", true).tint.light, "#F2C9A8");
  });
});

describe("paletteOf", () => {
  it("is the strongest colours by Vision's score, at most five, each once", () => {
    const colours = [
      { ...colour("#111111", 0.1), score: 0.05 },
      { ...colour("#7A4A33", 0.3), score: 0.4 },
      { ...colour("#7A4A33", 0.1), score: 0.3 },
      { ...colour("#2050A0", 0.2), score: 0.2 },
      { ...colour("#A05020", 0.1), score: 0.1 },
      { ...colour("#20A050", 0.1), score: 0.09 },
      { ...colour("#E0E0E0", 0.1), score: 0.08 },
    ];
    assert.deepEqual(paletteOf(colours), ["#7A4A33", "#2050A0", "#A05020", "#20A050", "#E0E0E0"]);
  });

  it("falls back to how much of the picture a colour covers when there is no score", () => {
    assert.deepEqual(paletteOf([colour("#2050A0", 0.2), colour("#7A4A33", 0.6)]), ["#7A4A33", "#2050A0"]);
  });
});
