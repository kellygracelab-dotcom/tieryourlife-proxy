// Builds test/theme-vectors.json: the colours every client must get for each
// ready colour and for a spread of a person's own hues, light and dark.
// `npm run theme-vectors` writes it; `node scripts/theme-vectors.mjs --check`
// (run by test/themeVectors.test.ts) fails when the file is not what this makes.
// Material Color Utilities is pinned in package.json: a newer one may move a colour.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deepStrictEqual } from "node:assert/strict";
import { Hct, SchemeTonalSpot, hexFromArgb, argbFromHex, labFromArgb, MaterialDynamicColors } from "@material/material-color-utilities";

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, "..", "test", "theme-vectors.json");
const pkg = JSON.parse(readFileSync(join(here, "..", "node_modules", "@material", "material-color-utilities", "package.json"), "utf8"));

/** Kept in step with PRESET_HUES in src/settings.ts (the test checks it). */
const PRESETS = { matcha: 125, peach: 42, sky: 212 };
const OWN_HUES = [0, 30, 60, 90, 150, 180, 240, 270, 277, 300, 330, 359];
const SEED_CHROMA = 36;
const SEED_TONE = 50;

const ROLES = [
  "primary", "onPrimary", "primaryContainer", "onPrimaryContainer", "inversePrimary",
  "secondary", "onSecondary", "secondaryContainer", "onSecondaryContainer",
  "tertiary", "onTertiary", "tertiaryContainer", "onTertiaryContainer",
  "error", "onError", "errorContainer", "onErrorContainer",
  "background", "onBackground",
  "surface", "onSurface", "surfaceVariant", "onSurfaceVariant", "surfaceTint",
  "surfaceDim", "surfaceBright",
  "surfaceContainerLowest", "surfaceContainerLow", "surfaceContainer", "surfaceContainerHigh", "surfaceContainerHighest",
  "inverseSurface", "inverseOnSurface", "outline", "outlineVariant", "scrim",
];

/** Tier colours S-D, the same in every colour (light with the new gold B of 18.11.2026; dark as now). */
const TIERS = {
  light: { S: "#b03a32", A: "#c06a25", B: "#b88a00", C: "#3f7f55", D: "#3c6e99" },
  dark: { S: "#f1948c", A: "#e9a867", B: "#d8c05a", C: "#7fc393", D: "#86b8de" },
};

