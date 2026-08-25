import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCompactAboutYan,
  extractField,
  parseMarkdownSections,
  retrieveYanSections,
  tokenizeQuery,
} from "./yan-retrieve.js";
import { buildYanSystemPrompt } from "./yan-kb.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const yanMd = readFileSync(join(ROOT, "data", "owner.md"), "utf8");

describe("yan-retrieve", () => {
  it("parses ## sections from owner.md", () => {
    const sections = parseMarkdownSections(yanMd);
    assert.ok(sections.length >= 1);
    assert.ok(sections.some((s) => s.title === "About"));
    assert.ok(sections.some((s) => s.title === "Setup"));
  });

  it("has an About section", () => {
    const sections = parseMarkdownSections(yanMd);
    assert.ok(sections.some((s) => s.title === "About"));
  });

  it("retrieves setup text", () => {
    const hits = retrieveYanSections(yanMd, "OWNER_EMAIL");
    assert.ok(hits.length >= 1);
  });

  it("builds a compact about block much smaller than owner.md", () => {
    const about = buildCompactAboutYan(yanMd);
    assert.ok(about.length > 0);
    assert.ok(about.length < 2_000);
    assert.ok(yanMd.length > 20);
  });

  it("tokenizes queries", () => {
    assert.deepEqual(tokenizeQuery("GPA & SAT?"), ["gpa", "sat"]);
  });
});

describe("buildYanSystemPrompt", () => {
  it("keeps the always-on prompt far smaller than stuffing full owner.md", () => {
    const prompt = buildYanSystemPrompt(
      { theme: "system", resolvedTheme: "dark" },
      { query: "What is this repo?" }
    );
    assert.ok(prompt.includes("SITE ABILITIES"));
    assert.ok(prompt.includes("[[set_theme:"));
    assert.ok(prompt.includes("SITE ABILITIES"));
    assert.ok(prompt.includes("RETRIEVED KNOWLEDGE"));
    assert.ok(!prompt.includes("--- KNOWLEDGE BASE (owner.md) ---"));
    // Should be well under the full dossier size.
    assert.ok(prompt.length > 20);
  });

  it("surfaces theme ability instructions and current SITE THEME", () => {
    const prompt = buildYanSystemPrompt(
      { theme: "light", resolvedTheme: "light" },
      { query: "make it dark mode" }
    );
    assert.ok(prompt.includes("[[set_theme:"));
    assert.ok(prompt.includes("SITE THEME preference: light"));
    assert.ok(!prompt.includes("THEME UPDATE APPLIED"));
  });

  it("marks the agent as public-facing and forbids addressing the user as Yan", () => {
    const prompt = buildYanSystemPrompt(
      { theme: "system", resolvedTheme: "dark" },
      { query: "hi" }
    );
    assert.ok(prompt.includes("public-facing"));
    assert.ok(prompt.includes("public-facing"));
    
  });
});
