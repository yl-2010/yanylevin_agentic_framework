/**
 * AP study packet rendering. packet.json -> fixed 8.5x11 pages laid out in
 * Chrome (so screen and print match), work.pdf + key.pdf, one PNG per page
 * at 816x1056 CSS px, and a box for every question so ink can be cropped
 * per answer. Also draws harvested ink back onto page PNGs for grading.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PAGE_W = 816;
export const PAGE_H = 1056;
export const LINE_PX = 30;
const KATEX = "https://cdn.jsdelivr.net/npm/katex@0.16.22/dist";
const ITEM_TYPES = new Set(["mcq", "short", "frq", "essay", "graph", "rating", "derivation"]);
const SECTION_KINDS = new Set(["learn", "review", "checkpoint", "diagnostic", "exam-practice"]);

// ---------------------------------------------------------------- normalize

/** @param {unknown} v @param {number} max */
function str(v, max = 4000) {
  return String(v ?? "").trim().slice(0, max);
}

/** @param {unknown} n @param {number} lo @param {number} hi @param {number} dflt */
function int(n, lo, hi, dflt) {
  const x = Math.round(Number(n));
  if (!Number.isFinite(x)) return dflt;
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Strip anything executable from a model-written SVG.
 * @param {unknown} raw
 */
export function sanitizeSvg(raw) {
  let s = String(raw || "").trim();
  if (!/^<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s)) return "";
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|xlink:href)\s*=\s*("|')\s*(javascript|data|https?):[^"']*\2/gi, "");
  return s.length > 60_000 ? "" : s;
}

/**
 * @param {any} raw
 * @param {number} n
 */
function normalizeItem(raw, n) {
  const type = ITEM_TYPES.has(raw?.type) ? raw.type : Array.isArray(raw?.choices) && raw.choices.length ? "mcq" : "short";
  const parts = Array.isArray(raw?.parts)
    ? raw.parts.slice(0, 8).map((p, i) => ({
        label: str(p?.label, 4) || String.fromCharCode(97 + i),
        prompt: str(p?.prompt),
        points: int(p?.points, 1, 20, 1),
        workLines: int(p?.workLines, 2, 40, 5),
        grid: Boolean(p?.grid),
        answer: str(p?.answer, 6000),
      }))
    : [];
  const item = {
    id: str(raw?.id, 20) || `q${n}`,
    topic: str(raw?.topic, 60),
    type,
    prompt: str(raw?.prompt, 6000),
    passageTitle: str(raw?.passageTitle, 200),
    passage: str(raw?.passage, 9000),
    lineNumbers: raw?.lineNumbers !== false,
    figureSvg: sanitizeSvg(raw?.figureSvg),
    choices: Array.isArray(raw?.choices) ? raw.choices.map((c) => str(c, 600)).filter(Boolean).slice(0, 6) : [],
    parts,
    points: int(raw?.points, 0, 30, parts.length ? parts.reduce((s, p) => s + p.points, 0) : 1),
    workLines: int(raw?.workLines, 0, 60, type === "mcq" ? 2 : type === "essay" ? 24 : 6),
    grid: Boolean(raw?.grid) || type === "graph",
    estMinutes: Math.max(0.5, Math.min(30, Number(raw?.estMinutes) || 3)),
    answer: str(raw?.answer, 8000),
    rubric: str(raw?.rubric, 4000),
    ratings: Array.isArray(raw?.ratings)
      ? raw.ratings.slice(0, 16).map((r) => ({ unitId: str(r?.unitId, 10), label: str(r?.label, 120) }))
      : [],
  };
  if (!item.prompt && !item.ratings.length) throw new Error(`item ${n} has no prompt`);
  if (type !== "rating" && !item.answer && !parts.some((p) => p.answer)) {
    throw new Error(`item ${n} has no answer`);
  }
  return item;
}

/**
 * "13.3" in a physics-2 section is "physics-2:13.3". The learner model drops bare keys.
 * @param {string} exam
 * @param {string} topic
 */
function fullKey(exam, topic) {
  return topic && exam && !topic.includes(":") ? `${exam}:${topic}` : topic;
}

/**
 * @param {any} raw packet.json from the writer
 */
