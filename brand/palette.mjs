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
// `npm run brand` copies the merged colors into education/styles.css, the personal sites
// that keep their own token block (2026-27-electives, prasham-schedule-options), the iOS
// theme (ios/YanLevin/YanLevin/Design/BrandPalette.generated.swift), and the object-html
// skill. Never hand-edit those generated blocks.

import original from "./themes/original.mjs";

export const ACTIVE_THEME = "halloween";

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

export default palette;
