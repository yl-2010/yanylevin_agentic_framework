// Migration scaffolder (plan gate M1/M2). Converts legacy people cards (flat
// `people/<slug>.md` and `people/<slug>/{person.md,log.md,...}`) into the new
// folder-per-person structure from brain/schema.md, deterministically:
//
// - header bullets -> frontmatter (relationship, aliases, emails, phones;
//   the raw Contacts string is always kept in contacts_raw)
// - "How we know them" -> relationship.md
// - "## Standing" -> person.md compiled truth, verbatim
// - "## Recent" + log.md dated sections -> append-only timeline, ascending
// - every other line -> notes.md, so zero lines are lost; Composer then
//   refines fields/edges/typed files in M2 and the audit checks the result
//
//   node server/brain-migrate-scaffold.js                    dry-run report
//   node server/brain-migrate-scaffold.js --write [--out D]  write scaffolds (default brain/people-new)
//   --src D                                                  legacy source dir (default brain/people)

import fs from "node:fs";
import path from "node:path";
import { BRAIN_ROOT, serializeFrontmatter } from "./brain-lib.js";

const srcFlag = process.argv.indexOf("--src");
const PEOPLE_DIR =
  srcFlag !== -1 ? path.resolve(process.argv[srcFlag + 1]) : path.join(BRAIN_ROOT, "people");
const SKIP = new Set(["index.md", "graph.md", "skipped.md"]);
const KNOWN_BULLETS = {
  relationship: "relationship",
  aliases: "aliases",
  contacts: "contacts",
  "how we know them": "howWeKnow",
};

function listLegacy() {
  const people = [];
  for (const entry of fs.readdirSync(PEOPLE_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    if (entry.isFile() && entry.name.endsWith(".md")) {
      people.push({ slug: entry.name.replace(/\.md$/, ""), cardPath: path.join(PEOPLE_DIR, entry.name), extras: [] });
    } else if (entry.isDirectory()) {
      const dir = path.join(PEOPLE_DIR, entry.name);
      const cardPath = path.join(dir, "person.md");
      const extras = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".md") && f !== "person.md")
        .sort()
        .map((f) => path.join(dir, f));
      people.push({ slug: entry.name, cardPath: fs.existsSync(cardPath) ? cardPath : null, extras });
    }
  }
  return people;
}

// Splits a legacy markdown card into title, header bullets, and ## sections.
function parseLegacyCard(text) {
  const lines = text.split("\n");
  const card = { title: null, bullets: [], sections: [], stray: [] };
  let section = null;

  for (const line of lines) {
    if (line.startsWith("# ") && !card.title) {
      card.title = line.slice(2).trim();
    } else if (line.startsWith("## ")) {
      section = { name: line.slice(3).trim(), lines: [] };
      card.sections.push(section);
    } else if (section) {
      section.lines.push(line);
    } else if (line.startsWith("- ")) {
      card.bullets.push(line.slice(2));
    } else if (line.trim() && card.bullets.length) {
      // Continuation of a wrapped bullet.
      card.bullets[card.bullets.length - 1] += " " + line.trim();
    } else if (line.trim()) {
      card.stray.push(line);
    }
  }
  return card;
}

