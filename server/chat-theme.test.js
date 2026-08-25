import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractThemeMarker,
  finalizeChatTheme,
  stripHarmonyTokens,
} from "./chat-theme.js";

describe("extractThemeMarker", () => {
  it("parses [[set_theme:…]] markers", () => {
    assert.equal(extractThemeMarker("Done.\n[[set_theme:dark]]"), "dark");
    assert.equal(extractThemeMarker("[[set_theme: light ]]"), "light");
    assert.equal(extractThemeMarker("no marker here"), null);
  });
});

describe("finalizeChatTheme (LLM action only)", () => {
  it("applies theme from marker and hides it from content", () => {
    const result = finalizeChatTheme("Theme set to dark\n[[set_theme:dark]]");
    assert.deepEqual(result.themeUpdate, { theme: "dark" });
    assert.equal(result.content, "Theme set to dark");
    assert.doesNotMatch(result.content, /\[\[/);
  });

  it("applies theme from trailing JSON", () => {
    const result = finalizeChatTheme(
      'Changing to light.\n{"action":"set_theme","theme":"light"}'
    );
    assert.deepEqual(result.themeUpdate, { theme: "light" });
    assert.equal(result.content, "Changing to light.");
  });

  it("does not invent a theme from prose alone", () => {
    const result = finalizeChatTheme("Theme change applied as requested");
    assert.equal(result.themeUpdate, undefined);
    assert.equal(result.content, "Theme change applied as requested");
  });

  it("strips harmony scaffolding and still reads a marker", () => {
    const result = finalizeChatTheme(
      "<|channel|>final<|message|>Done\n[[set_theme:system]]"
    );
    assert.deepEqual(result.themeUpdate, { theme: "system" });
    assert.equal(result.content, "Site theme set to system");
  });

  it("keeps theme marker from final channel when analysis is present", () => {
    const result = finalizeChatTheme(
      [
        "<|channel|>analysis<|message|>User wants dark. Done.",
        "<|end|><|start|>assistant",
        "<|channel|>final<|message|>Site theme set to dark",
        "[[set_theme:dark]]",
      ].join("")
    );
    assert.deepEqual(result.themeUpdate, { theme: "dark" });
    assert.equal(result.content, "Site theme set to dark");
    assert.doesNotMatch(result.content, /Done|analysis|User wants/i);
  });

  it("harmony-only junk yields no themeUpdate", () => {
    const result = finalizeChatTheme(
      "<|channel|>final <|constrain|>json<|message|>"
    );
    assert.equal(result.themeUpdate, undefined);
  });

  it("marker wins over conflicting JSON", () => {
    const result = finalizeChatTheme(
      '[[set_theme:dark]]\n{"action":"set_theme","theme":"light"}'
    );
    assert.deepEqual(result.themeUpdate, { theme: "dark" });
  });
});

describe("stripHarmonyTokens", () => {
  it("strips harmony scaffolding to empty", () => {
    assert.equal(
      stripHarmonyTokens("<|channel|>final <|constrain|>json<|message|>"),
      ""
    );
  });

  it("keeps only the final channel body", () => {
    const raw = [
      "<|channel|>analysis<|message|>Draft about Yan. Done.",
      "<|end|><|start|>assistant",
      "<|channel|>final<|message|>Yan is a junior at Example Schoolaratory School",
    ].join("");
    assert.equal(
      stripHarmonyTokens(raw),
      "Yan is a junior at Example Schoolaratory School"
    );
  });

  it("does not leak analysis when there is no final channel", () => {
    assert.equal(
      stripHarmonyTokens(
        "<|channel|>analysis<|message|>Internal thoughts only. Done."
      ),
      ""
    );
  });

  it("unglues duplicated answer around Done. (token-stripped artifact)", () => {
    const answer =
      "Yan is a 16-year-old junior at Example Schoolaratory School, specializing in computer science, AI research, and co-founding the startup ExampleCo";
    assert.equal(stripHarmonyTokens(`${answer}Done.${answer}`), answer);
  });

  it("unglues duplicated answer around We followed guidelines.", () => {
    const answer =
      "Yan is a 16-year-old student at Example Schoolaratory School who works on computer science, AI research, and co-founded the startup ExampleCo";
    assert.equal(
      stripHarmonyTokens(`${answer}We followed guidelines.${answer}`),
      answer
    );
  });

  it("unglues duplicated answer around We are done.", () => {
    const answer =
      "I do not know his current location beyond the fact that location is not shipped";
    assert.equal(
      stripHarmonyTokens(`${answer}We are done.${answer}`),
      answer
    );
  });

  it("unglues meta on its own line between two blocks", () => {
    assert.equal(
      stripHarmonyTokens("Draft answer\nDone.\nFinal answer"),
      "Final answer"
    );
  });
});
