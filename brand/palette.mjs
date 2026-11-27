// Active brand colors for the yanylevin.com apps and the iOS app.
//
// Every theme starts from brand/themes/original.mjs, the saved original colors.
// Never edit original.mjs. A seasonal theme is a small file in brand/themes/ that
// lists only the colors it changes, using the same keys as original.mjs. Example,
// brand/themes/halloween.mjs:
//
//   export default {
//     personal: {
//       accent: { light: "#d9620b", dark: "#f28c38" },
//       bloomA: { light: "rgba(217, 98, 11, 0.22)", dark: "rgba(242, 140, 56, 0.2)" },
//       chipTint: { light: "#d9620b", dark: "#f28c38" },
//       ios: { liveActivity: { light: "#a85a22", dark: "#e3a06a" } },
//     },
//     agent: {
//       accent: { light: "#1a1a1a", dark: "#d4d4d4" },
//       pulse: { light: "#bdbdbd", dark: "#e6e6e6" },
//       ios: { liveActivity: { hsb: [0, 0, 0.7] } },
//     },
//   };
//
// Each brand's comments in original.mjs say where a color shows up. A theme that changes
// an accent should usually change its bloom, chip tint, pulse, and Live Activity colors
// too, or they keep the original look. Changing an accent drops any iOS-only override
// for it (agent.ios.accentDark), so iOS follows the new value.
//
// To switch: set ACTIVE_THEME below to the file name ("halloween"), run `npm run brand`,
// deploy the web, and rebuild iOS. To go back: set ACTIVE_THEME to "original" and do the
// same. Keep old theme files so they can come back next year.
//
// After the merge, background washes (bloomA/B/C, and bg/glow when the brand
// has them) are derived from each brand's accent so no leftover hue can linger
// when the theme changes.
// `npm run brand` copies the merged colors into education/styles.css, the personal sites
// that keep their own token block (2026-27-electives, prasham-schedule-options), the iOS
// theme (ios/YanLevin/YanLevin/Design/BrandPalette.generated.swift), and the object-html
// skill. Never hand-edit those generated blocks.

import original from "./themes/original.mjs";

export const ACTIVE_THEME = "fall";

function merge(base, over) {
  if (!over || typeof over !== "object" || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = merge(base?.[key], value);
  return out;
}

const overrides =
  ACTIVE_THEME === "original" ? {} : (await import(`./themes/${ACTIVE_THEME}.mjs`)).default;

const palette = merge(original, overrides);

for (const [brand, tokens] of Object.entries(overrides)) {
  if (!palette[brand]?.ios) continue;
  const ios = (palette[brand].ios = { ...palette[brand].ios });
  for (const key of Object.keys(tokens)) {
    if (key === "ios") continue;
    for (const mode of ["Light", "Dark"]) {
      if (!tokens.ios?.[key + mode]) delete ios[key + mode];
    }
  }
}


function clampByte(n) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function mixRgb(hex, towardWhite, amount) {
  const { r, g, b } = hexToRgb(hex);
  const t = towardWhite ? 255 : 0;
  return {
    r: clampByte(r + (t - r) * amount),
    g: clampByte(g + (t - g) * amount),
    b: clampByte(b + (t - b) * amount),
  };
}

function rgba({ r, g, b }, alpha) {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function rgbToHex({ r, g, b }) {
  const h = (n) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Background washes follow the brand accent. bloomA is the accent at wash
// strength, bloomB a lighter/softer mix, bloomC a darker (light mode) or
// lighter (dark mode) mix. Paper (bg0/bg1) and pointer glow, when present,
// are a faint tint of the same accent — never a leftover hue.
function backgroundFromAccent(accent) {
  return {
    bloomA: {
      light: rgba(hexToRgb(accent.light), 0.22),
      dark: rgba(hexToRgb(accent.dark), 0.2),
    },
    bloomB: {
      light: rgba(mixRgb(accent.light, true, 0.4), 0.16),
      dark: rgba(mixRgb(accent.dark, false, 0.35), 0.15),
    },
    bloomC: {
      light: rgba(mixRgb(accent.light, false, 0.28), 0.18),
      dark: rgba(mixRgb(accent.dark, true, 0.28), 0.17),
    },
    bg0: {
      light: rgbToHex(mixRgb(accent.light, true, 0.94)),
      dark: rgbToHex(mixRgb(accent.dark, false, 0.95)),
    },
    bg1: {
      light: rgbToHex(mixRgb(accent.light, true, 0.89)),
      dark: rgbToHex(mixRgb(accent.dark, false, 0.91)),
    },
    glow: {
      light: rgba(mixRgb(accent.light, true, 0.92), 1),
      dark: rgba(hexToRgb(accent.dark), 0.08),
    },
  };
}

for (const brand of Object.values(palette)) {
  if (!brand?.accent?.light || !brand?.accent?.dark) continue;
  const derived = backgroundFromAccent(brand.accent);
  for (const key of Object.keys(derived)) {
    if (brand[key]) brand[key] = derived[key];
  }
}

export default palette;