export function normalizePacket(raw) {
  if (!raw || typeof raw !== "object") throw new Error("packet is not an object");
  if (typeof raw.error === "string" && raw.error.trim()) throw new Error(raw.error.trim());
  const sectionsIn = Array.isArray(raw.sections) ? raw.sections : [];
  if (!sectionsIn.length) throw new Error("packet has no sections");
  let n = 0;
  const ids = new Set();
  const sections = sectionsIn.slice(0, 8).map((s) => {
    const exam = str(s?.exam, 40);
    const items = (Array.isArray(s?.items) ? s.items : []).slice(0, 20).map((it) => {
      n += 1;
      const item = normalizeItem(it, n);
      item.topic = fullKey(exam, item.topic);
      while (ids.has(item.id)) item.id = `${item.id}x`;
      ids.add(item.id);
      return item;
    });
    return {
      exam,
      kind: SECTION_KINDS.has(s?.kind) ? s.kind : "review",
      heading: str(s?.heading, 160),
      minutes: Math.max(1, Math.min(30, Number(s?.minutes) || 5)),
      learn: (Array.isArray(s?.learn) ? s.learn : []).slice(0, 4).map((l) => ({
        topic: fullKey(exam, str(l?.topic, 60)),
        title: str(l?.title, 160),
        body: str(l?.body, 5000),
        example: l?.example
          ? { prompt: str(l.example.prompt, 2000), solution: str(l.example.solution, 4000) }
          : null,
        figureSvg: sanitizeSvg(l?.figureSvg),
      })),
      items,
    };
  });
  if (!n) throw new Error("packet has no questions");
  if (n > 40) throw new Error("packet has too many questions");
  return {
    title: str(raw.title, 140) || "AP study",
    date: str(raw.date, 10),
    subtitle: str(raw.subtitle, 200),
    sections,
  };
}

// ---------------------------------------------------------------- html

/** @param {unknown} s */
export function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Plain text with **bold**, *italic*, blank-line paragraphs. Math stays as
 * \( \) / $$ $$ for KaTeX auto-render.
 * @param {string} text
 */
export function richText(text) {
  const paras = String(text || "").split(/\n{2,}/);
  return paras
    .map((p) => {
      let h = esc(p)
        .replace(/(\d) (?=(?:[A-Za-zΩµ°]{1,3}|m\/s|eV)(?![A-Za-z]))/g, "$1&nbsp;")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
        .replace(/\n/g, "<br />");
      return `<p>${h}</p>`;
    })
    .join("");
}

/**
 * Rich text with a number or part label at the start of the first paragraph.
 * @param {string} label
 * @param {string} text
 * @param {string} [cls]
 */
function numbered(label, text, cls = "n") {
  return richText(text).replace(/^<p>/, `<p><span class="${cls}">${esc(label)}</span> `);
}

/**
 * @param {string} passage
 * @param {boolean} numbers
 */
function passageHtml(passage, numbers) {
  const lines = passage.split("\n");
  return `<div class="passage">${lines
    .map((line, i) => {
      const n = numbers && (i + 1) % 5 === 0 ? `<span class="ln">${i + 1}</span>` : "";
      return `<div class="pl">${n}${esc(line) || "&nbsp;"}</div>`;
    })
    .join("")}</div>`;
}

/**
 * Wells are blocks of ruled (or grid) lines. The paginator splits them.
 * @param {string} itemId
 * @param {string} part
 * @param {number} lines
 * @param {boolean} grid
 */
function wellHtml(itemId, part, lines, grid) {
  if (lines <= 0) return "";
  return `<div class="blk well${grid ? " grid" : ""}" data-item="${esc(itemId)}" data-part="${esc(part)}" data-lines="${lines}" style="height:${lines * LINE_PX}px"></div>`;
}

/**
 * @param {ReturnType<typeof normalizePacket>} packet
 * @param {{ curricula?: Record<string, any> }} [opts]
 */
