// Halloween. Personal teal becomes orange. Agent orange becomes black in light
// mode and light gray in dark mode. JYPE stays red and debate stays slate.
// Their selected chips copied the personal teal, so those follow the new orange.

export default {
  personal: {
    accent: { light: "#d9620b", dark: "#f28c38" },
    bloomA: { light: "rgba(217, 98, 11, 0.22)", dark: "rgba(242, 140, 56, 0.2)" },
    chipTint: { light: "#d9620b", dark: "#f28c38" },
    ios: { liveActivity: { light: "#a85a22", dark: "#e3a06a" } },
  },
  agent: {
    accent: { light: "#1a1a1a", dark: "#d4d4d4" },
    pulse: { light: "#bdbdbd", dark: "#e6e6e6" },
    ios: { liveActivity: { hsb: [0, 0, 0.7] } },
  },
  jype: {
    chipTint: { light: "#d9620b", dark: "#f28c38" },
  },
  debate: {
    chipTint: { light: "#d9620b", dark: "#f28c38" },
  },
};
