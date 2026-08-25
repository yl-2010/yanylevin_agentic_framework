// Infer or apply `gender` on person cards. Report-only by default.
//
//   node server/brain-gender-infer.js              markdown table to stdout
//   node server/brain-gender-infer.js --json
//   node server/brain-gender-infer.js --apply    write frontmatter (skip unchanged)

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BRAIN_ROOT,
  listEntities,
  parseFrontmatter,
  serializeFrontmatter,
} from "./brain-lib.js";

/** @typedef {"male"|"female"|"nonbinary"|"unknown"} Gender */

export const GENDER_VALUES = ["male", "female", "nonbinary", "unknown"];

const FEMALE_FIRST = new Set(
  "aaliyah aanika ada aditi aisha alena alice alina allyson alyson alyssa amiya amy ana anna ansuya barbara bess calla cadence cassidy cayetana catherine cheryl dedra diana emma ena eshia ginger gretchen harnamhe ivanka jacqueline jenni jennifer jenlee jessy kadie kara karla kate kateryna katie kaylin kiara kim kirsten kristine krissy kaitlyn ketaki krista laura leah luba mackenzie maddie mahika makayla manaswini maria marisa maritza masha megan meilene melissa mia michelle monica nelli nicole nishka oleksandra piyali radhika reemah rena ruike samaira sammie sarah sofya sonya tamanna tania tanya theresa urvashi vanessa verity vicky victoria xinyuan yana yiyi zoe zoey alora julia shivali shivanshi manaswini maiya gaylynn allison iran".split(
    " ",
  ),
);

const MALE_FIRST = new Set(
  "aaron adam adi aditya alan alex alexander ali amartya andrew ansuya ari aryaman austin ben billy boris cadence carl charlie cameron daniel david deepesh dingchen dylan ehaan emmett eric ethan evan everette francesco gabriel glenn gouranga gregory haosen harry hayden hudson howie jack jai jay jasmin jeff jeffery jeffrey jim jonathan joshua john jonah justin kevin krishna lucas malhar manas marat masato milos mo mustafa nikhil nikita om paolo pablo paul prasham pratyush purnesh raghav raj reyansh rishikesh sam scott shivali siddharth sreekar srikar steve tae tanmay tarek thomas timur tristan tycho tyler varun vehd victor vlad vinay will william wen yisu yulong yuvan zijian ziwen pax paxton".split(
    " ",
  ),
);

const FEMALE_REL = /\b(mother|sister|daughter|aunt|niece|grandmother|grandma|girlfriend|wife|maternal aunt|she\/her|female)\b/i;
const MALE_REL = /\b(father|brother|son|uncle|nephew|grandfather|grandpa|boyfriend|husband|maternal uncle|paternal uncle|little brother|older brother|younger brother|he\/him|male)\b/i;
const FEMALE_TITLE = /(?:Mrs\.|Ms\.|Miss\b|Madam\b|Profe\s+[A-ZÁÉÍÓÚÑ])/i;
const MALE_TITLE = /(?:Mr\.|Sir\b)/i;

function firstToken(name) {
  const bit = String(name || "")
    .trim()
    .split(/\s+/)[0]
    .replace(/^[^a-zA-Z]+/, "")
    .toLowerCase();
  return bit;
}

function readSidecarText(entity) {
  const dir = path.dirname(entity.filePath);
  const chunks = [entity.body];
  for (const f of entity.extraFiles || []) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) chunks.push(fs.readFileSync(p, "utf8"));
  }
  return chunks.join("\n").slice(0, 120_000);
}

function scorePronouns(text) {
  const t = text.toLowerCase();
  let female = 0;
  let male = 0;
  const she = (t.match(/\bshe\b/g) || []).length;
  const her = (t.match(/\bher\b/g) || []).length;
  const he = (t.match(/\bhe\b/g) || []).length;
  const him = (t.match(/\bhim\b/g) || []).length;
  const his = (t.match(/\bhis\b/g) || []).length;
  female += she * 2 + Math.max(0, her - she);
  male += he * 2 + him * 2 + Math.max(0, his - he);
  if (/\bshe\/her\b/.test(t)) female += 5;
  if (/\bhe\/him\b/.test(t)) male += 5;
  return { female, male };
}

/**
 * @param {import("./brain-lib.js").listEntities extends () => infer R ? R : never} entity
 */
