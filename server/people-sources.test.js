import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contactMatchesQuery, looksLikeBusinessContact } from "./contacts-read.js";
import { looksLikeNoreplyAddress } from "./mail-people-read.js";
import { loadSchoolNames, resolveSchoolXlsxPath } from "./school-names-read.js";
import { countNameMentions } from "./imessage-read.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLocalIpcHandler } from "./local-ipc.js";

const execFileAsync = promisify(execFile);

const BUILD_XLSX = `import sys, zipfile
path, mode = sys.argv[1], sys.argv[2]
ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
rns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

def inline_c(ref, text):
    return f'<c r="{ref}" t="inlineStr"><is><t>{text}</t></is></c>'

def shared_c(ref, idx):
    return f'<c r="{ref}" t="s"><v>{idx}</v></c>'

def num_c(ref, n):
    return f'<c r="{ref}"><v>{n}</v></c>'

def sheet(rows):
    body = "".join(f'<row r="{i+1}">{"".join(cells)}</row>' for i, cells in enumerate(rows))
    return f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="{ns}"><sheetData>{body}</sheetData></worksheet>'

if mode == "inline":
    s1 = sheet([
        [inline_c("A1", "Last Name"), inline_c("B1", "First Name"), inline_c("C1", "Student ID")],
        [inline_c("A2", "Deng"), inline_c("B2", "Everette"), num_c("C2", "20285521")],
    ])
    s2 = sheet([
        [inline_c("A1", "Last Name"), inline_c("B1", "First Name"), inline_c("C1", "ID")],
        [inline_c("A2", "Bach"), inline_c("B2", "Mark"), num_c("C2", "101")],
    ])
    shared = None
else:
    s1 = sheet([
        [shared_c("A1", 0), shared_c("B1", 1), shared_c("C1", 2)],
        [shared_c("A2", 3), shared_c("B2", 4), num_c("C2", "20285458")],
    ])
    s2 = sheet([
        [shared_c("A1", 0), shared_c("B1", 1), shared_c("C1", 5)],
        [shared_c("A2", 6), shared_c("B2", 7), num_c("C2", "102")],
    ])
    items = "".join(f"<si><t>{t}</t></si>" for t in [
        "Last Name", "First Name", "Student ID", "Angadi", "Tanya", "ID", "Lawrence", "Wendy"
    ])
    shared = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="{ns}" count="8" uniqueCount="8">{items}</sst>'

wb = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="{ns}" xmlns:r="{rns}"><sheets><sheet name="11th - Class of 2028" sheetId="1" r:id="rId1"/><sheet name="Teachers" sheetId="2" r:id="rId2"/></sheets></workbook>'
wb_rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>'
pkg_rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
if shared:
    ct += '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
ct += "</Types>"

with zipfile.ZipFile(path, "w") as z:
    z.writestr("[Content_Types].xml", ct)
    z.writestr("_rels/.rels", pkg_rels)
    z.writestr("xl/workbook.xml", wb)
    z.writestr("xl/_rels/workbook.xml.rels", wb_rels)
    z.writestr("xl/worksheets/sheet1.xml", s1)
    z.writestr("xl/worksheets/sheet2.xml", s2)
    if shared:
        z.writestr("xl/sharedStrings.xml", shared)
`;

function mockReq(method, url) {
  return { method, url };
}

function mockRes() {
  /** @type {{ status: number, body: any }} */
  const out = { status: 0, body: null };
  return {
    out,
    writeHead(status) {
      out.status = status;
    },
    end(payload) {
      out.body = JSON.parse(String(payload));
    },
  };
}

