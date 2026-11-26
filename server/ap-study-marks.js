/**
 * Red teacher marks on a graded packet page. The grader writes one note per
 * answer box ("0/2 | work on gas is −PΔV | gas expands, so −400 J"). This
 * module splits it into a score beside the box's points label and short
 * comments placed in blank space right after his ink in that box.
 *
 * All geometry is in page px (816 x 1056), the space boxes.json uses.
 */

export const CELL = 4;
const PAGE_W = 816;
const PAGE_H = 1056;
const CHAR_PX = 6.2;
const LINE_PX = 16;
const MAX_W = 320;
const PAD = 2;
const LINE_COST = 120;

/**
 * "0/2 | comment | comment" -> score and comments.
 * @param {string} text
 */
export function parseNote(text) {
  const parts = String(text || "")
    .split("|")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const score = parts[0] && /^\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?$/.test(parts[0]) ? parts.shift().replace(/\s+/g, "") : "";
  return { score, comments: parts.slice(0, 3) };
}

/**
 * Rough rendered size of a red comment at 10pt.
 * @param {string} text
 * @param {number} [maxW]
 */
export function noteSize(text, maxW = MAX_W) {
  const textW = String(text).length * CHAR_PX;
  const width = Math.ceil(Math.min(maxW, Math.max(36, textW + 14)));
  const lines = Math.max(1, Math.ceil(textW / (width - 14) - 0.001));
  return { width, height: lines * LINE_PX + 4 };
}

/**
 * @param {Uint8Array} occ cols*rows, 1 = ink or print
 * @param {number} cols
 * @param {number} rows
 */
function integral(occ, cols, rows) {
  const sum = new Int32Array((cols + 1) * (rows + 1));
  for (let r = 0; r < rows; r++) {
    let run = 0;
    for (let c = 0; c < cols; c++) {
      run += occ[r * cols + c];
      sum[(r + 1) * (cols + 1) + c + 1] = sum[r * (cols + 1) + c + 1] + run;
    }
  }
  return sum;
}

/**
 * Filled cells under a rect, from an integral image.
 * @param {Int32Array} s
 * @param {number} cols
 * @param {number} rows
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 */
function filled(s, cols, rows, x, y, w, h) {
  const c0 = Math.max(0, Math.floor(x / CELL));
  const r0 = Math.max(0, Math.floor(y / CELL));
  const c1 = Math.min(cols, Math.ceil((x + w) / CELL));
  const r1 = Math.min(rows, Math.ceil((y + h) / CELL));
  const W = cols + 1;
  return s[r1 * W + c1] - s[r0 * W + c1] - s[r1 * W + c0] + s[r0 * W + c0];
}

/**
 * No ink, print, or earlier mark under the rect.
 * @param {{ cols: number, rows: number, sum?: Int32Array }} g
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 */
function isFree(g, x, y, w, h) {
  if (x < 0 || y < 0 || x + w > PAGE_W || y + h > PAGE_H) return false;
  return filled(/** @type {Int32Array} */ (g.sum), g.cols, g.rows, x - PAD, y - PAD, w + PAD * 2, h + PAD * 2) === 0;
}

/**
 * @param {{ cols: number, rows: number, occ: Uint8Array, sum?: Int32Array }} g
 * @param {{ left: number, top: number, width: number, height: number }} r
 */
function claim(g, r) {
  for (let y = Math.floor(r.top / CELL); y < Math.min(g.rows, Math.ceil((r.top + r.height) / CELL)); y++) {
    for (let x = Math.floor(r.left / CELL); x < Math.min(g.cols, Math.ceil((r.left + r.width) / CELL)); x++) {
      if (x >= 0 && y >= 0) g.occ[y * g.cols + x] = 1;
    }
  }
  g.sum = integral(g.occ, g.cols, g.rows);
}

