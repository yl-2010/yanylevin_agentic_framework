/**
 * Personal Agent markdown → safe HTML.
 * No raw HTML passthrough. Used by /education chat + object descriptions.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.YLMarkdown = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function escapeHtml(s) {
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
    if (url.startsWith("/") && !url.startsWith("//")) return url;
    return "";
  }

  function trimAutolink(url) {
    return String(url || "").replace(/[),.;:!?]+$/g, "");
  }

  /**
   * @param {string} raw
   * @param {{ footnoteOrder: string[], footnoteIds: Set<string> }} ctx
   */
  function renderInline(raw, ctx) {
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

    s = s.replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^)]*\))+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => {
      const href = safeUrl(url);
      if (!href) return alt || "";
      return hold(
        `<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}" loading="lazy">`
      );
    });

    s = s.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^)]*\))+)(?:\s+"[^"]*")?\)/g, (_, label, url) => {
      const href = safeUrl(url);
      if (!href) return label;
      const internal = href.startsWith("/education");
      const extra = internal
        ? ""
        : ' target="_blank" rel="noopener noreferrer"';
      return hold(
        `<a href="${escapeHtml(href)}"${extra}>${renderInline(label, ctx)}</a>`
      );
    });

    s = s.replace(/\[\^([^\]]+)\]/g, (_, id) => {
      const key = String(id);
      if (!ctx.footnoteIds.has(key)) return `[^${id}]`;
      if (!ctx.footnoteOrder.includes(key)) ctx.footnoteOrder.push(key);
      const n = ctx.footnoteOrder.indexOf(key) + 1;
      return hold(
        `<sup class="md-fn"><a href="#md-fn-${escapeHtml(key)}">${n}</a></sup>`
      );
    });

    s = escapeHtml(s);
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__(.+?)__/g, "<strong>$1</strong>");
    s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");
    s = s.replace(
      /(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,!?:;]|$)/g,
      "$1<em>$2</em>"
    );
    s = s.replace(/~([^~\s](?:[^~]*[^~\s])?)~/g, "<sub>$1</sub>");
    s = s.replace(/\^([^\s^]+)\^/g, "<sup>$1</sup>");
    s = s.replace(/(https?:\/\/[^\s<]+)/gi, (full) => {
      const decoded = full.replace(/&amp;/g, "&");
      const href = trimAutolink(decoded);
      const safe = safeUrl(href);
      if (!safe) return full;
      const trailing = decoded.slice(href.length);
      return `<a href="${escapeHtml(
        safe
      )}" target="_blank" rel="noopener noreferrer">${escapeHtml(href)}</a>${escapeHtml(
        trailing
      )}`;
    });

    s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => stash[Number(n)] || "");
    return s;
  }

  function isFenceOpen(line) {
    return /^\s*```/.test(line);
  }

  function isHr(line) {
    return /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
  }

  function headingMatch(line) {
    const m = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    return m ? { level: m[1].length, text: m[2] } : null;
  }

  function listMatch(line) {
    const ul = line.match(/^(\s*)([-*+])\s+(.+)$/);
    if (ul) {
      return { ordered: false, indent: ul[1].length, text: ul[3] };
    }
    const ol = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (ol) {
      return { ordered: true, indent: ol[1].length, text: ol[3], start: Number(ol[2]) };
    }
    return null;
  }

  function taskMatch(text) {
    const m = String(text).match(/^\[([ xX])\]\s+([\s\S]*)$/);
    if (!m) return null;
    return { checked: m[1] !== " ", text: m[2] };
  }

  function isTableSep(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
  }

  function splitTableRow(line) {
    let s = String(line).trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  }

  function renderTable(headerLine, rows, ctx) {
    const headers = splitTableRow(headerLine);
    const head = headers
      .map((c) => `<th>${renderInline(c, ctx)}</th>`)
      .join("");
    const body = rows
      .map((row) => {
        const cells = splitTableRow(row);
        while (cells.length < headers.length) cells.push("");
        return `<tr>${cells
          .slice(0, headers.length)
          .map((c) => `<td>${renderInline(c, ctx)}</td>`)
          .join("")}</tr>`;
      })
      .join("");
    return `<div class="md-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function renderList(items, ctx) {
    const ordered = items[0]?.ordered;
    const tag = ordered ? "ol" : "ul";
    const start =
      ordered && items[0].start && items[0].start !== 1
        ? ` start="${items[0].start}"`
        : "";
    const inner = items
      .map((it) => {
        const nested = it.children?.length ? renderList(it.children, ctx) : "";
        const task = taskMatch(it.text);
        if (task) {
          return `<li class="md-task"><label><input type="checkbox" disabled${
            task.checked ? " checked" : ""
          }><span>${renderInline(task.text, ctx)}</span></label>${nested}</li>`;
        }
        return `<li>${renderInline(it.text, ctx)}${nested}</li>`;
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

  function renderParagraph(text, ctx) {
    const lines = String(text)
      .split("\n")
      .map((line) => renderInline(line, ctx));
    return `<p>${lines.join("<br>")}</p>`;
  }

  function extractFootnotes(src) {
    const defs = new Map();
    const body = [];
    for (const line of String(src).split("\n")) {
      const m = line.match(/^\s*\[\^([^\]]+)\]:\s*(.*)$/);
      if (m) {
        defs.set(m[1], m[2]);
        continue;
      }
      body.push(line);
    }
    return { body: body.join("\n"), defs };
  }

  function renderBlocks(src, ctx) {
    const lines = String(src).split("\n");
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (isFenceOpen(line)) {
        const lang = line.replace(/^\s*```/, "").trim();
        i += 1;
        const body = [];
        while (i < lines.length && !isFenceOpen(lines[i])) {
          body.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
        const cls = lang ? ` class="language-${escapeHtml(lang.split(/\s+/)[0])}"` : "";
        out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
        continue;
      }

      if (isHr(line)) {
        out.push("<hr>");
        i += 1;
        continue;
      }

      const heading = headingMatch(line);
      if (heading) {
        const tag = `h${heading.level}`;
        out.push(`<${tag}>${renderInline(heading.text, ctx)}</${tag}>`);
        i += 1;
        continue;
      }

      if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const header = line;
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          rows.push(lines[i]);
          i += 1;
        }
        out.push(renderTable(header, rows, ctx));
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ""));
          i += 1;
        }
        out.push(`<blockquote>${renderBlocks(quote.join("\n"), ctx)}</blockquote>`);
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
            rows[rows.length - 1].text +=
              "\n" + lines[i].replace(/^\s+/, "");
            i += 1;
            continue;
          }
          break;
        }
        out.push(renderList(nestList(rows), ctx));
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
        if (next.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
          break;
        }
        para.push(next);
        i += 1;
      }
      out.push(renderParagraph(para.join("\n"), ctx));
    }

    return out.join("");
  }

  function render(source) {
    const src = String(source ?? "").replace(/\r\n/g, "\n");
    if (!src.trim()) return "";
    const extracted = extractFootnotes(src);
    const ctx = {
      footnoteOrder: [],
      footnoteIds: new Set(extracted.defs.keys()),
    };
    let html = renderBlocks(extracted.body, ctx);
    if (ctx.footnoteOrder.length) {
      const items = ctx.footnoteOrder
        .map((id) => {
          const body = extracted.defs.get(id) || "";
          return `<li id="md-fn-${escapeHtml(id)}">${renderInline(body, ctx)}</li>`;
        })
        .join("");
      html += `<ol class="md-footnotes">${items}</ol>`;
    }
    return html;
  }

  return { render, escapeHtml };
});