describe("people source helpers", () => {
  it("flags business and noreply contacts", () => {
    assert.equal(
      looksLikeBusinessContact({
        first: "",
        last: "",
        organization: "Amazon.com",
        emails: "store-news@amazon.com",
      }),
      true
    );
    assert.equal(
      looksLikeBusinessContact({
        first: "Rajasi",
        last: "Saha",
        organization: "",
        emails: "rajasi@hotmail.com",
      }),
      false
    );
    assert.equal(looksLikeNoreplyAddress("no-reply@accounts.google.com"), true);
    assert.equal(looksLikeNoreplyAddress("rajasi@hotmail.com"), false);
    assert.equal(
      contactMatchesQuery(
        { name: "Rajasi Saha", emails: "rajasi@hotmail.com", phones: "+1 (425) 555-0100" },
        "rajasi"
      ),
      true
    );
    assert.equal(
      contactMatchesQuery(
        { name: "Rajasi Saha", emails: "rajasi@hotmail.com", phones: "+1 (425) 555-0100" },
        "4255550100"
      ),
      true
    );
    assert.equal(
      contactMatchesQuery({ name: "Rajasi Saha", emails: "", phones: "" }, "Everette"),
      false
    );
  });

  it("resolves missing school xlsx as empty", async () => {
    const path = await resolveSchoolXlsxPath(["/tmp/does-not-exist-school.xlsx"]);
    assert.equal(path, "");
    const payload = await loadSchoolNames({
      candidates: ["/tmp/does-not-exist-school.xlsx"],
    });
    assert.equal(payload.ok, false);
    assert.deepEqual(payload.people, []);
  });

  it("reads school names from inlineStr xlsx without sharedStrings.xml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "school-xlsx-"));
    const xlsx = join(dir, "roster.xlsx");
    try {
      await execFileAsync("python3", ["-c", BUILD_XLSX, xlsx, "inline"]);
      const payload = await loadSchoolNames({ path: xlsx });
      assert.equal(payload.ok, true);
      assert.equal(payload.count, 2);
      assert.deepEqual(
        payload.people.map((p) => ({
          first: p.first,
          last: p.last,
          id: p.id,
          kind: p.kind,
          classOf: p.classOf,
        })),
        [
          {
            first: "Everette",
            last: "Deng",
            id: "20285521",
            kind: "student",
            classOf: "2028",
          },
          {
            first: "Mark",
            last: "Bach",
            id: "101",
            kind: "teacher",
            classOf: null,
          },
        ]
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still reads school names from sharedStrings xlsx", async () => {
    const dir = await mkdtemp(join(tmpdir(), "school-xlsx-"));
    const xlsx = join(dir, "roster.xlsx");
    try {
      await execFileAsync("python3", ["-c", BUILD_XLSX, xlsx, "shared"]);
      const payload = await loadSchoolNames({ path: xlsx });
      assert.equal(payload.ok, true);
      assert.equal(payload.people[0].first, "Tanya");
      assert.equal(payload.people[0].last, "Angadi");
      assert.equal(payload.people[0].id, "20285458");
      assert.equal(payload.people[1].kind, "teacher");
      assert.equal(payload.people[1].id, "102");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("counts iMessage name mentions on a fixture db", async () => {
    const dir = await mkdtemp(join(tmpdir(), "imessage-people-"));
    const db = join(dir, "chat.db");
    try {
      await execFileAsync("sqlite3", [
        db,
        "CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, date INTEGER); INSERT INTO message (text, date) VALUES ('hanging with Everette', 1); INSERT INTO message (text, date) VALUES ('Everette sent photos', 2); INSERT INTO message (text, date) VALUES ('once Yulong', 3);",
      ]);
      const mentions = await countNameMentions(["Everette", "Yulong", "Nobody"], {
        db,
        minCount: 2,
      });
      assert.deepEqual(mentions, [{ name: "Everette", count: 2 }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("local ipc people routes", () => {
  it("serves contacts, iMessage people, mail, and school names", async () => {
    const handler = createLocalIpcHandler({
      listIMessagePeople: async () => [{ chat: "Rajasi", handle: "+1" }],
      listContacts: async () => [{ name: "Rajasi Saha" }],
      listMailCorrespondents: async () => ({
        ok: true,
        people: [{ name: "Rajasi Saha", address: "rajasi@hotmail.com" }],
      }),
      loadSchoolNames: async () => ({
        ok: true,
        people: [{ first: "Everette", last: "Deng" }],
      }),
    });
    const contactsRes = mockRes();
    await handler(mockReq("GET", "/contacts/list"), contactsRes);
    assert.equal(contactsRes.out.status, 200);
    assert.equal(contactsRes.out.body[0].name, "Rajasi Saha");

    const searchRes = mockRes();
    await handler(mockReq("GET", "/contacts/search?q=Rajasi"), searchRes);
    assert.equal(searchRes.out.status, 200);
    assert.equal(searchRes.out.body.length, 1);
    assert.equal(searchRes.out.body[0].name, "Rajasi Saha");

    const missRes = mockRes();
    await handler(mockReq("GET", "/contacts/search?q=Everette"), missRes);
    assert.equal(missRes.out.body.length, 0);

    const peopleRes = mockRes();
    await handler(mockReq("GET", "/imessage/people"), peopleRes);
    assert.equal(peopleRes.out.status, 200);
    assert.equal(peopleRes.out.body[0].chat, "Rajasi");

    const mailRes = mockRes();
    await handler(mockReq("GET", "/mail/people"), mailRes);
    assert.equal(mailRes.out.body.people[0].address, "rajasi@hotmail.com");

    const schoolRes = mockRes();
    await handler(mockReq("GET", "/school/names"), schoolRes);
    assert.equal(schoolRes.out.body.people[0].first, "Everette");
  });

  it("starts people bootstrap in the background", async () => {
    let called = null;
    const handler = createLocalIpcHandler({
      runContextSynthesis: async (opts) => {
        called = opts;
        return { ok: true };
      },
    });
    const res = mockRes();
    await handler(mockReq("POST", "/jobs/bootstrap-people"), res);
    assert.equal(res.out.status, 202);
    assert.equal(res.out.body.bootstrapPeople, true);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(called?.bootstrapPeople, true);
  });
});
