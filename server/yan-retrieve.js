/**
 * lexical retrieval over data/owner.md sections.
 * Keeps the full dossier off the always-on prompt; injects only top matches per turn.
 */

export const MAX_RETRIEVED_SECTIONS = 4;
export const MAX_SECTION_CHARS = 8_000;
export const MAX_TOTAL_RETRIEVED_CHARS = 20_000;

/**
 * @param {string} text
 * @param {number} max
 * @param {string} [suffix]
 */
export function capText(text, max, suffix = "\n...[truncated]") {
  const value = String(text || "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}${suffix}`;
}

/**
 * Tokenize a query into lowercase alphanumeric tokens (length >= 2).
 * @param {string} query
 */
export function tokenizeQuery(query) {
  return String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

/**
 * Lexical score: count of query tokens found in haystack.
 * @param {string[]} tokens
 * @param {string} haystack
 */
export function scoreHaystack(tokens, haystack) {
  if (!tokens.length) return 0;
  const h = String(haystack || "").toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (h.includes(t)) score += 1;
  }
  return score;
}

/**
 * Split markdown into ## sections (preamble kept as title "Preamble").
 * @param {string} md
 * @returns {Array<{ title: string, body: string }>}
 */
export function parseMarkdownSections(md) {
  const lines = String(md || "").split(/\r?\n/);
  /** @type {Array<{ title: string, body: string[] }>} */
  const sections = [];
  let title = "Preamble";
  /** @type {string[]} */
  let body = [];

  const flush = () => {
    const text = body.join("\n").trim();
    if (text) sections.push({ title, body: text });
    body = [];
  };

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      flush();
      title = h2[1].trim();
      continue;
    }
    body.push(line);
  }
  flush();
  return sections;
}

/**
 * Pull a single **Label:** value from markdown (first match).
 * @param {string} md
 * @param {string} label
 */
export function extractField(md, label) {
  const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\*\\*${escaped}:\\*\\*\\s*(.+)`, "i");
  const m = String(md || "").match(re);
  if (!m) return null;
  return m[1]
    .replace(/\s*\*[^*]*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Compact always-on profile (small; not the full dossier).
 * @param {string} md
 */
export function buildCompactAboutYan(md) {
  const age = extractField(md, "Age") || "unknown";
  const school =
    extractField(md, "Current school") ||
    "Set OWNER_EMAIL and edit data/owner.md";
  const email = extractField(md, "Email") || "you@example.com";
  const github = extractField(md, "GitHub") || "https://github.com/yl-2010";
  const site =
    extractField(md, "Personal website") || "https://yanylevin.com";

  return [
    "ABOUT YAN (always available — use for quick facts):",
    `- Name: Yan Levin; in answers call him Yan (third person), not his full name`,
    `- Age: ${age} — use this exact Age value; do not recompute from birth year`,
    `- School: ${school}`,
    `- Focus: read data/owner.md; this is a placeholder profile`,
    `- Academics snapshot: none shipped; fill owner.md`,
    `- Contact: ${email}; GitHub ${github}; site ${site}`,
    `- Phone / YouTube / hobbies / languages / heritage: only if the user directly asks`,
    `- Open to collaboration, internships, and project outreach — always`,
    `- Detailed facts live in RETRIEVED KNOWLEDGE when relevant; if a detail is not there or in ABOUT YAN, say you do not know`,
  ].join("\n");
}

/**
 * Lexically retrieve top owner.md sections for a user query.
 * @param {string} md
 * @param {string} query
 * @returns {Array<{ title: string, body: string, score: number }>}
 */
export function retrieveYanSections(md, query) {
  const tokens = tokenizeQuery(query);
  const sections = parseMarkdownSections(md);
  if (!sections.length) return [];

  const scored = sections.map((s) => {
    const haystack = `${s.title}\n${s.body}`;
    const score = tokens.length ? scoreHaystack(tokens, haystack) : 0;
    return { ...s, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.title.localeCompare(b.title);
  });

  /** @type {Array<{ title: string, body: string, score: number }>} */
  const picked = [];
  let chars = 0;

  for (const s of scored) {
    // Skip empty preamble rules dump when there are better hits.
    if (
      s.title === "Preamble" &&
      tokens.length &&
      s.score === 0 &&
      scored.some((x) => x.score > 0)
    ) {
      continue;
    }
    if (tokens.length && s.score === 0 && picked.length >= 2) break;
    if (picked.length >= MAX_RETRIEVED_SECTIONS) break;

    const body = capText(s.body, MAX_SECTION_CHARS);
    if (chars + body.length > MAX_TOTAL_RETRIEVED_CHARS && picked.length > 0) {
      break;
    }
    picked.push({ title: s.title, body, score: s.score });
    chars += body.length;
  }

  // No keyword hits: still give a couple of high-value default sections.
  if (!picked.length || (tokens.length && picked.every((p) => p.score === 0))) {
    const defaults = ["Short bio", "Identity & contact", "FAQ", "Building / startups"];
    const byTitle = new Map(sections.map((s) => [s.title, s]));
    const fallback = [];
    for (const title of defaults) {
      const s = byTitle.get(title);
      if (!s) continue;
      const body = capText(s.body, MAX_SECTION_CHARS);
      fallback.push({ title: s.title, body, score: 0 });
      if (fallback.length >= 2) break;
    }
    if (fallback.length) return fallback;
  }

  return picked;
}

/**
 * Format retrieved sections for the system prompt.
 * @param {Array<{ title: string, body: string, score?: number }>} sections
 */
export function formatRetrievedKnowledge(sections) {
  if (!Array.isArray(sections) || !sections.length) {
    return "RETRIEVED KNOWLEDGE: (none for this turn — rely on ABOUT YAN or say you do not know)";
  }
  const blocks = sections.map((s, i) => {
    return `[${i + 1}] ## ${s.title}\n${s.body}`;
  });
  return [
    "RETRIEVED KNOWLEDGE (server selected sections from Yan’s detail file for this message — treat as ground truth):",
    ...blocks,
    "--- END RETRIEVED KNOWLEDGE ---",
  ].join("\n\n");
}
