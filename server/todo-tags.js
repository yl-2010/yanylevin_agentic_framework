/**
 * Canvas title tags. CW is the lowest, then HW, then QA, then MA.
 * A title that lists more than one keeps the highest.
 */

/** @type {Readonly<Record<string, number>>} */
export const TODO_TAG_RANK = Object.freeze({ CW: 0, HW: 1, QA: 2, MA: 3 });

const TAG = "CW|HW|QA|MA";
const TAG_BLOCK = `(?:${TAG})(?:\\s*\\/\\s*(?:${TAG}))*`;

/** Bracket form `[CW/HW]` or bare `CW/HW:` / `MA #F2`. Group 1 or 2 is the tag block. */
const TODO_TAG_HEAD = new RegExp(
  `^\\[(${TAG_BLOCK})\\]\\s*|^(${TAG_BLOCK})(?:\\s*:\\s*|\\s+)`,
  "i"
);

/**
 * Highest CW/HW/QA/MA prefix on a Canvas title. Empty when the title has none.
 * @param {unknown} title
 * @returns {string}
 */
export function highestTodoTag(title) {
  const raw = String(title || "").trim();
  const m = raw.match(TODO_TAG_HEAD);
  if (!m) return "";
  const block = String(m[1] || m[2] || "").toUpperCase();
  let best = "";
  let rank = -1;
  for (const part of block.split(/\s*\/\s*/)) {
    const tag = part.trim();
    const r = TODO_TAG_RANK[tag];
    if (r == null || r <= rank) continue;
    rank = r;
    best = tag;
  }
  return best;
}

/**
 * Drop a leading CW/HW/QA/MA prefix. The tag lives on `tag`.
 * @param {unknown} name
 * @returns {string}
 */
export function stripTodoTagPrefix(name) {
  const raw = String(name || "").trim();
  const stripped = raw
    .replace(TODO_TAG_HEAD, "")
    .replace(/^[-–]\s+/, "")
    .trim();
  return stripped || raw;
}
