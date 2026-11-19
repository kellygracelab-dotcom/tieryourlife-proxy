// Builds test/theme-vectors.json: the colours every client must get for each
// ready colour and for a spread of a person's own hues, light and dark.
// `npm run theme-vectors` writes it; `node scripts/theme-vectors.mjs --check`
// (run by test/themeVectors.test.ts) fails when the file is not what this makes.
// Material Color Utilities is pinned in package.json: a newer one may move a colour.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deepStrictEqual } from "node:assert/strict";
import { DynamicScheme, Hct, TonalPalette, hexFromArgb, argbFromHex, labFromArgb, MaterialDynamicColors } from "@material/material-color-utilities";

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, "..", "test", "theme-vectors.json");
const pkg = JSON.parse(readFileSync(join(here, "..", "node_modules", "@material", "material-color-utilities", "package.json"), "utf8"));

/**
 * The ready colours, chosen by the Designer on 19.11.2026 against artboard 59
 * (`_coordination/colour-presets-2026-11-19/PRESETS.md`): the main colour and
 * the neutral tint each their own hue and chroma, so matcha is not khaki nor sky turquoise.
 */
const PRESETS = {
  matcha: { primary: { hue: 136, chroma: 28 }, neutral: { hue: 138, chroma: 7 } },
  peach: { primary: { hue: 41, chroma: 38 }, neutral: { hue: 71, chroma: 4 } },
  sky: { primary: { hue: 220, chroma: 36 }, neutral: { hue: 237, chroma: 9 } },
};
const OWN_HUES = [0, 30, 60, 90, 150, 180, 240, 270, 277, 300, 330, 359];
const SEED_CHROMA = 36;
const SEED_TONE = 50;
/** The own colour's neutral chroma (its neutral variant +2); 10 turned warm hues pink (Designer, 19.11.2026). */
const OWN_NEUTRAL = 8;

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

/** The 36 roles of a TonalSpot scheme (spec 2021, contrast 0) over these five palettes. */
function rolesOf(palettes, dark) {
  const tonal = ({ hue, chroma }) => TonalPalette.fromHueAndChroma(hue, chroma);
  const scheme = new DynamicScheme({
    sourceColorArgb: tonal(palettes.primary).keyColor.toInt(),
    variant: 2, // Variant.TONAL_SPOT (0.3.0 does not export the enum)
    contrastLevel: 0,
    isDark: dark,
    primaryPalette: tonal(palettes.primary),
    secondaryPalette: tonal(palettes.secondary),
    tertiaryPalette: tonal(palettes.tertiary),
    neutralPalette: tonal(palettes.neutral),
    neutralVariantPalette: tonal(palettes.neutralVariant),
  });
  return Object.fromEntries(ROLES.map((role) => [role, hex(MaterialDynamicColors[role].getArgb(scheme))]));
}

function withRoles(palettes) {
  const light = rolesOf(palettes, false), dark = rolesOf(palettes, true);
  // Hues to two places: the last digits of a computed hue differ between platforms.
  const recorded = Object.fromEntries(Object.entries(palettes).map(([role, { hue, chroma }]) => [role, { hue: Math.round(hue * 100) / 100, chroma }]));
  return {
    palettes: recorded,
    mainButtonNearestTier: {
      light: nearestTier(argbFromHex(light.primary), TIERS.light),
      dark: nearestTier(argbFromHex(dark.primary), TIERS.dark),
    },
    light,
    dark,
  };
}

/** A ready colour: its own five palettes, TonalSpot's secondary and tertiary around its main hue. */
function preset({ primary, neutral }) {
  return withRoles({
    primary,
    secondary: { hue: primary.hue, chroma: 16 },
    tertiary: { hue: (primary.hue + 60) % 360, chroma: 24 },
    neutral,
    neutralVariant: { hue: neutral.hue, chroma: neutral.chroma + 2 },
  });
}

/** The person's own colour: TonalSpot from one hue, its neutrals a little stronger (8 and 10 in place of 6 and 8). */
function ownColour(hue) {
  const seed = Hct.from(hue, SEED_CHROMA, SEED_TONE).toInt();
  const at = Hct.fromInt(seed).hue;
  return {
    hue,
    seed: hex(seed),
    ...withRoles({
      primary: { hue: at, chroma: 36 },
      secondary: { hue: at, chroma: 16 },
      tertiary: { hue: (at + 60) % 360, chroma: 24 },
      neutral: { hue: at, chroma: OWN_NEUTRAL },
      neutralVariant: { hue: at, chroma: OWN_NEUTRAL + 2 },
    }),
  };
}

export function build() {
  return {
    about:
      "Colour themes (Danylo, 18.11.2026; artboards 58-59). Web and Android copy this file into their tests unchanged and must build the same colours. Made by functions/scripts/theme-vectors.mjs; contract in CONTRACT.md, boards, Settings.",
    algorithm: {
      library: `@material/material-color-utilities ${pkg.version}`,
      scheme:
        "DynamicScheme with variant TONAL_SPOT (spec 2021), contrast level 0, over five TonalPalette.fromHueAndChroma palettes (primary, secondary, tertiary, neutral, neutralVariant); light and dark from the same palettes",
      presets: "matcha, peach and sky are the fixed tables under presets: a client takes their light and dark roles as they are (palettes say how they were made)",
      ownColour: `seed = Hct.from(hue, ${SEED_CHROMA}, ${SEED_TONE}) as an ARGB colour, h = Hct.fromInt(seed).hue; palettes primary (h, 36), secondary (h, 16), tertiary (h + 60, 24), neutral (h, ${OWN_NEUTRAL}), neutralVariant (h, ${OWN_NEUTRAL + 2}). With neutral 6 and 8 this is exactly SchemeTonalSpot.`,
      tolerance: "each of red, green and blue within 1 of the file",
      mainButton: "primary; mainButtonNearestTier is its CIEDE2000 distance to the closest tier colour S-D (today's lavender: 9.6 light, 12.8 dark)",
    },
    tolerance: 1,
    tiers: TIERS,
    names: {
      lavender: "the default and today's look: each client's own hand-made colours, not built from a hue",
      matcha: "the fixed table presets.matcha",
      peach: "the fixed table presets.peach",
      sky: "the fixed table presets.sky",
      phone: "Android 12+: the phone's own wallpaper colours; the website and older Android show lavender",
      custom: "built from the setting's hue (algorithm.ownColour)",
    },
    presets: Object.fromEntries(Object.entries(PRESETS).map(([name, made]) => [name, preset(made)])),
    ownHues: OWN_HUES.map(ownColour),
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
