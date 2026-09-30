/**
 * Match Class Notebook pages to existing education todos.
 * Personal section group is Yan's copy. Content Library is the teacher page.
 * Canvas nightly runs this for todos that already exist. Teachers often
 * publish the page days after the Canvas row.
 */

export const CONTENT_LIBRARY_GROUP = "_Content Library";
export const PERSONAL_GROUP = "Yan Levin";

/** Dashboard class id → Class Notebook display name. Yan only. */
export const CLASS_NOTEBOOKS = {
  "advanced-calculus": "Advanced Calculus 26-27",
  "american-literature": "Am. Lit",
  "data-science-1": "Data Science 1 (Fall) Notebook",
  physics: "Physics 26-27",
  "spanish-4": "Spanish 4 - 2026-2027",
  "us-history": "US History 26-27",
};

const WORD_NUM = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const STOP = new Set([
  "a",
  "an",
  "and",
  "cw",
  "day",
  "for",
  "from",
  "hw",
  "in",
  "intro",
  "ma",
  "of",
  "on",
  "qa",
  "the",
  "to",
  "with",
  "work",
  "you",
  "your",
]);

/**
 * @param {string} raw
 */
export function analyzeTitle(raw) {
  const cleaned = String(raw || "")
    .replace(/^\s*(hw|cw|qa|ma)\s*[:.-]\s*/i, "")
    .toLowerCase();
  const parts = cleaned.split(/[^a-z0-9]+/).filter(Boolean);
  /** @type {Set<number>} */
  const nums = new Set();
  /** @type {string[]} */
  const words = [];
  for (const part of parts) {
    if (Object.prototype.hasOwnProperty.call(WORD_NUM, part)) {
      nums.add(WORD_NUM[part]);
      continue;
    }
    if (/^\d+$/.test(part)) {
      nums.add(Number(part));
      continue;
    }
    if (STOP.has(part)) continue;
    words.push(part);
  }
  return { nums, words };
}

/**
 * @param {Set<number>} a
 * @param {Set<number>} b
 */
function numbersCompatible(a, b) {
  if (!a.size || !b.size) return true;
  if (a.size !== b.size) return false;
  for (const n of a) if (!b.has(n)) return false;
  return true;
}

/**
 * Higher is a tighter match. 0 means do not link.
 * @param {string} todoName
 * @param {string} pageTitle
 */
export function scoreTodoPage(todoName, pageTitle) {
  const title = String(pageTitle || "").trim();
  if (!title || title === "(untitled)") return 0;
  if (/\b(solns?|solutions?)\b/i.test(title) && !/\b(solns?|solutions?)\b/i.test(todoName)) {
    return 0;
  }
  if (/\bnotes?\b/i.test(title) && !/\bnotes?\b/i.test(todoName)) return 0;
  const todo = analyzeTitle(todoName);
  const page = analyzeTitle(title);
  if (!todo.words.length || !page.words.length) return 0;
  if (!numbersCompatible(todo.nums, page.nums)) return 0;
  const shorter = todo.words.length <= page.words.length ? todo.words : page.words;
  const longer = shorter === todo.words ? page.words : todo.words;
  const longerSet = new Set(longer);
  if (shorter.length < 2) return 0;
  if (!shorter.every((w) => longerSet.has(w))) return 0;
  const covered = todo.words.filter((w) => page.words.includes(w)).length / todo.words.length;
  if (covered < 0.75) return 0;
  let score = Math.round(covered * 100);
  if (todo.nums.size && page.nums.size) score += 15;
  if (/\bpractice\b/i.test(title) && !/\bpractice\b/i.test(todoName)) score -= 30;
  if (score < 75) return 0;
  return score;
}

/**
 * @param {string} role
 * @param {string} todoName
 * @param {{ id?: string, title?: string, webUrl?: string, clientUrl?: string }} page
 */