export function renderWorkHtml(packet, opts = {}) {
  const blocks = [];
  blocks.push(`<div class="blk head" data-item="_head">
    <h1>${esc(packet.title)}</h1>
    ${packet.subtitle ? `<p class="sub">${esc(packet.subtitle)}</p>` : ""}
    <div class="times">
      <div class="tbox" data-item="_start"><span>Start</span></div>
      <div class="tbox" data-item="_finish"><span>Finish</span></div>
      <div class="tbox howit" data-item="_rating"><span>How it went, 1 rough to 5 easy</span><b>1</b><b>2</b><b>3</b><b>4</b><b>5</b></div>
    </div>
  </div>`);
  const showHeadings = packet.sections.length > 1;
  let qn = 0;
  for (const s of packet.sections) {
    const exam = opts.curricula?.[s.exam]?.short || s.exam;
    if (showHeadings) blocks.push(`<div class="blk sec" data-keep="1"><h2>${esc(s.heading || exam)}</h2></div>`);
    for (const l of s.learn) {
      blocks.push(`<div class="blk learn" data-learn="${esc(l.topic)}">
        <div class="learn-tag">Learn</div><h3>${esc(l.title)}</h3>
        ${richText(l.body)}
        ${l.figureSvg ? `<div class="fig">${l.figureSvg}</div>` : ""}
        ${l.example ? `<div class="example"><div class="ex-tag">Worked example</div>${richText(l.example.prompt)}<div class="sol">${richText(l.example.solution)}</div></div>` : ""}
      </div>`);
    }
    for (const it of s.items) {
      qn += 1;
      if (it.type === "rating") {
        blocks.push(`<div class="blk item rating" data-item="${esc(it.id)}">
          <div class="prompt">${numbered(`${qn}.`, "Circle one per unit. 1 = never studied it, 5 = could teach it.")}</div>
          <table class="rate">${it.ratings
            .map(
              (r) =>
                `<tr data-item="${esc(it.id)}" data-part="${esc(r.unitId)}"><td class="rl">${esc(r.label)}</td>${[1, 2, 3, 4, 5]
                  .map((v) => `<td class="rc"><span>${v}</span></td>`)
                  .join("")}</tr>`
            )
            .join("")}</table>
        </div>`);
        continue;
      }
      const head = [];
      if (it.passage) {
        head.push(
          `<div class="blk pass" data-item="${esc(it.id)}" data-keep="1">${it.passageTitle ? `<div class="pt">${esc(it.passageTitle)}</div>` : ""}${passageHtml(it.passage, it.lineNumbers)}</div>`
        );
      }
      head.push(`<div class="blk item" data-item="${esc(it.id)}" data-keep="1">
        <div class="q-row"><div class="prompt">${numbered(`${qn}.`, it.prompt)}</div><div class="pts">${it.points && !it.parts.length ? `${it.points} pt${it.points === 1 ? "" : "s"}` : ""}</div></div>
        ${it.figureSvg ? `<div class="fig">${it.figureSvg}</div>` : ""}
        ${it.choices.length ? `<ol class="choices" type="A">${it.choices.map((c) => `<li>${richText(c)}</li>`).join("")}</ol>` : ""}
      </div>`);
      blocks.push(...head);
      if (it.parts.length) {
        for (const p of it.parts) {
          blocks.push(
            `<div class="blk part" data-item="${esc(it.id)}" data-part="${esc(p.label)}" data-keep="1"><div class="q-row"><div class="prompt">${numbered(`(${p.label})`, p.prompt, "pl-label")}</div><div class="pts">${p.points} pt${p.points === 1 ? "" : "s"}</div></div></div>`
          );
          blocks.push(wellHtml(it.id, p.label, p.workLines, p.grid));
        }
      } else {
        blocks.push(wellHtml(it.id, "", it.workLines, it.grid));
      }
    }
  }
  blocks.push(`<div class="blk notes" data-item="_notes"><div class="nl">Note for tomorrow's packet</div></div>`);
  return pageShell(packet.title, blocks.join("\n"), "work");
}

/**
 * Compact key: prompt, answer, rubric. No writing space.
 * @param {ReturnType<typeof normalizePacket>} packet
 * @param {{ curricula?: Record<string, any>, feedback?: Record<string, string> }} [opts]
 */
