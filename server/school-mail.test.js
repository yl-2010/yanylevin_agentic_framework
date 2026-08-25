import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiBaseForAudience,
  buildDumpUrl,
  buildListUrl,
  buildReadUrl,
  GRAPH_BASE,
  groupMessagesByMonth,
  isMailToken,
  isSessionFresh,
  jwtEmail,
  jwtExp,
  normalizeMessage,
  OUTLOOK_REST_BASE,
  parseArgs,
  redactSecrets,
  runSchoolMail,
  stripHtml,
  tokenAudience,
} from "./school-mail.js";

function fakeJwt(payload) {
  const h = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${h}.${p}.sig`;
}

describe("school-mail parseArgs", () => {
  it("parses inbox limit", () => {
    const a = parseArgs(["inbox", "--limit", "5"]);
    assert.equal(a.cmd, "inbox");
    assert.equal(a.limit, 5);
  });

  it("joins search words until a flag", () => {
    const a = parseArgs(["search", "from Kirsten", "Lunstrum", "--limit", "3"]);
    assert.equal(a.query, "from Kirsten Lunstrum");
    assert.equal(a.limit, 3);
  });

  it("reads a message id", () => {
    const a = parseArgs(["read", "AAMkAGI="]);
    assert.equal(a.id, "AAMkAGI=");
  });

  it("rejects unknown flags", () => {
    assert.throws(() => parseArgs(["inbox", "--nope"]), /unknown arg/);
  });
});

describe("school-mail tokens", () => {
  it("reads graph audience and email from a JWT", () => {
    const token = fakeJwt({
      aud: "https://graph.microsoft.com",
      exp: 2_000_000_000,
      preferred_username: "owner@school.example",
    });
    assert.equal(tokenAudience(token), "https://graph.microsoft.com");
    assert.equal(jwtEmail(token), "owner@school.example");
    assert.equal(jwtExp(token), 2_000_000_000);
    assert.equal(isMailToken(token), true);
    assert.equal(apiBaseForAudience(tokenAudience(token)), GRAPH_BASE);
  });

  it("routes Outlook REST audiences to the OWA API", () => {
    const token = fakeJwt({ aud: "https://outlook.office.com" });
    assert.equal(isMailToken(token), true);
    assert.equal(apiBaseForAudience(tokenAudience(token)), OUTLOOK_REST_BASE);
  });

  it("rejects unrelated tokens", () => {
    assert.equal(isMailToken(fakeJwt({ aud: "https://www.office.com" })), false);
  });

  it("treats a session as stale near expiry", () => {
    const now = 1_700_000_000_000;
    assert.equal(isSessionFresh({ token: "x", exp: now / 1000 + 30 }, now), false);
    assert.equal(isSessionFresh({ token: "x", exp: now / 1000 + 600 }, now), true);
  });
});

describe("school-mail messages", () => {
  it("normalizes Graph and Outlook REST shapes", () => {
    const graph = normalizeMessage({
      id: "g1",
      subject: "Hello",
      from: { emailAddress: { name: "Kirsten", address: "k@school.example" } },
      receivedDateTime: "2026-08-21T12:00:00Z",
      isRead: false,
      bodyPreview: "hi",
    });
    assert.equal(graph.from, "Kirsten <k@school.example>");
    assert.equal(graph.unread, true);

    const rest = normalizeMessage({
      Id: "r1",
      Subject: "Hello",
      From: { EmailAddress: { Name: "Kirsten", Address: "k@school.example" } },
      ReceivedDateTime: "2026-08-21T12:00:00Z",
      IsRead: true,
      BodyPreview: "hi",
    });
    assert.equal(rest.id, "r1");
    assert.equal(rest.unread, false);
  });

  it("strips html bodies", () => {
    assert.equal(stripHtml("<p>Hi <b>Yan</b></p>"), "Hi Yan");
  });

  it("builds dump URLs with a receivedDateTime filter", () => {
    const url = buildDumpUrl(GRAPH_BASE, { since: "2024-06-01", limit: 50, includeBody: true });
    assert.match(url, /\/me\/messages\?/);
    assert.match(url, /receivedDateTime/);
    assert.match(url, /isDraft/);
  });

  it("groups messages by month", () => {
    const groups = groupMessagesByMonth([
      { received: "2026-08-20T16:11:24Z", subject: "a" },
      { received: "2026-07-01T00:00:00Z", subject: "b" },
      { received: "2026-08-01T00:00:00Z", subject: "c" },
    ]);
    assert.deepEqual(groups.map(([k, rows]) => [k, rows.length]), [
      ["2026-07", 1],
      ["2026-08", 2],
    ]);
  });

  it("redacts bearer tokens", () => {
    const out = redactSecrets("Authorization: Bearer eyJhbGciOi.abc.def extra");
    assert.match(out, /\[redacted\]/);
    assert.doesNotMatch(out, /eyJhbGciOi/);
  });
});

describe("school-mail status", () => {
  it("reports signedOut on an empty profile dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "school-mail-"));
    try {
      const r = await runSchoolMail(["status"], { root: dir });
      assert.equal(r.ok, true);
      assert.equal(r.signedIn, false);
      assert.equal(r.account, "owner@school.example");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("inbox without a session returns not signed in", async () => {
    const dir = await mkdtemp(join(tmpdir(), "school-mail-"));
    try {
      const r = await runSchoolMail(["inbox"], { root: dir });
      assert.equal(r.ok, false);
      assert.equal(r.error, "not signed in");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
