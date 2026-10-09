import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markdownToTeamsHtml } from "./teams-format.js";

describe("markdownToTeamsHtml", () => {
  it("wraps a single line in a paragraph", () => {
    assert.equal(markdownToTeamsHtml("On it"), "<p>On it</p>");
  });

  it("turns single newlines into <br> so desktop Teams keeps them", () => {
    assert.equal(
      markdownToTeamsHtml("Hello\nWorld"),
      "<p>Hello<br>World</p>"
    );
  });

  it("turns blank lines into separate paragraphs", () => {
    assert.equal(
      markdownToTeamsHtml("Hello\n\nWorld"),
      "<p>Hello</p><p>World</p>"
    );
  });

  it("renders bold, italic, strike, and inline code", () => {
    const html = markdownToTeamsHtml("**bold** *italic* ~~gone~~ `code`");
    assert.equal(
      html,
      "<p><strong>bold</strong> <em>italic</em> <s>gone</s> <code>code</code></p>"
    );
  });

  it("renders lists and headings", () => {
    const html = markdownToTeamsHtml(
      ["# Title", "", "- one", "- two", "", "1. first"].join("\n")
    );
    assert.equal(
      html,
      "<h1>Title</h1><ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>"
    );
  });

  it("renders links and autolinks, rewriting /education paths", () => {
    const html = markdownToTeamsHtml(
      "[todo](/education/todo/essay) and https://example.com."
    );
    assert.match(
      html,
      /href="https:\/\/yanylevin.com\/education\/todo\/essay"/
    );
    assert.match(html, /href="https:\/\/example.com"/);
  });

  it("escapes raw HTML instead of passing it through", () => {
    const html = markdownToTeamsHtml(`<script>alert(1)</script>`);
    assert.equal(html.includes("<script>"), false);
    assert.match(html, /&lt;script&gt;/);
  });

  it("drops javascript: links", () => {
    const html = markdownToTeamsHtml("[x](javascript:alert(1))");
    assert.equal(html.includes("javascript:"), false);
    assert.match(html, />x</);
  });

  it("keeps fenced code as pre/code", () => {
    const html = markdownToTeamsHtml("```\nconst x = 1;\n```");
    assert.equal(html, "<pre><code>const x = 1;</code></pre>");
  });

  it("puts a blank line before the italic Teams agent footer", () => {
    const html = markdownToTeamsHtml(
      "On it\n\n// Sent by Yan's Personal Agent"
    );
    assert.equal(
      html,
      "<p>On it</p><p>&nbsp;</p><p><em>// Sent by Yan's Personal Agent</em></p>"
    );
  });

  it("italicizes the Alex agent footer the same way", () => {
    const html = markdownToTeamsHtml(
      "On it\n\n// Sent by Alex's Personal Agent"
    );
    assert.equal(
      html,
      "<p>On it</p><p>&nbsp;</p><p><em>// Sent by Alex's Personal Agent</em></p>"
    );
  });
});