// Dated blocks (`### YYYY-MM-DD` + content) -> timeline entries.
function parseDatedSections(lines, source) {
  const entries = [];
  const leftovers = [];
  let date = null;
  for (const line of lines) {
    const m = line.match(/^###\s+(\d{4}-\d{2}-\d{2})\s*$/);
    if (m) {
      date = m[1];
    } else if (!line.trim()) {
      continue;
    } else if (date && line.startsWith("- ")) {
      entries.push({ date, text: line.slice(2).trim() });
    } else if (date && line.startsWith("  ") && entries.length) {
      entries[entries.length - 1].text += " " + line.trim();
    } else if (date) {
      entries.push({ date, text: line.trim() });
    } else {
      leftovers.push({ source, line });
    }
  }
  return { entries, leftovers };
}

function parseContacts(raw) {
  const emails = [];
  const phones = [];
  const other = [];
  for (const token of raw.split(/[,/;]/).map((t) => t.trim()).filter(Boolean)) {
    if (token.includes("@")) emails.push(token);
    else if (/^\+?[\d\s().-]{7,}$/.test(token)) phones.push(token.replace(/[\s().-]/g, ""));
    else other.push(token);
  }
  return { emails, phones, other };
}

function scaffoldPerson(person) {
  const result = { slug: person.slug, files: {}, notes: [], timeline: [], warnings: [] };
  const fields = {
    name: person.slug,
    kind: "person",
    relationship: null,
    aliases: [],
    emails: [],
    phones: [],
    school: null,
    groups: [],
    edges: [],
    last_touched: null,
  };
  let howWeKnow = null;
  let standing = "";

  if (person.cardPath) {
    const card = parseLegacyCard(fs.readFileSync(person.cardPath, "utf8"));
    if (card.title) fields.name = card.title;
    for (const line of card.stray) result.notes.push({ source: "card header", line });

    for (const bullet of card.bullets) {
      const m = bullet.match(/^([^:]+):\s*(.*)$/s);
      const key = m ? KNOWN_BULLETS[m[1].trim().toLowerCase()] : null;
      if (key === "relationship") fields.relationship = m[2].trim();
      else if (key === "aliases") fields.aliases = m[2].split(",").map((a) => a.trim()).filter(Boolean);
      else if (key === "contacts") {
        fields.contacts_raw = m[2].trim();
        const { emails, phones, other } = parseContacts(m[2]);
        fields.emails = emails;
        fields.phones = phones;
        if (other.length) result.warnings.push(`unparsed contact tokens: ${other.join("; ")}`);
      } else if (key === "howWeKnow") howWeKnow = m[2].trim();
      else result.notes.push({ source: "card header", line: `- ${bullet}` });
    }

    for (const section of card.sections) {
      const name = section.name.toLowerCase();
      if (name === "standing") {
        standing = section.lines.join("\n").trim();
      } else if (name === "recent" || name === "log") {
        const { entries, leftovers } = parseDatedSections(section.lines, `card section "${section.name}"`);
        result.timeline.push(...entries);
        result.notes.push(...leftovers);
      } else {
        result.notes.push({ source: `card section "${section.name}"`, block: section.lines.join("\n").trim() });
      }
    }
  } else {
    result.warnings.push("folder without person.md");
  }

  for (const extraPath of person.extras) {
    const base = path.basename(extraPath);
    const text = fs.readFileSync(extraPath, "utf8");
    if (base === "log.md") {
      const body = text.replace(/^# Log\s*\n+(Newest first\.\s*\n+)?/i, "");
      const { entries, leftovers } = parseDatedSections(body.split("\n"), "log.md");
      result.timeline.push(...entries);
      result.notes.push(...leftovers);
    } else {
      result.notes.push({ source: base, block: text.trim() });
    }
  }

  result.timeline.sort((a, b) => a.date.localeCompare(b.date));
  if (result.timeline.length) fields.last_touched = result.timeline[result.timeline.length - 1].date;

  // person.md
  const personLines = [
    `# ${fields.name}`,
    "",
    "> TODO(m2): executive summary. Composer fills this from the card below.",
    "",
    "## Standing",
    "",
    standing || "TODO(m2): no Standing section in the legacy card.",
    "",
    "<!-- timeline -->",
    "## Timeline",
    "",
    ...result.timeline.map((e) => `- ${e.date} | ${e.text} [migrated]`),
    "",
  ];
  result.files["person.md"] = serializeFrontmatter(fields) + "\n" + personLines.join("\n");

  if (howWeKnow) {
    result.files["relationship.md"] = [`# How Yan knows ${fields.name}`, "", howWeKnow, ""].join("\n");
  }

  if (result.notes.length) {
    const noteLines = [`# Notes: ${fields.name}`, "", "## Unsorted (migration)", ""];
    for (const note of result.notes) {
      if (note.block) noteLines.push(`### From ${note.source}`, "", note.block, "");
      else noteLines.push(`- (${note.source}) ${note.line}`);
    }
    noteLines.push("");
    result.files["notes.md"] = noteLines.join("\n");
  }

  return result;
}

function main() {
  const write = process.argv.includes("--write");
  const outFlag = process.argv.indexOf("--out");
  const outDir = outFlag !== -1 ? path.resolve(process.argv[outFlag + 1]) : path.join(BRAIN_ROOT, "people-new");

  const legacy = listLegacy();
  const alreadyNew = legacy.filter(
    (p) => p.cardPath && fs.readFileSync(p.cardPath, "utf8").startsWith("---\n"),
  );
  const toMigrate = legacy.filter((p) => !alreadyNew.includes(p));

  let totalTimeline = 0;
  let totalNotes = 0;
  const warnings = [];

  for (const person of toMigrate) {
    const scaffold = scaffoldPerson(person);
    totalTimeline += scaffold.timeline.length;
    totalNotes += scaffold.notes.length;
    for (const w of scaffold.warnings) warnings.push(`${scaffold.slug}: ${w}`);

    if (write) {
      const dir = path.join(outDir, scaffold.slug);
      fs.mkdirSync(dir, { recursive: true });
      for (const [file, text] of Object.entries(scaffold.files)) {
        fs.writeFileSync(path.join(dir, file), text);
      }
    }
  }

  console.log(`${write ? "wrote" : "dry-run:"} ${toMigrate.length} people${write ? ` -> ${outDir}` : ""}`);
  console.log(`already new format (skipped): ${alreadyNew.length}`);
  console.log(`timeline entries captured: ${totalTimeline}`);
  console.log(`lines routed to notes.md (need M2 sorting): ${totalNotes}`);
  for (const w of warnings) console.warn(`warning: ${w}`);
}

main();
