/**
 * Markdown / plain text → Teams IC3 HTML.
 *
 * Desktop Teams collapses \n in messagetype=Text. Mobile often keeps them.
 * Send RichText/Html with <p>/<br> so both clients show line breaks, plus a
 * small markdown subset (bold, italic, lists, links, headings, code).
 */

import { AGENT_SENT_FOOTER } from "./imessage-mention.js";

const FOOTER_PHRASE = AGENT_SENT_FOOTER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FOOTER_RE = new RegExp(
  `^(?://[ \\t]*)?(?:${FOOTER_PHRASE})[ \\t]*$`,
  "i"
);

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeUrl(raw) {
  const url = String(raw || "").trim();
  if (!url) return "";
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) return url;
  if (url.startsWith("/") && !url.startsWith("//")) {
    return `https://yanylevin.com${url}`;
  }
  return "";
}

function trimAutolink(url) {
  return String(url || "").replace(/[),.;:!?]+$/g, "");
}

function isFenceOpen(line) {
  return /^\s*```/.test(line);
}

function isHr(line) {
  return /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

function headingMatch(line) {
  const m = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  return m ? { level: Math.min(m[1].length, 3), text: m[2] } : null;
}

function listMatch(line) {
  const ul = line.match(/^(\s*)([-*+])\s+(.+)$/);
  if (ul) return { ordered: false, indent: ul[1].length, text: ul[3] };
  const ol = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
  if (ol) {
    return {
      ordered: true,
      indent: ol[1].length,
      text: ol[3],
      start: Number(ol[2]),
    };
  }
  return null;
}

function renderInline(raw) {
  const stash = [];
  const hold = (html) => {
    const key = `\u0000${stash.length}\u0000`;
    stash.push(html);
    return key;
  };

  let s = String(raw ?? "");

  s = s.replace(/`([^`]+)`/g, (_, code) =>
    hold(`<code>${escapeHtml(code)}</code>`)
  );

  s = s.replace(
    /\[([^\]]+)\]\(((?:[^()\s]|\([^)]*\))+)(?:\s+"[^"]*")?\)/g,
    (_, label, url) => {
      const href = safeUrl(url);
      if (!href) return label;
      return hold(`<a href="${escapeHtml(href)}">${renderInline(label)}</a>`);
    }
  );

  s = escapeHtml(s);
  s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(.+?)__/g, "<strong>$1</strong>");
  s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");
  s = s.replace(
    /(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,!?:;]|$)/g,
    "$1<em>$2</em>"
  );
  s = s.replace(/(https?:\/\/[^\s<]+)/gi, (full) => {
    const decoded = full.replace(/&amp;/g, "&");
    const href = trimAutolink(decoded);
    const safe = safeUrl(href);
    if (!safe) return full;
    const trailing = decoded.slice(href.length);
    return `<a href="${escapeHtml(safe)}">${escapeHtml(href)}</a>${escapeHtml(
      trailing
    )}`;
  });

  s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => stash[Number(n)] || "");
  return s;
}

function renderList(items) {
  const ordered = items[0]?.ordered;
  const tag = ordered ? "ol" : "ul";
  const start =
    ordered && items[0].start && items[0].start !== 1
      ? ` start="${items[0].start}"`
      : "";
  const inner = items
    .map((it) => {
      const nested = it.children?.length ? renderList(it.children) : "";
      return `<li>${renderInline(it.text)}${nested}</li>`;
    })
    .join("");
  return `<${tag}${start}>${inner}</${tag}>`;
}

function nestList(rows) {
  const root = [];
  const stack = [];
  for (const row of rows) {
    const item = { ...row, children: [] };
    while (stack.length && stack[stack.length - 1].indent >= row.indent) {
      stack.pop();
    }
    if (!stack.length) root.push(item);
    else stack[stack.length - 1].children.push(item);
    stack.push(item);
  }
  return root;
}

function renderParagraph(text) {
  const lines = String(text)
    .split("\n")
    .map((line) => renderInline(line));
  const inner = lines.join("<br>");
  if (FOOTER_RE.test(String(text).trim())) {
    // Adjacent <p> tags look like one Enter on desktop. A nbsp line is the
    // extra blank iMessage gets from \n\n before the signature.
    return `<p>&nbsp;</p><p><em>${inner}</em></p>`;
  }
  return `<p>${inner}</p>`;
}

function renderBlocks(src) {
  const lines = String(src).split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isFenceOpen(line)) {
      i += 1;
      const body = [];
      while (i < lines.length && !isFenceOpen(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (isHr(line)) {
      out.push("<hr>");
      i += 1;
      continue;
    }

    const heading = headingMatch(line);
    if (heading) {
      out.push(`<h${heading.level}>${renderInline(heading.text)}</h${heading.level}>`);
      i += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${renderBlocks(quote.join("\n"))}</blockquote>`);
      continue;
    }

    const listStart = listMatch(line);
    if (listStart) {
      const rows = [];
      while (i < lines.length) {
        const m = listMatch(lines[i]);
        if (m) {
          rows.push(m);
          i += 1;
          continue;
        }
        if (
          rows.length &&
          lines[i].trim() &&
          /^\s{2,}\S/.test(lines[i]) &&
          !listMatch(lines[i])
        ) {
          rows[rows.length - 1].text += "\n" + lines[i].replace(/^\s+/, "");
          i += 1;
          continue;
        }
        break;
      }
      out.push(renderList(nestList(rows)));
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const para = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i];
      if (!next.trim()) break;
      if (isFenceOpen(next) || isHr(next) || headingMatch(next)) break;
      if (listMatch(next) || /^\s*>/.test(next)) break;
      para.push(next);
      i += 1;
    }
    out.push(renderParagraph(para.join("\n")));
  }

  return out.join("");
}

/**
 * @param {unknown} source
 */
export function markdownToTeamsHtml(source) {
  const src = String(source ?? "").replace(/\r\n/g, "\n");
  if (!src.trim()) return "";
  return renderBlocks(src);
}
