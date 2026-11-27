// Fall. The site orange stays, including the JYPE and debate chips that follow it.
// Chat is a dark navy purple in light mode and a light lavender in dark mode,
// so bubbles, the send tint, and the beam still read on the page.
// JYPE stays red. Debate stays slate. Debate chat uses this purple.

export default {
  personal: {
    accent: { light: "#d9620b", dark: "#f28c38" },
    bloomA: { light: "rgba(217, 98, 11, 0.22)", dark: "rgba(242, 140, 56, 0.2)" },
    chipTint: { light: "#d9620b", dark: "#f28c38" },
    ios: { liveActivity: { light: "#a85a22", dark: "#e3a06a" } },
  },
  agent: {
    accent: { light: "#32245c", dark: "#cbb6f0" },
    pulse: { light: "#d4cce6", dark: "#ebe4f8" },
    ios: { liveActivity: { hsb: [262, 0.3, 0.72] } },
  },
  jype: {
    chipTint: { light: "#d9620b", dark: "#f28c38" },
  },
  debate: {
    chipTint: { light: "#d9620b", dark: "#f28c38" },
  },
};
