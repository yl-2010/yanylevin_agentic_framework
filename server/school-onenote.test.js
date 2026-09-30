import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GRAPH_BASE,
  SCHOOL_EMAIL,
  buildNotebooksUrl,
  buildPageContentUrl,
  buildPagesUrl,
  buildSearchUrl,
  buildSiteByPathUrl,
  buildSitePageContentUrl,
  flattenNotebookSections,
  pickSection,
  sharePointSitePathFromUrl,
  isGraphExplorerUrl,
  isMicrosoftLoginUrl,
  isNotesToken,
  looksLikeSchoolAccountLabel,
  normalizePage,
  oneNoteClientUrl,
  parseArgs,
  pickByName,
  runSchoolOnenote,
  schoolAccountSelectors,
  tokenFromUrl,
} from "./school-onenote.js";

function fakeJwt(payload) {
  const h = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${h}.${p}.sig`;
}

describe("school-onenote parseArgs", () => {
  it("parses link-todos dry-run", () => {
    const a = parseArgs(["link-todos", "--dry-run"]);
    assert.equal(a.cmd, "link-todos");
    assert.equal(a.dryRun, true);
  });

  it("parses notebooks and section flags", () => {
    const a = parseArgs(["sections", "--notebook", "Spanish", "4", "--limit", "8"]);
    assert.equal(a.cmd, "sections");
    assert.equal(a.notebook, "Spanish 4");
    assert.equal(a.limit, 8);
  });

  it("joins search words until a flag", () => {
    const a = parseArgs(["search", "colonial", "map", "--limit", "3"]);
    assert.equal(a.query, "colonial map");
    assert.equal(a.limit, 3);
  });

  it("reads a page id", () => {
    const a = parseArgs(["page", "1-abc"]);
    assert.equal(a.id, "1-abc");
  });

  it("rejects unknown flags", () => {
    assert.throws(() => parseArgs(["notebooks", "--nope"]), /unknown arg/);
  });
});

describe("school-onenote tokens", () => {
  it("accepts a Graph token with Notes.Read", () => {
    const token = fakeJwt({
      aud: "https://graph.microsoft.com",
      scp: "User.Read Notes.Read Notes.Read.All",
      preferred_username: "owner@school.example",
    });
    assert.equal(isNotesToken(token), true);
  });

  it("rejects Outlook-audience tokens even with Notes scopes", () => {
    const token = fakeJwt({
      aud: "https://outlook.office.com",
      scp: "Mail.Read Notes.ReadWrite",
    });
    assert.equal(isNotesToken(token), false);
  });

  it("rejects Graph tokens without Notes scopes", () => {
    const token = fakeJwt({
      aud: "https://graph.microsoft.com",
      scp: "Files.ReadWrite.All User.Read",
    });
    assert.equal(isNotesToken(token), false);
  });

  it("pulls an access_token from a redirect hash", () => {
    const token = fakeJwt({
      aud: "https://graph.microsoft.com",
      scp: "Notes.Read",
    });
    const url = `https://outlook.office.com/mail/#access_token=${token}&token_type=Bearer`;
    assert.equal(tokenFromUrl(url), token);
  });
});

describe("school-onenote login screens", () => {
  it("spots Microsoft account-picker hosts", () => {
    assert.equal(
      isMicrosoftLoginUrl(
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
      ),
      true
    );
    assert.equal(
      isMicrosoftLoginUrl("https://developer.microsoft.com/en-us/graph/graph-explorer"),
      false
    );
  });

  it("spots Graph Explorer", () => {
    assert.equal(
      isGraphExplorerUrl(
        "https://developer.microsoft.com/en-us/graph/graph-explorer?request=me/onenote/notebooks"
      ),
      true
    );
    assert.equal(isGraphExplorerUrl("https://login.microsoftonline.com/"), false);
  });

  it("matches the school account tile, including Sign in with email", () => {
    assert.equal(
      looksLikeSchoolAccountLabel("Sign in with owner@school.example"),
      true
    );
    assert.equal(looksLikeSchoolAccountLabel("Yan Levin\nowner@school.example"), true);
    assert.equal(looksLikeSchoolAccountLabel("Sign in with another account"), false);
    assert.equal(schoolAccountSelectors()[0], `[data-test-id="${SCHOOL_EMAIL}"]`);
  });
});