export function renderKeyHtml(packet, opts = {}) {
  const blocks = [];
  blocks.push(`<div class="blk head"><h1>Key: ${esc(packet.title)}</h1></div>`);
  const showHeadings = packet.sections.length > 1;
  let qn = 0;
  for (const s of packet.sections) {
    const exam = opts.curricula?.[s.exam]?.short || s.exam;
    if (showHeadings) blocks.push(`<div class="blk sec" data-keep="1"><h2>${esc(s.heading || exam)}</h2></div>`);
    for (const it of s.items) {
      qn += 1;
      if (it.type === "rating") continue;
      const fb = opts.feedback?.[it.id];
      const answer = it.parts.length
        ? it.parts.map((p) => `<div class="kp">${numbered(`(${p.label})`, p.answer, "pl-label")}</div>`).join("")
        : richText(it.answer);
      blocks.push(`<div class="blk kitem">
        <div class="kq">${numbered(`${qn}.`, it.prompt.length > 600 ? `${it.prompt.slice(0, 600)}...` : it.prompt)}</div>
        ${it.choices.length ? `<ol class="choices" type="A">${it.choices.map((c) => `<li>${richText(c)}</li>`).join("")}</ol>` : ""}
        <div class="ka">${answer}</div>
        ${it.rubric ? `<div class="kr"><div class="klabel">Rubric</div>${richText(it.rubric)}</div>` : ""}
        ${fb ? `<div class="kf"><div class="klabel">Your work</div>${richText(fb)}</div>` : ""}
      </div>`);
    }
  }
  return pageShell(`Key: ${packet.title}`, blocks.join("\n"), "key");
}

/**
 * @param {string} title
 * @param {string} flow
 * @param {"work"|"key"} mode
 */
