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

  it("keeps $10 and $20 as money, not math", () => {
    const html = render("It costs $10 and $20 today.");
    assert.match(html, /\$10/);
    assert.match(html, /\$20/);
    assert.doesNotMatch(html, /md-math/);
  });

  it("renders $x^2$ as math without turning the caret into superscript", () => {
    const html = render("Area is $x^2$ plus E=mc^2^.");
    assert.match(html, /<span class="md-math">x\^2<\/span>/);
    assert.match(html, /<sup>2<\/sup>/);
  });

  it("leaves math inside code fences alone", () => {
    const html = render("```\n$x^2$\n```");
    assert.match(html, /<pre><code>/);
    assert.doesNotMatch(html, /md-math/);
  });

  it("renders a $$ block as its own display plate, not inside the paragraph", () => {
    const html = render(
      ["The integral is", "", "$$", "\\frac{1}{a}\\int\\frac{1}{\\sin^3 b}\\,db", "$$", "", "The power is too high."].join(
        "\n"
      )
    );
    assert.match(html, /<p>The integral is<\/p>/);
    assert.match(html, /<div class="md-math-block">\\frac\{1\}\{a\}\\int\\frac\{1\}\{\\sin\^3 b\}/);
    assert.match(html, /<p>The power is too high\.<\/p>/);
    assert.doesNotMatch(html, /<br>/);
  });

  it("stacks one equation per line inside a display block", () => {
    const html = render(["$$", "x = a\\tan b", "dx = a\\sec^2 b\\, db", "$$"].join("\n"));
    assert.match(html, /<div class="md-math-block">\\begin\{gathered\}/);
    assert.match(html, /x = a\\tan b \\\\/);
    assert.match(html, /dx = a\\sec\^2 b/);
    assert.match(html, /\\end\{gathered\}/);
  });

  it("leaves an aligned environment alone", () => {
    const html = render(["$$", "\\begin{aligned}", "x &= 1 \\\\", "\\end{aligned}", "$$"].join("\n"));
    assert.match(html, /\\begin\{aligned\}/);
    assert.doesNotMatch(html, /gathered/);
  });

  it("renders \\(...\\) inline and \\[...\\] as a display block", () => {
    const inline = render("With \\(x = a\\tan b\\), it becomes that.");
    assert.match(inline, /<span class="md-math">x = a\\tan b<\/span>/);
    assert.doesNotMatch(inline, /md-math-block/);
    const block = render(["\\[", "\\int_0^1 x\\,dx", "\\]"].join("\n"));
    assert.match(block, /<div class="md-math-block">\\int_0\^1 x/);
  });

  it("does not treat backticked latex as math", () => {
    const html = render("`\\\\(x\\\\)` and `\\frac{1}{a}`");
    assert.doesNotMatch(html, /md-math/);
    assert.match(html, /<code>/);
  });

  it("renders a math fence as a display block", () => {
    const html = render("```math\n\\frac{1}{a}\n```");
    assert.match(html, /<div class="md-math-block">\\frac\{1\}\{a\}<\/div>/);
    assert.doesNotMatch(html, /<pre>/);
  });

  it("does not swallow the rest of the message when $$ is unclosed", () => {
    const html = render("$$\nhello");
    assert.match(html, /hello/);
    assert.doesNotMatch(html, /md-math/);
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