export function oneNoteSite(role, todoName, page) {
  const personal = role === "personal";
  const pageTitle = String(page?.title || "").trim();
  const name = personal ? String(todoName || "").trim() : `Content Library: ${pageTitle}`;
  const url = String(page?.webUrl || "").trim();
  if (!name || !pageTitle || !/^https:\/\//i.test(url)) return null;
  /** @type {{ name: string, url: string, oneNote: string, pageId: string, clientUrl?: string }} */
  const site = {
    name,
    url,
    oneNote: personal ? "personal" : "content-library",
    pageId: String(page?.id || "").trim(),
  };
  const clientUrl = String(page?.clientUrl || "").trim();
  if (/^onenote:/i.test(clientUrl)) site.clientUrl = clientUrl;
  return site;
}

/**
 * @param {unknown[]|undefined} existing
 * @param {object[]} nextOneNote
 */
export function mergeOneNoteSites(existing, nextOneNote) {
  const prev = Array.isArray(existing) ? existing : [];
  const kept = prev.filter(
    (site) => site?.oneNote !== "personal" && site?.oneNote !== "content-library"
  );
  const sites = [...kept, ...nextOneNote.filter(Boolean)];
  return sites;
}

/**
 * One personal page and one Content Library page per todo.
 * The same page is not given to two todos.
 * @param {{ name: string }[]} todos
 * @param {{ id?: string, title?: string, webUrl?: string, clientUrl?: string, group?: string }[]} pages
 */
export function pickOneNoteLinks(todos, pages) {
  const list = Array.isArray(todos) ? todos : [];
  const all = Array.isArray(pages) ? pages : [];
  const personal = assignRole(
    list,
    all.filter((p) => p.group === PERSONAL_GROUP),
    "personal"
  );
  const content = assignRole(
    list,
    all.filter((p) => p.group === CONTENT_LIBRARY_GROUP),
    "content-library"
  );
  return list.map((todo) => ({
    todo,
    personal: personal.get(todo) || null,
    content: content.get(todo) || null,
  }));
}

/**
 * @param {{ name: string }[]} todos
 * @param {object[]} pages
 * @param {"personal"|"content-library"} role
 */
function sectionBias(page) {
  const name = String(page?.sectionName || "").trim().toLowerCase();
  if (name === "homework") return 2;
  if (name === "class notes") return 0;
  return 1;
}

function overlapCount(todoName, pageTitle) {
  const pageWords = new Set(analyzeTitle(pageTitle).words);
  return analyzeTitle(todoName).words.filter((word) => pageWords.has(word)).length;
}

function assignRole(todos, pages, role) {
  /** @type {{ todo: { name: string }, page: object, score: number }[]} */
  const cands = [];
  for (const todo of todos) {
    for (const page of pages) {
      const score = scoreTodoPage(todo.name, page.title);
      if (!score) continue;
      cands.push({ todo, page, score });
    }
  }
  cands.sort((a, b) => {
    const overlap = overlapCount(b.todo.name, b.page.title) - overlapCount(a.todo.name, a.page.title);
    if (overlap) return overlap;
    if (b.score !== a.score) return b.score - a.score;
    const bias = sectionBias(b.page) - sectionBias(a.page);
    if (bias) return bias;
    return String(a.page.title).length - String(b.page.title).length;
  });
  const usedTodos = new Set();
  const usedPages = new Set();
  /** @type {Map<object, object>} */
  const out = new Map();
  for (const cand of cands) {
    if (usedTodos.has(cand.todo) || usedPages.has(cand.page)) continue;
    const siteRole = role === "personal" ? "personal" : "content-library";
    const site = oneNoteSite(siteRole, cand.todo.name, cand.page);
    if (!site) continue;
    usedTodos.add(cand.todo);
    usedPages.add(cand.page);
    out.set(cand.todo, { ...site, pageTitle: String(cand.page.title || ""), score: cand.score });
  }
  return out;
}