function pageShell(title, flow, mode) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>${esc(title)}</title>
<link rel="stylesheet" href="${KATEX}/katex.min.css" />
<script src="${KATEX}/katex.min.js"></script>
<script src="${KATEX}/contrib/auto-render.min.js"></script>
<style>
  @page { size: 8.5in 11in; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { color: #16181b; font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; font-size: 14.5px; line-height: 1.42; }
  #flow { position: absolute; left: -10000px; top: 0; width: 720px; }
  .page { position: relative; width: ${PAGE_W}px; height: ${PAGE_H}px; overflow: hidden; break-after: page; page-break-after: always; background: #fff; }
  .page:last-child { break-after: auto; page-break-after: auto; }
  .body { position: absolute; left: 48px; top: 44px; width: 720px; }
  .pfoot { position: absolute; left: 48px; right: 48px; bottom: 22px; font: 11px "Helvetica Neue", Arial, sans-serif; color: #7a828c; text-align: right; }
  .blk { padding-bottom: 10px; }
  p { margin: 0 0 6px; }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; font-weight: 600; }
  h2 { font-size: 16px; margin: 0; font-weight: 600; }
  h3 { font-size: 15px; margin: 2px 0 6px; font-weight: 600; }
  .sub { color: #3b4249; margin-top: 4px; }
  .head { border-bottom: 1.5px solid #1f6f78; padding-bottom: 12px; margin-bottom: 12px; }
  .times { display: flex; gap: 14px; align-items: center; margin-top: 10px; }
  .tbox { width: 150px; height: 46px; border: 1.5px solid #3b4249; border-radius: 6px; position: relative; }
  .tbox span { position: absolute; left: 8px; top: 3px; font: 11px "Helvetica Neue", Arial, sans-serif; color: #59616b; }
  .tbox.howit { width: auto; flex: 1; display: flex; justify-content: flex-end; align-items: flex-end; gap: 12px; padding: 0 12px 5px 0; }
  .tbox.howit b { display: inline-block; width: 26px; height: 26px; line-height: 24px; text-align: center; border: 1.3px solid #59616b; border-radius: 50%; font: 12px "Helvetica Neue", Arial, sans-serif; }
  .sec { border-bottom: 1.5px solid #1f6f78; padding-top: 10px; margin-bottom: 8px; }
  .learn { background: #f2f7f7; border-left: 4px solid #1f6f78; padding: 10px 14px 10px; margin-bottom: 10px; }
  .learn-tag, .ex-tag { font: 600 10.5px "Helvetica Neue", Arial, sans-serif; letter-spacing: 0.08em; text-transform: uppercase; color: #1f6f78; }
  .example { margin-top: 8px; padding-top: 6px; border-top: 1px dashed #9dbfc2; }
  .sol { margin-top: 4px; padding-left: 10px; border-left: 2px solid #c8dcde; }
  .q-row { display: flex; gap: 12px; align-items: flex-start; }
  .prompt { flex: 1; }
  .prompt p:last-child { margin-bottom: 0; }
  .n { font-weight: 600; font-variant-numeric: tabular-nums; }
  .pl-label { font-weight: 600; }
  .pts { white-space: nowrap; font: 12px "Helvetica Neue", Arial, sans-serif; color: #59616b; padding-top: 2px; }
  .choices { margin: 6px 0 0 26px; padding: 0; }
  .choices li { margin: 3px 0; padding-left: 4px; }
  .choices li p { margin: 0; }
  .part { padding-left: 18px; padding-top: 2px; }
  .well { margin: 0; background-image: repeating-linear-gradient(to bottom, transparent 0, transparent ${LINE_PX - 1}px, #c3ccd5 ${LINE_PX - 1}px, #c3ccd5 ${LINE_PX}px); padding-bottom: 0; margin-bottom: 12px; }
  .well.grid { background-image: linear-gradient(#dfe5ea 1px, transparent 1px), linear-gradient(90deg, #dfe5ea 1px, transparent 1px); background-size: 20px 20px; border: 1px solid #c3ccd5; }
  .fig { margin: 8px 0; text-align: center; }
  .fig svg { max-width: 100%; height: auto; max-height: 340px; }
  .pass { border: 1px solid #d5dbe1; padding: 10px 12px 10px 40px; margin-bottom: 8px; font-size: 13.5px; line-height: 1.5; }
  .pt { font-weight: 600; margin-bottom: 4px; margin-left: -28px; }
  .pl { position: relative; white-space: pre-wrap; }
  .ln { position: absolute; left: -30px; width: 22px; text-align: right; font: 10px "Helvetica Neue", Arial, sans-serif; color: #7a828c; top: 3px; }
  .rate { width: 100%; border-collapse: collapse; margin-top: 6px; }
  .rate td { border-bottom: 1px solid #e3e7eb; padding: 7px 4px; }
  .rate .rl { width: 60%; }
  .rate .rc { text-align: center; }
  .rate .rc span { display: inline-block; width: 30px; height: 30px; line-height: 28px; border: 1.3px solid #59616b; border-radius: 50%; font: 13px "Helvetica Neue", Arial, sans-serif; }
  .notes { height: 110px; border: 1.3px dashed #9aa3ad; border-radius: 6px; position: relative; padding: 0; margin-bottom: 4px; }
  .notes .nl { position: absolute; left: 10px; top: 6px; font: 11.5px "Helvetica Neue", Arial, sans-serif; color: #59616b; }
  .kitem { border-bottom: 1px solid #e3e7eb; padding: 8px 0 10px; }
  .kq { color: #3b4249; font-size: 13.5px; }
  .ka { margin-top: 6px; padding: 8px 12px; background: #f2f7f7; border-left: 3px solid #1f6f78; }
  .kp { margin-bottom: 4px; }
  .kr, .kf { margin-top: 6px; font-size: 13px; padding-left: 12px; border-left: 3px solid #d5dbe1; }
  .kf { border-left-color: #c47a2c; }
  .klabel { display: block; font: 600 10.5px "Helvetica Neue", Arial, sans-serif; letter-spacing: 0.08em; text-transform: uppercase; color: #59616b; }
  .katex-display { margin: 6px 0; }
</style></head>
<body data-mode="${mode}">
<div id="pages"></div>
<div id="flow">${flow}</div>
<script>
window.__paginate = async function () {
  try {
    if (window.renderMathInElement) {
      renderMathInElement(document.getElementById("flow"), {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\\\[", right: "\\\\]", display: true },
          { left: "\\\\(", right: "\\\\)", display: false },
        ],
        throwOnError: false,
      });
    }
  } catch (e) {}
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const LINE = ${LINE_PX};
  const CONTENT_H = ${PAGE_H} - 44 - 56;
  const pagesEl = document.getElementById("pages");
  const flow = document.getElementById("flow");
  let body = null;
  let used = 0;
  function newPage() {
    const page = document.createElement("div");
    page.className = "page";
    body = document.createElement("div");
    body.className = "body";
    page.appendChild(body);
    pagesEl.appendChild(page);
    used = 0;
  }
  function h(el) { return el.getBoundingClientRect().height; }
  newPage();
  const queue = Array.from(flow.children);
  let guard = 0;
  while (queue.length && guard++ < 2000) {
    const b = queue.shift();
    body.appendChild(b);
    const bh = h(b);
    if (used + bh <= CONTENT_H + 0.5) { used += bh; continue; }
    if (b.classList.contains("notes") && CONTENT_H - used - 12 >= 70) {
      b.style.height = (CONTENT_H - used - 12) + "px";
      used = CONTENT_H;
      continue;
    }
    if (b.classList.contains("well")) {
      const lines = Number(b.dataset.lines);
      const room = Math.floor((CONTENT_H - used - 12) / LINE);
      if (room >= 2 && lines - room >= 2) {
        b.dataset.lines = String(room);
        b.style.height = room * LINE + "px";
        used = CONTENT_H;
        const rest = b.cloneNode(false);
        rest.dataset.lines = String(lines - room);
        rest.style.height = (lines - room) * LINE + "px";
        rest.dataset.cont = "1";
        queue.unshift(rest);
        continue;
      }
    }
    body.removeChild(b);
    const moved = [];
    while (body.lastElementChild && body.lastElementChild.dataset.keep === "1") {
      const last = body.lastElementChild;
      moved.unshift(last);
      body.removeChild(last);
    }
    if (!body.children.length && !moved.length) {
      body.appendChild(b);
      newPage();
      continue;
    }
    if (!body.children.length) {
      for (const m of moved) body.appendChild(m);
      body.appendChild(b);
      newPage();
      continue;
    }
    newPage();
    queue.unshift(b);
    for (let i = moved.length - 1; i >= 0; i--) queue.unshift(moved[i]);
  }
  const pages = Array.from(pagesEl.children).filter((p) => p.querySelector(".body").children.length);
  for (const p of Array.from(pagesEl.children)) if (!pages.includes(p)) p.remove();
  const total = pages.length;
  pages.forEach((p, i) => {
    const f = document.createElement("div");
    f.className = "pfoot";
    f.textContent = (i + 1) + " / " + total;
    p.appendChild(f);
  });
  const boxes = {};
  pages.forEach((p, pageIndex) => {
    const pr = p.getBoundingClientRect();
    p.querySelectorAll("[data-item]").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const item = el.dataset.item;
      const part = el.dataset.part || "";
      const key = item + "|" + part + "|" + pageIndex;
      const box = { item, part, page: pageIndex, x: r.left - pr.left, y: r.top - pr.top, width: r.width, height: r.height };
      const prev = boxes[key];
      if (!prev) { boxes[key] = box; return; }
      const x0 = Math.min(prev.x, box.x), y0 = Math.min(prev.y, box.y);
      const x1 = Math.max(prev.x + prev.width, box.x + box.width), y1 = Math.max(prev.y + prev.height, box.y + box.height);
      boxes[key] = { ...prev, x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    });
  });
  const learn = [];
  pages.forEach((p, pageIndex) => p.querySelectorAll("[data-learn]").forEach((el) => learn.push({ topic: el.dataset.learn, page: pageIndex })));
  return { pages: total, boxes: Object.values(boxes), learn };
};
</script>
</body></html>`;
}

// ---------------------------------------------------------------- chrome

async function launch() {
  const { chromium } = await import("playwright-core");
  return chromium.launch({ channel: "chrome", headless: true });
}

/**
 * Lay out, screenshot each page, print the PDF.
 * @param {string} html
 * @param {string} outDir
 * @param {string} prefix "page" or "key"
 * @param {string} pdfName
 */
export async function printPages(html, outDir, prefix, pdfName) {
  await mkdir(outDir, { recursive: true });
  const htmlPath = join(outDir, `${prefix}.html`);
  await writeFile(htmlPath, html);
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: PAGE_W, height: PAGE_H }, deviceScaleFactor: 2 });
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle", timeout: 60_000 });
    const layout = await page.evaluate(() => /** @type {any} */ (window).__paginate());
    const handles = await page.$$("#pages > .page");
    /** @type {string[]} */
    const pngs = [];
    for (let i = 0; i < handles.length; i++) {
      const path = join(outDir, `${prefix}-${i + 1}.png`);
      await handles[i].screenshot({ path });
      pngs.push(path);
    }
    for (const name of await readdir(outDir)) {
      const m = name.match(new RegExp(`^${prefix}-(\\d+)\\.png$`));
      if (m && Number(m[1]) > handles.length) await rm(join(outDir, name), { force: true });
    }
    const pdfPath = join(outDir, pdfName);
    await page.emulateMedia({ media: "print" });
    await page.pdf({ path: pdfPath, width: "8.5in", height: "11in", printBackground: true, margin: { top: "0", right: "0", bottom: "0", left: "0" } });
    return { pngs, pdfPath, boxes: layout.boxes, learn: layout.learn, pageCount: layout.pages };
  } finally {
    await browser.close();
  }
}

/**
 * Work pages + key pages for one packet folder.
 * @param {ReturnType<typeof normalizePacket>} packet
 * @param {string} dayDir
 * @param {{ curricula?: Record<string, any> }} [opts]
 */
export async function renderPacket(packet, dayDir, opts = {}) {
  const pagesDir = join(dayDir, "pages");
  const work = await printPages(renderWorkHtml(packet, opts), pagesDir, "page", "work.pdf");
  const key = await printPages(renderKeyHtml(packet, opts), pagesDir, "key", "key.pdf");
  await writeFile(
    join(dayDir, "boxes.json"),
    JSON.stringify({ pageWidth: PAGE_W, pageHeight: PAGE_H, pages: work.pageCount, boxes: work.boxes, learn: work.learn }, null, 2)
  );
  return { work, key };
}

/**
 * Key pages with per-question feedback, for the morning-after page.
 * @param {ReturnType<typeof normalizePacket>} packet
 * @param {string} dayDir
 * @param {Record<string, string>} feedback item id -> note
 * @param {{ curricula?: Record<string, any> }} [opts]
 */
export async function renderFeedbackKey(packet, dayDir, feedback, opts = {}) {
  return printPages(renderKeyHtml(packet, { ...opts, feedback }), join(dayDir, "pages"), "feedback", "key-feedback.pdf");
}

// ---------------------------------------------------------------- ink overlay

/**
 * Draw ink on each work page and crop each answer box.
 * pages: [{ png, strokes: [{ color, widthPx, points }] }] in page px.
 * @param {{ png: string, strokes: { color: string, widthPx: number, points: [number, number][] }[] }[]} pages
 * @param {{ item: string, part: string, page: number, x: number, y: number, width: number, height: number }[]} boxes
 * @param {string} outDir
 */
export async function renderInk(pages, boxes, outDir) {
  await mkdir(outDir, { recursive: true });
  const browser = await launch();
  /** @type {{ pages: string[], crops: { item: string, part: string, page: number, path: string, strokes: number }[] }} */
  const out = { pages: [], crops: [] };
  try {
    const tab = await browser.newPage({ viewport: { width: PAGE_W, height: PAGE_H }, deviceScaleFactor: 2 });
    for (let i = 0; i < pages.length; i++) {
      const png = await readFile(pages[i].png);
      const paths = pages[i].strokes
        .map((s) => {
          const d = s.points.map(([x, y], j) => `${j ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
          const dot = s.points.length === 1 ? ` L${(s.points[0][0] + 0.5).toFixed(1)} ${s.points[0][1].toFixed(1)}` : "";
          return `<path d="${d}${dot}" stroke="${esc(s.color)}" stroke-width="${s.widthPx.toFixed(2)}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
        })
        .join("");
      await tab.setContent(
        `<html><body style="margin:0"><div style="position:relative;width:${PAGE_W}px;height:${PAGE_H}px"><img src="data:image/png;base64,${png.toString("base64")}" style="position:absolute;left:0;top:0;width:${PAGE_W}px;height:${PAGE_H}px"/><svg width="${PAGE_W}" height="${PAGE_H}" viewBox="0 0 ${PAGE_W} ${PAGE_H}" style="position:absolute;left:0;top:0">${paths}</svg></div></body></html>`
      );
      const pagePath = join(outDir, `ink-page-${i + 1}.png`);
      await tab.screenshot({ path: pagePath, clip: { x: 0, y: 0, width: PAGE_W, height: PAGE_H } });
      out.pages.push(pagePath);
      for (const b of boxes.filter((x) => x.page === i)) {
        const { strokesInBox } = await import("./onenote-ink.js");
        const count = strokesInBox(pages[i].strokes, b).length;
        const pad = 10;
        const x = Math.max(0, b.x - pad);
        const y = Math.max(0, b.y - pad);
        const clip = {
          x,
          y,
          width: Math.min(PAGE_W - x, b.width + pad * 2),
          height: Math.min(PAGE_H - y, b.height + pad * 2),
        };
        const name = `${b.item}${b.part ? `-${b.part}` : ""}-p${i + 1}`.replace(/[^\w.-]/g, "_");
        const path = join(outDir, `${name}.png`);
        if (count > 0 || b.item.startsWith("_")) await tab.screenshot({ path, clip });
        out.crops.push({ item: b.item, part: b.part, page: i, path: count > 0 || b.item.startsWith("_") ? path : "", strokes: count });
      }
    }
  } finally {
    await browser.close();
  }
  return out;
}