describe("school-onenote urls and shapes", () => {
  it("keeps the OneNote client URL and falls back to onenote: plus https", () => {
    assert.equal(
      oneNoteClientUrl("https://example.com/p", {
        oneNoteClientUrl: { href: "onenote:https://example.com/client" },
      }),
      "onenote:https://example.com/client"
    );
    const page = normalizePage({
      id: "1-x",
      title: "Day 1 problem set",
      links: { oneNoteWebUrl: { href: "https://example.com/p" } },
    });
    assert.equal(page.webUrl, "https://example.com/p");
    assert.equal(page.clientUrl, "onenote:https://example.com/p");
  });

  it("builds Graph notebook and page URLs", () => {
    assert.match(buildNotebooksUrl(), /\/me\/onenote\/notebooks/);
    assert.equal(buildPageContentUrl("1-x"), `${GRAPH_BASE}/me/onenote/pages/1-x/content`);
    assert.match(buildPagesUrl("sec1", { limit: 5 }), /\/sections\/sec1\/pages/);
    assert.match(buildSearchUrl("map"), /\$search=/);
    assert.doesNotMatch(buildSearchUrl("map"), /\$select=/);
    assert.match(
      buildSiteByPathUrl("eastsidepreparatory.sharepoint.com", "/sites/6F59235AD9_Team"),
      /\/sites\/eastsidepreparatory\.sharepoint\.com:\/sites\/6F59235AD9_Team$/
    );
    assert.match(
      buildSitePageContentUrl("site-id", "1-x"),
      /\/sites\/site-id\/onenote\/pages\/1-x\/content$/
    );
  });

  it("parses a Teams Class Notebook SharePoint URL", () => {
    const site = sharePointSitePathFromUrl(
      "https://eastsidepreparatory.sharepoint.com/sites/6F59235AD9_Team/SiteAssets/Spanish%204%20-%202026-2027"
    );
    assert.deepEqual(site, {
      hostname: "eastsidepreparatory.sharepoint.com",
      path: "/sites/6F59235AD9_Team",
    });
    assert.equal(sharePointSitePathFromUrl("https://example.com/foo"), null);
  });

  it("picks a Content Library section when the name is duplicated", () => {
    const rows = [
      { id: "a", name: "Notas de clase", group: "_Content Library" },
      { id: "b", name: "Notas de clase", group: "Yan Levin" },
    ];
    assert.equal(pickSection(rows, "Notas de clase").ambiguous.length, 2);
    assert.equal(
      pickSection(rows, "_Content Library/Notas de clase").match.id,
      "a"
    );
  });

  it("flattens class-notebook section groups", () => {
    const rows = flattenNotebookSections({
      sections: [{ id: "a", displayName: "Quick Notes" }],
      sectionGroups: [
        {
          displayName: "_Content Library",
          sections: [{ id: "b", displayName: "Tri 1" }],
        },
      ],
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[1].group, "_Content Library");
    assert.equal(rows[1].name, "Tri 1");
  });

  it("picks a unique notebook name", () => {
    const rows = [
      { name: "Spanish 4" },
      { name: "Spanish 3 (25-26)" },
    ];
    assert.equal(pickByName(rows, "spanish 4").match.name, "Spanish 4");
    assert.equal(pickByName(rows, "spanish").ambiguous.length, 2);
  });
});

describe("school-onenote status", () => {
  it("reports signedOut on an empty profile dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "school-onenote-"));
    try {
      const r = await runSchoolOnenote(["status"], { root: dir });
      assert.equal(r.ok, true);
      assert.equal(r.signedIn, false);
      assert.equal(r.account, "owner@school.example");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("notebooks without a session returns not signed in", async () => {
    const dir = await mkdtemp(join(tmpdir(), "school-onenote-"));
    try {
      const r = await runSchoolOnenote(["notebooks"], { root: dir });
      assert.equal(r.ok, false);
      assert.equal(r.error, "not signed in");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not treat a mail token session as signed in", async () => {
    const dir = await mkdtemp(join(tmpdir(), "school-onenote-"));
    try {
      const token = fakeJwt({
        aud: "https://outlook.office.com",
        scp: "Mail.Read Notes.ReadWrite",
        exp: 2_000_000_000,
        preferred_username: "owner@school.example",
      });
      await writeFile(
        join(dir, "session.json"),
        JSON.stringify({ token, exp: 2_000_000_000, email: "owner@school.example" })
      );
      const r = await runSchoolOnenote(["status"], { root: dir });
      assert.equal(r.signedIn, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
