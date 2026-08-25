/**
 * Read-only name index from Yan's EPS Student Data Collection.xlsx.
 * Lookup table only — never import the whole roster as people.
 */

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SCHOOL_XLSX_CANDIDATES = [
  join(
    homedir(),
    "Library/CloudStorage/OneDrive-Personal/Documents/School/EPS Backups/Student Data Collection.xlsx"
  ),
  join(homedir(), "Downloads/Student Data Collection.xlsx"),
];

const PYTHON = `import json, re, sys, zipfile, xml.etree.ElementTree as ET
from pathlib import Path
p = Path(sys.argv[1])
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"

def col_index(ref):
    m = re.match(r"([A-Z]+)", ref or "")
    s = m.group(1) if m else "A"
    n = 0
    for ch in s:
        n = n * 26 + (ord(ch) - 64)
    return n - 1

def cell_text(c, strings):
    t = c.get("t")
    if t == "inlineStr":
        return "".join((x.text or "") for x in c.findall(".//m:t", NS))
    v = c.find("m:v", NS)
    raw = v.text if v is not None else ""
    if t == "s" and str(raw).isdigit():
        i = int(raw)
        return strings[i] if 0 <= i < len(strings) else raw
    return raw or ""

with zipfile.ZipFile(p) as z:
    names = set(z.namelist())
    strings = []
    if "xl/sharedStrings.xml" in names:
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.findall("m:si", NS):
            strings.append("".join((t.text or "") for t in si.findall(".//m:t", NS)))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    rid_to = {r.get("Id"): r.get("Target") for r in rels}
    people = []
    for sheet in wb.findall("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}sheets/{http://schemas.openxmlformats.org/spreadsheetml/2006/main}sheet"):
        name = sheet.get("name") or ""
        target = (rid_to.get(sheet.get(REL) or "") or "").lstrip("/")
        if not target:
            continue
        path = target if target.startswith("xl/") else "xl/" + target
        kind = "teacher" if name.lower() == "teachers" else ("student" if "class of" in name.lower() else None)
        if kind is None:
            continue
        class_of = None
        if "class of" in name.lower():
            bits = name.rsplit(" ", 1)
            if bits[-1].isdigit():
                class_of = bits[-1]
        sroot = ET.fromstring(z.read(path))
        rows = []
        for row in sroot.findall("m:sheetData/m:row", NS):
            vals = []
            for c in row.findall("m:c", NS):
                idx = col_index(c.get("r"))
                while len(vals) <= idx:
                    vals.append("")
                vals[idx] = cell_text(c, strings)
            rows.append(vals)
        if not rows:
            continue
        header = [str(h).strip().lower() for h in rows[0]]
        def col(*needles):
            for i, h in enumerate(header):
                if any(n in h for n in needles):
                    return i
            return None
        i_first = col("first")
        i_last = col("last")
        i_id = col("student id", "id")
        if i_first is None or i_last is None:
            continue
        for vals in rows[1:]:
            first = (vals[i_first] if i_first < len(vals) else "").strip()
            last = (vals[i_last] if i_last < len(vals) else "").strip()
            sid = (vals[i_id] if i_id is not None and i_id < len(vals) else "").strip()
            if not first and not last:
                continue
            people.append({
                "first": first,
                "last": last,
                "name": (first + " " + last).strip(),
                "id": sid,
                "kind": kind,
                "classOf": class_of,
                "sheet": name,
            })
print(json.dumps({"ok": True, "path": str(p), "count": len(people), "people": people}))
`;

/**
 * @param {string[]} [candidates]
 */
export async function resolveSchoolXlsxPath(candidates = SCHOOL_XLSX_CANDIDATES) {
  for (const p of candidates) {
    try {
      await access(p);
      return p;
    } catch {
      /* next */
    }
  }
  return "";
}

/**
 * @param {{ path?: string, candidates?: string[] }} [opts]
 */
export async function loadSchoolNames(opts = {}) {
  const path = opts.path || (await resolveSchoolXlsxPath(opts.candidates));
  if (!path) {
    return { ok: false, error: "Student Data Collection.xlsx not found", people: [] };
  }
  try {
    const { stdout } = await execFileAsync("python3", ["-c", PYTHON, path], {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = JSON.parse(String(stdout || "").trim() || "{}");
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, error: "school names parse failed", people: [] };
    }
    return parsed;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      people: [],
    };
  }
}

const isCli =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  loadSchoolNames()
    .then((payload) => {
      console.log(JSON.stringify(payload, null, 2));
    })
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}
