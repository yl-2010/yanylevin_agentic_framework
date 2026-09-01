import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { render } = require("../education/markdown.js");

describe("YLMarkdown.render", () => {
  it("escapes raw HTML", () => {
    const html = render(`<script>alert(1)</script>`);
    assert.equal(html.includes("<script>"), false);
    assert.match(html, /&lt;script&gt;/);
  });

  it("renders bold, italic, code, and links", () => {
    const html = render(`**bold** *italic* \`code\` [hi](https://example.com)`);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<em>italic<\/em>/);
    assert.match(html, /<code>code<\/code>/);
    assert.match(html, /href="https:\/\/example.com"/);
    assert.match(html, /rel="noopener noreferrer"/);
  });

  it("keeps /education links in-app without a new tab", () => {
    const html = render(`[todo](/education/todo/essay?class=am-lit)`);
    assert.match(html, /href="\/education\/todo\/essay\?class=am-lit"/);
    assert.doesNotMatch(html, /target="_blank"/);
  });

  it("drops javascript: links", () => {
    const html = render(`[x](javascript:alert(1))`);
    assert.equal(html.includes("javascript:"), false);
    assert.match(html, />x</);
  });

  it("keeps plain newlines as breaks", () => {
    const html = render("Hello\nWorld");
    assert.match(html, /Hello<br>World/);
  });

  it("renders strikethrough, tasks, autolinks, sub/sup, and footnotes", () => {
    const html = render(
      [
        "~~gone~~",
        "",
        "- [x] Checked task",
        "- [ ] Open task",
        "",
        "See https://github.com and H~2~O plus E=mc^2^.",
        "",
        "A marker[^1] here.",
        "",
        "[^1]: Footnote body.",
      ].join("\n")
    );
    assert.match(html, /<del>gone<\/del>/);
    assert.match(html, /checkbox/);
    assert.match(html, /checked/);
    assert.match(html, /href="https:\/\/github.com"/);
    assert.match(html, /<sub>2<\/sub>/);
    assert.match(html, /<sup>2<\/sup>/);
    assert.match(html, /md-fn/);
    assert.match(html, /Footnote body/);
  });

  it("renders headings, lists, fences, and tables", () => {
    const html = render(
      [
        "# Title",
        "",
        "- one",
        "- two",
        "",
        "```js",
        "const x = 1;",
        "```",
        "",
        "| A | B |",
        "| --- | --- |",
        "| 1 | 2 |",
      ].join("\n")
    );
    assert.match(html, /<h1>Title<\/h1>/);
    assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
    assert.match(html, /<pre><code class="language-js">const x = 1;<\/code><\/pre>/);
    assert.match(html, /<th>A<\/th>/);
    assert.match(html, /<td>1<\/td>/);
  });
});
