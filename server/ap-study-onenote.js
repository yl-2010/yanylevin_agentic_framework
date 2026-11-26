/**
 * OneNote side of AP study: page HTML for printout pages, plus publish and
 * ink harvest against Yan's owned "AP Study 2026-27" notebook.
 *
 * Page images sit at fixed absolute px so ink maps back onto the render.
 * Notes text goes in a column to the right so it never pushes an image.
 *
 * Red marks go on a rebuilt page, not the inked one. The Graph PATCH API
 * cannot add a positioned div to an existing page (body appends land inside
 * the first div), and OneNote draws page images above text boxes, so grading
 * reposts the page with his ink and the marks both drawn into the images.
 */

import { readFile } from "node:fs/promises";
import {
  GRAPH_BASE,
  createOnenotePage,
  deleteOnenotePage,
  ensureOwnedNotebook,
  ensureSection,
  graphRequest,
  listOwnedSectionPages,
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
 * @param {{ title: string, pageCount: number, pdfName?: string, sideHtml?: string, partPrefix?: string }} opts
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
  return `<!DOCTYPE html><html><head><title>${esc(opts.title)}</title><meta name="created" content="${new Date().toISOString()}" /></head><body data-absolute-enabled="true">${imgs.join("")}${side}${pdf}</body></html>`;
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
 * @param {{ dateKey: string, title: string, pngPaths: string[], pdfPath?: string, sideHtml?: string, token?: string }} opts
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
  });
  const page = await createOnenotePage(token, section.id, { html, parts });
  return { ...page, notebookId: notebook.id, sectionId: section.id, section: section.name };
}

/**
 * Page GUID from a OneNote client or web link. Graph page ids change after
 * OneNote syncs a page; this GUID does not.
 * @param {{ clientUrl?: string, webUrl?: string }} row
 */
export function stablePageId(row) {
  const client = String(row?.clientUrl || "").match(/[?&]page-id=([0-9a-f-]{36})/i);
  if (client) return client[1].toLowerCase();
  const web = String(row?.webUrl || "").match(/%7C([0-9a-f-]{36})%2F%29/i);
  return web ? web[1].toLowerCase() : "";
}

/**
 * Current Graph id for a page row saved at publish time, or "" if the page
 * is gone.
 * @param {string} token
 * @param {{ id?: string, sectionId?: string, clientUrl?: string, webUrl?: string }} row
 */
export async function resolvePageId(token, row) {
  if (!row?.id) return "";
  try {
    await graphRequest("GET", `${GRAPH_BASE}/me/onenote/pages/${encodeURIComponent(row.id)}?$select=id`, token);
    return row.id;
  } catch (err) {
    if (Number(/** @type {any} */ (err)?.status) !== 404) throw err;
  }
  const stable = stablePageId(row);
  if (!stable || !row.sectionId) return "";
  const pages = await listOwnedSectionPages(token, row.sectionId);
  return pages.find((p) => stablePageId(p) === stable)?.id || "";
}

/**
 * Delete a published page by its current id. A page that is already gone
 * counts as deleted.
 * @param {string} token
 * @param {{ id?: string, sectionId?: string, clientUrl?: string, webUrl?: string }} row
 */
export async function deletePublishedPage(token, row) {
  const id = await resolvePageId(token, row);
  if (id) await deleteOnenotePage(token, id);
  return { id, deleted: Boolean(id) };
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