/** CIEDE2000 between two colours. */
function deltaE(first, second) {
  const [L1, a1, b1] = labFromArgb(first), [L2, a2, b2] = labFromArgb(second);
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const ap1 = a1 * (1 + G), ap2 = a2 * (1 + G);
  const Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
  const angle = (x, y) => (x === 0 && y === 0 ? 0 : (Math.atan2(y, x) / rad + 360) % 360);
  const h1 = angle(ap1, b1), h2 = angle(ap2, b2);
  let dh = Cp1 * Cp2 === 0 ? 0 : h2 - h1;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  const dL = L2 - L1, dC = Cp2 - Cp1, dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh / 2) * rad);
  const Lbar = (L1 + L2) / 2, Cpbar = (Cp1 + Cp2) / 2;
  let hbar = h1 + h2;
  if (Cp1 * Cp2 !== 0) {
    if (Math.abs(h1 - h2) > 180) hbar += h1 + h2 < 360 ? 360 : -360;
    hbar /= 2;
  }
  const T = 1 - 0.17 * Math.cos((hbar - 30) * rad) + 0.24 * Math.cos(2 * hbar * rad) + 0.32 * Math.cos((3 * hbar + 6) * rad) - 0.2 * Math.cos((4 * hbar - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbar - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cpbar ** 7 / (Cpbar ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2), SC = 1 + 0.045 * Cpbar, SH = 1 + 0.015 * Cpbar * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

const hex = (argb) => hexFromArgb(argb).toUpperCase();

function nearestTier(primary, tiers) {
  const [tier, distance] = Object.entries(tiers)
    .map(([name, colour]) => [name, deltaE(primary, argbFromHex(colour))])
    .sort((x, y) => x[1] - y[1])[0];
  return { tier, deltaE2000: Math.round(distance * 10) / 10 };
}

function palette(hue) {
  const seed = Hct.from(hue, SEED_CHROMA, SEED_TONE).toInt();
  const roles = (dark) => {
    const scheme = new SchemeTonalSpot(Hct.fromInt(seed), dark, 0);
    return Object.fromEntries(ROLES.map((role) => [role, hex(MaterialDynamicColors[role].getArgb(scheme))]));
  };
  const light = roles(false), dark = roles(true);
  return {
    hue,
    seed: hex(seed),
    mainButtonNearestTier: {
      light: nearestTier(argbFromHex(light.primary), TIERS.light),
      dark: nearestTier(argbFromHex(dark.primary), TIERS.dark),
    },
    light,
    dark,
  };
}

export function build() {
  return {
    about:
      "Colour themes (Danylo, 18.11.2026; artboards 58-59). Web and Android copy this file into their tests unchanged and must build the same colours. Made by functions/scripts/theme-vectors.mjs; contract in CONTRACT.md, boards, Settings.",
    algorithm: {
      library: `@material/material-color-utilities ${pkg.version}`,
      seed: `Hct.from(hue, ${SEED_CHROMA}, ${SEED_TONE}) as an ARGB colour; the scheme is built from Hct.fromInt of that colour`,
      scheme: "SchemeTonalSpot (spec 2021), contrast level 0; light and dark from the same seed",
      tolerance: "each of red, green and blue within 1 of the file",
      mainButton: "primary; mainButtonNearestTier is its CIEDE2000 distance to the closest tier colour S-D (today's lavender: 9.6 light, 12.8 dark)",
    },
    tolerance: 1,
    tiers: TIERS,
    names: {
      lavender: "the default and today's look: each client's own hand-made colours, not built from a hue",
      matcha: `built from hue ${PRESETS.matcha}`,
      peach: `built from hue ${PRESETS.peach}`,
      sky: `built from hue ${PRESETS.sky}`,
      phone: "Android 12+: the phone's own wallpaper colours; the website and older Android show lavender",
      custom: "built from the setting's hue",
    },
    presets: Object.fromEntries(Object.entries(PRESETS).map(([name, hue]) => [name, palette(hue)])),
    ownHues: OWN_HUES.map(palette),
    settingValues: {
      accepted: [
        { name: "lavender", hue: null, changedAt: 1795500000000 },
        { name: "matcha", hue: null, changedAt: 1795500000000 },
        { name: "peach", hue: 200, changedAt: 1795500000000 },
        { name: "sky", changedAt: 1795500000000 },
        { name: "phone", hue: null, changedAt: 1795500000000 },
        { name: "custom", hue: 0, changedAt: 1795500000000 },
        { name: "custom", hue: 359, changedAt: 1795500000000 },
      ],
      refused: [
        { body: { name: "rose", hue: null, changedAt: 1795500000000 }, detail: "name" },
        { body: { name: "Matcha", hue: null, changedAt: 1795500000000 }, detail: "name" },
        { body: { hue: 10, changedAt: 1795500000000 }, detail: "name" },
        { body: { name: "custom", hue: null, changedAt: 1795500000000 }, detail: "hue" },
        { body: { name: "custom", changedAt: 1795500000000 }, detail: "hue" },
        { body: { name: "custom", hue: 360, changedAt: 1795500000000 }, detail: "hue" },
        { body: { name: "custom", hue: -1, changedAt: 1795500000000 }, detail: "hue" },
        { body: { name: "custom", hue: 12.5, changedAt: 1795500000000 }, detail: "hue" },
        { body: { name: "custom", hue: "12", changedAt: 1795500000000 }, detail: "hue" },
        { body: { name: "matcha", hue: null }, detail: "changedAt" },
        { body: { name: "matcha", hue: null, changedAt: 0 }, detail: "changedAt" },
        { body: { name: "matcha", hue: null, changedAt: "1795500000000" }, detail: "changedAt" },
        { body: ["matcha"], detail: "body" },
      ],
    },
  };
}

const made = build();
if (process.argv.includes("--check")) {
  deepStrictEqual(JSON.parse(readFileSync(file, "utf8")), made, "test/theme-vectors.json is not what scripts/theme-vectors.mjs makes: run npm run theme-vectors");
  console.log("theme-vectors.json is up to date");
} else {
  writeFileSync(file, JSON.stringify(made, null, 2) + "\n");
  console.log(`wrote ${file}`);
}