/**
 * Closest free spot to the anchor inside the region. Spots above the anchor
 * cost three times as much, so comments read after his work.
 * @param {{ cols: number, rows: number, occ: Uint8Array, sum?: Int32Array, lines?: Uint8Array, lineSum?: Int32Array }} g
 * @param {{ x0: number, y0: number, x1: number, y1: number }} region
 * @param {{ x: number, y: number }} at
 * @param {{ width: number, height: number }} size
 */
export function findSpot(g, region, at, size) {
  if (!g.sum) g.sum = integral(g.occ, g.cols, g.rows);
  if (g.lines && !g.lineSum) g.lineSum = integral(g.lines, g.cols, g.rows);
  let best = null;
  let bestCost = Infinity;
  for (let y = region.y0; y + size.height <= region.y1; y += CELL) {
    const dy = y - at.y;
    const rowCost = dy < 0 ? -dy * 3 : dy;
    if (rowCost >= bestCost) continue;
    for (let x = region.x0; x + size.width <= region.x1; x += CELL) {
      let cost = rowCost + Math.abs(x - at.x) * 0.5;
      if (cost >= bestCost || !isFree(g, x, y, size.width, size.height)) continue;
      if (g.lineSum && filled(g.lineSum, g.cols, g.rows, x, y + 2, size.width, size.height - 4)) cost += LINE_COST;
      if (cost >= bestCost) continue;
      best = { left: x, top: y };
      bestCost = cost;
    }
  }
  return best;
}

/**
 * Where his writing in a box ends: right edge and top of the last line.
 * @param {number[][]} bboxes [x0, y0, x1, y1] per stroke, page px
 * @param {{ x: number, y: number, width: number, height: number }} box
 */
export function inkEnd(bboxes, box) {
  const inBox = bboxes.filter(([x0, y0, x1, y1]) => {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    return cx >= box.x && cx <= box.x + box.width && cy >= box.y && cy <= box.y + box.height;
  });
  if (!inBox.length) return null;
  const bottom = Math.max(...inBox.map((b) => b[3]));
  const last = inBox.filter((b) => b[3] >= bottom - 28);
  return { x: Math.max(...last.map((b) => b[2])), y: Math.min(...last.map((b) => b[1])), bottom };
}

/**
 * @param {{
 *   boxes: { item: string, part: string, page: number, x: number, y: number, width: number, height: number }[],
 *   notes: Record<string, string>,
 *   grids: { cols: number, rows: number, occ: Uint8Array }[],
 *   bboxes: number[][][],
 *   head?: string,
 * }} input
 */
export function placeMarks(input) {
  /** @type {{ page: number, left: number, top: number, width: number, text: string, kind: string }[]} */
  const marks = [];
  const put = (page, region, at, text, kind, maxW = MAX_W) => {
    const g = input.grids[page];
    const size = noteSize(text, maxW);
    const spot = (g && findSpot(g, region, at, size)) || { left: Math.min(at.x, PAGE_W - size.width - 4), top: at.y };
    const mark = { page, left: spot.left, top: spot.top, width: size.width, height: size.height, text, kind };
    if (g) claim(g, mark);
    marks.push(mark);
    return mark;
  };
  const head = input.boxes.find((b) => b.item === "_head");
  if (input.head && head) {
    put(head.page, { x0: 360, y0: Math.max(8, head.y - 24), x1: PAGE_W - 8, y1: head.y + head.height }, { x: 420, y: head.y - 4 }, input.head, "head", 380);
  }
  for (const box of input.boxes) {
    if (box.item.startsWith("_")) continue;
    const id = box.part ? `${box.item}-${box.part}` : box.item;
    const { score, comments } = parseNote(input.notes[id]);
    if (!score && !comments.length) continue;
    const right = box.x + box.width;
    if (score) {
      put(box.page, { x0: right - 8, y0: Math.max(0, box.y - 6), x1: PAGE_W - 2, y1: box.y + 40 }, { x: right + 2, y: box.y }, score, "score", 60);
    }
    const end = inkEnd(input.bboxes[box.page] || [], box);
    let at = end ? { x: end.x + 10, y: end.y } : { x: box.x + 24, y: box.y + Math.min(44, box.height * 0.3) };
    const region = { x0: box.x, y0: box.y, x1: Math.min(PAGE_W - 4, right + 40), y1: box.y + box.height + 14 };
    for (const text of comments) {
      const m = put(box.page, region, at, text, "comment");
      at = { x: m.left, y: m.top + m.height + 2 };
    }
  }
  return marks;
}

