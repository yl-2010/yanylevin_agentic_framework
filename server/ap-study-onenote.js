/**
 * OneNote side of AP study: page HTML for printout pages, plus publish and
 * ink harvest against Yan's owned "AP Study 2026-27" notebook.
 *
 * Page images sit at fixed absolute px so ink maps back onto the render.
 * Notes text goes in a column to the right so it never pushes an image.
 *
 * Red marks go on a rebuilt page, not the inked one. The Graph PATCH API
 * cannot add a positioned div to an existing page (body appends land inside
 * the first div), so grading reposts the page with his ink baked into the
 * images and each mark as its own absolute div.
 */

import { readFile } from "node:fs/promises";
import {
  createOnenotePage,
  ensureOwnedNotebook,
  ensureSection,
  onenoteToken,
  readOnenotePageInk,
} from "./school-onenote.js";
import { pageImages, parseInkml, strokesOnImage } from "./onenote-ink.js";

export const AP_NOTEBOOK_NAME = "AP Study 2026-27";
export const PAGE_W = 816;
export const PAGE_H = 1056;
export const PAGE_LEFT = 48;
export const PAGE_TOP = 96;
export const PAGE_GAP = 48;
export const SIDE_LEFT = PAGE_LEFT + PAGE_W + 48;
export const MARK_COLOR = "#D00000";

/**
 * @param {number} index zero-based page index
 */
export function pageSlot(index) {
  return { left: PAGE_LEFT, top: PAGE_TOP + index * (PAGE_H + PAGE_GAP), width: PAGE_W, height: PAGE_H };
}

/**
 * @param {string} s
 */
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @typedef {{ page: number, left: number, top: number, width: number, text: string }} Mark
 */

/**
 * @param {Mark} m
 */
export function markHtml(m) {
  const slot = pageSlot(m.page);
  return `<div style="position:absolute;left:${PAGE_LEFT + m.left}px;top:${slot.top + m.top}px;width:${m.width}px"><p style="color:${MARK_COLOR};font-size:10pt;margin-top:0pt;margin-bottom:0pt">${esc(m.text)}</p></div>`;
}

/**
 * @param {{ title: string, pageCount: number, pdfName?: string, sideHtml?: string, partPrefix?: string, marks?: Mark[] }} opts
 */
export function buildPrintoutPageHtml(opts) {
  const prefix = opts.partPrefix || "page";
  const imgs = [];
  for (let i = 0; i < opts.pageCount; i++) {
    const slot = pageSlot(i);
    imgs.push(
      `<img src="name:${prefix}${i + 1}" alt="${esc(`${prefix} ${i + 1}`)}" width="${slot.width}" height="${slot.height}" style="position:absolute;left:${slot.left}px;top:${slot.top}px" />`
    );
  }
  const below = pageSlot(opts.pageCount).top;
  const pdf = opts.pdfName
    ? `<div style="position:absolute;left:${PAGE_LEFT}px;top:${below}px;width:${PAGE_W}px"><p>PDF copy</p><object data-attachment="${esc(opts.pdfName)}" data="name:pdf" type="application/pdf" /></div>`
    : "";
  const side = opts.sideHtml
    ? `<div style="position:absolute;left:${SIDE_LEFT}px;top:${PAGE_TOP}px;width:440px">${opts.sideHtml}</div>`
    : "";
  const marks = (opts.marks || []).map(markHtml).join("");
  return `<!DOCTYPE html><html><head><title>${esc(opts.title)}</title><meta name="created" content="${new Date().toISOString()}" /></head><body data-absolute-enabled="true">${imgs.join("")}${marks}${side}${pdf}</body></html>`;
}

/**
 * Month section name, e.g. "Nov 2026".
 * @param {string} dateKey YYYY-MM-DD
 */
export function monthSectionName(dateKey) {
  const [y, m] = dateKey.split("-").map(Number);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[m - 1]} ${y}`;
}

/**
 * @param {{ dateKey: string, title: string, pngPaths: string[], pdfPath?: string, sideHtml?: string, marks?: Mark[], token?: string }} opts
 */
export async function publishPrintoutPage(opts) {
  const token = opts.token || (await onenoteToken());
  const notebook = await ensureOwnedNotebook(token, AP_NOTEBOOK_NAME);
  const section = await ensureSection(token, notebook.id, monthSectionName(opts.dateKey));
  /** @type {{ name: string, type: string, data: Buffer, filename?: string }[]} */
  const parts = [];
  for (let i = 0; i < opts.pngPaths.length; i++) {
    parts.push({
      name: `page${i + 1}`,
      type: "image/png",
      data: await readFile(opts.pngPaths[i]),
      filename: `page${i + 1}.png`,
    });
  }
  let pdfName = "";
  if (opts.pdfPath) {
    pdfName = opts.pdfPath.split("/").pop() || "work.pdf";
    parts.push({ name: "pdf", type: "application/pdf", data: await readFile(opts.pdfPath), filename: pdfName });
  }
  const html = buildPrintoutPageHtml({
    title: opts.title,
    pageCount: opts.pngPaths.length,
    pdfName,
    sideHtml: opts.sideHtml,
    marks: opts.marks,
  });
  const page = await createOnenotePage(token, section.id, { html, parts });
  return { ...page, notebookId: notebook.id, sectionId: section.id, section: section.name };
}

/**
 * Strokes per page image for one published packet page.
 * @param {string} pageId
 * @param {{ token?: string }} [opts]
 */
export async function harvestInk(pageId, opts = {}) {
  const token = opts.token || (await onenoteToken());
  const { html, inkml } = await readOnenotePageInk(token, pageId);
  const { traces } = parseInkml(inkml);
  const images = pageImages(html).filter((img) => /^page \d+$/.test(img.alt) || img.width === PAGE_W);
  return {
    traces: traces.length,
    pages: images.map((img, i) => ({
      index: i,
      image: img,
      strokes: strokesOnImage(traces, img),
    })),
  };
}