export function inferGender(entity) {
  /** @type {{ gender: Gender, reason: string, confidence: "high"|"medium"|"low" }} */
  const out = { gender: "unknown", reason: "no signal", confidence: "low" };
  const f = entity.fields || {};
  const name = String(f.name || entity.name || "");
  const rel = String(f.relationship || "").trim();
  const aliases = Array.isArray(f.aliases) ? f.aliases.join(" ") : "";
  const header = `${name} ${rel} ${aliases}`;
  const text = readSidecarText(entity);
  const first = firstToken(name);

  if (/^(mom|mother|dad|father)$/i.test(rel)) {
    return {
      gender: /^(mom|mother)$/i.test(rel) ? "female" : "male",
      reason: "relationship field (parent role)",
      confidence: "high",
    };
  }

  if (FEMALE_TITLE.test(header)) {
    return { gender: "female", reason: "title (Ms./Mrs./Profe)", confidence: "high" };
  }
  if (MALE_TITLE.test(header)) {
    return { gender: "male", reason: "title (Mr.)", confidence: "high" };
  }
  if (MALE_REL.test(rel)) {
    return { gender: "male", reason: "relationship field", confidence: "high" };
  }
  if (FEMALE_REL.test(rel)) {
    return { gender: "female", reason: "relationship field", confidence: "high" };
  }
  if (/\bnonbinary\b|\bthey\/them\b|\benby\b/i.test(text)) {
    return { gender: "nonbinary", reason: "explicit pronouns in text", confidence: "high" };
  }

  const pron = scorePronouns(text);
  if (pron.female >= 8 && pron.female > pron.male * 2) {
    return { gender: "female", reason: `pronouns in card (${pron.female}/${pron.male})`, confidence: "medium" };
  }
  if (pron.male >= 8 && pron.male > pron.female * 2) {
    return { gender: "male", reason: `pronouns in card (${pron.male}/${pron.female})`, confidence: "medium" };
  }

  if (FEMALE_FIRST.has(first)) {
    return { gender: "female", reason: `first name ${first}`, confidence: "medium" };
  }
  if (MALE_FIRST.has(first)) {
    return { gender: "male", reason: `first name ${first}`, confidence: "medium" };
  }

  if (pron.female > pron.male && pron.female >= 3) {
    return { gender: "female", reason: `weak pronouns (${pron.female}/${pron.male})`, confidence: "low" };
  }
  if (pron.male > pron.female && pron.male >= 3) {
    return { gender: "male", reason: `weak pronouns (${pron.male}/${pron.female})`, confidence: "low" };
  }

  return out;
}

function insertGenderFrontmatter(text, gender) {
  const { fields, body } = parseFrontmatter(text);
  if (!fields) throw new Error("no frontmatter");
  fields.gender = gender;
  const ordered = { ...fields };
  // Keep gender near relationship for readability.
  const out = {};
  for (const key of ["name", "kind", "relationship", "gender"]) {
    if (ordered[key] !== undefined) out[key] = ordered[key];
  }
  for (const [key, value] of Object.entries(ordered)) {
    if (!(key in out)) out[key] = value;
  }
  return serializeFrontmatter(out) + body;
}

function main() {
  const apply = process.argv.includes("--apply");
  const asJson = process.argv.includes("--json");
  const { entities, problems } = listEntities();
  const people = entities.filter((e) => e.kind === "person").sort((a, b) => a.name.localeCompare(b.name));

  /** @type {Array<{ slug: string, name: string, gender: Gender, reason: string, confidence: string, existing: string|null, changed: boolean }>} */
  const rows = [];
  let written = 0;

  for (const p of people) {
    const slug = p.id.replace(/^people\//, "");
    const existing = p.fields.gender ? String(p.fields.gender) : null;
    const { gender, reason, confidence } = inferGender(p);
    const next = gender;
    const changed = existing !== next;

    if (apply && (!existing || existing !== next)) {
      const raw = fs.readFileSync(p.filePath, "utf8");
      fs.writeFileSync(p.filePath, insertGenderFrontmatter(raw, next));
      written += 1;
    }

    rows.push({
      slug,
      name: p.name,
      gender: next,
      reason,
      confidence,
      existing,
      changed,
    });
  }

  if (problems.length) {
    for (const p of problems) console.error(`problem: ${p}`);
  }

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (apply) {
    console.error(`wrote gender on ${written} person.md files`);
  }

  const unknown = rows.filter((r) => r.gender === "unknown");
  console.log(`# Person genders (${rows.length} people, ${unknown.length} unknown)\n`);
  console.log("| Name | Slug | Gender | How inferred |");
  console.log("| --- | --- | --- | --- |");
  for (const r of rows) {
    console.log(`| ${r.name} | ${r.slug} | ${r.gender} | ${r.reason} |`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