/**
 * Place marks on the inked pages and draw them into the images
 * (`<outDir>/marked-N.png`), which become the page images OneNote shows.
 * OneNote draws page images above text boxes, so marks must be pixels.
 * @param {{ inkPngs: string[], boxes: any[], notes: Record<string, string>, bboxes: number[][][], head?: string, outDir: string }} o
 */
export async function layoutMarks(o) {
  const { chromium } = await import("playwright-core");
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const tab = await browser.newPage({ viewport: { width: PAGE_W, height: PAGE_H }, deviceScaleFactor: 2 });
    const grids = await occupancyGrids(tab, o.inkPngs);
    const marks = placeMarks({ boxes: o.boxes, notes: o.notes, grids, bboxes: o.bboxes, head: o.head }).map(
      ({ page, left, top, width, text }) => ({ page, left, top, width, text })
    );
    const pngs = [];
    for (let i = 0; i < o.inkPngs.length; i++) {
      const b64 = (await readFile(o.inkPngs[i])).toString("base64");
      const divs = marks
        .filter((m) => m.page === i)
        .map(
          (m) =>
            `<div style="position:absolute;left:${m.left}px;top:${m.top}px;width:${m.width}px;color:#D00000;font:10pt Calibri,Carlito,Arial,sans-serif;line-height:${LINE_PX}px">${m.text
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")}</div>`
        )
        .join("");
      await tab.setContent(
        `<html><body style="margin:0"><div style="position:relative;width:${PAGE_W}px;height:${PAGE_H}px"><img src="data:image/png;base64,${b64}" style="position:absolute;left:0;top:0;width:${PAGE_W}px;height:${PAGE_H}px"/>${divs}</div></body></html>`
      );
      const path = join(o.outDir, `marked-${i + 1}.png`);
      await tab.screenshot({ path, clip: { x: 0, y: 0, width: PAGE_W, height: PAGE_H } });
      pngs.push(path);
    }
    return { marks, pngs };
  } finally {
    await browser.close();
  }
}

/**
 * Ink-or-print occupancy per page from the inked page PNGs (rendered at 2x).
 * @param {import("playwright-core").Page} tab
 * @param {string[]} pngPaths
 */
export async function occupancyGrids(tab, pngPaths) {
  const { readFile } = await import("node:fs/promises");
  const grids = [];
  for (const path of pngPaths) {
    const b64 = (await readFile(path)).toString("base64");
    const flat = await tab.evaluate(
      async ({ b64, cell, w, h }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const cv = document.createElement("canvas");
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        const px = ctx.getImageData(0, 0, w, h).data;
        const cols = Math.ceil(w / cell);
        const rows = Math.ceil(h / cell);
        const occ = new Array(cols * rows).fill(0);
        const lines = new Array(cols * rows).fill(0);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
            const at = Math.floor(y / cell) * cols + Math.floor(x / cell);
            if (lum < 175) occ[at] = 1;
            else if (lum < 235) lines[at] = 1;
          }
        }
        return { cols, rows, occ, lines };
      },
      { b64, cell: CELL, w: PAGE_W, h: PAGE_H }
    );
    grids.push({ cols: flat.cols, rows: flat.rows, occ: Uint8Array.from(flat.occ), lines: Uint8Array.from(flat.lines) });
  }
  return grids;
}
