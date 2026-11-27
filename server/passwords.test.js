import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  fillAccount,
  importCsv,
  listAccounts,
  otpAccount,
  passwordsDir,
  readPasswordAccess,
  setMacPassword,
  totpCode,
  unlockDialog,
} from "./passwords.js";

const CSV_HEADER = "Title,URL,Username,Password,Notes,OTPAuth";
const OTP = "otpauth://totp/GitHub:yan?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=GitHub";

function vaultOpts(dir) {
  return { dir, backend: "file" };
}

async function writeCsv(dir, name, body) {
  const file = join(dir, name);
  await writeFile(file, body);
  return file;
}

test("totp matches the RFC 6238 SHA1 vector", () => {
  assert.equal(totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000), "287082");
  assert.equal(
    totpCode(
      "otpauth://totp/Test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8",
      59_000
    ),
    "94287082"
  );
});

test("import, list, fill, and a second import", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yl-passwords-"));
  const opts = vaultOpts(dir);
  const first = await writeCsv(
    dir,
    "one.csv",
    [
      CSV_HEADER,
      `GitHub,https://github.com/login,yan,"sec,ret",remember,${OTP}`,
      "Old,https://old.example/login,yan,keep-me,,",
      "Same,https://same.example,yan,same-pass,,",
    ].join("\n")
  );

  const counts = await importCsv(first, opts);
  assert.deepEqual(counts, { added: 3, updated: 0, unchanged: 0 });
  await assert.rejects(() => stat(first));

  const listed = await listAccounts(opts);
  const blob = JSON.stringify(listed);
  assert.equal(listed.length, 3);
  assert.equal(listed.some((row) => "password" in row || "notes" in row || "otp" in row), false);
  assert.doesNotMatch(blob, /sec,ret/);
  assert.doesNotMatch(blob, /keep-me/);
  assert.doesNotMatch(blob, /GEZDGNBVGY3TQOJQ/);
  const github = listed.find((row) => row.title === "GitHub");
  assert.equal(github.username, "yan");
  assert.equal(github.url, "https://github.com/login");
  assert.equal(github.hasOtp, true);
  const queried = await listAccounts({ ...opts, query: "old.example" });
  assert.equal(queried.length, 1);
  assert.equal(queried[0].title, "Old");

  await assert.rejects(
    () => fillAccount({ ...opts, id: github.id, reason: "  ", browser: "ardia", ref: "e1" }),
    /reason/
  );
  assert.equal((await readPasswordAccess(opts)).length, 0);

  let typed = "";
  const filled = await fillAccount({
    ...opts,
    id: github.id,
    reason: "Sign in to GitHub to read the repo",
    browser: "ardia",
    ref: "e11",
    typePassword: async ({ secret }) => {
      typed = secret;
    },
  });
  assert.deepEqual(filled, { ok: true, filled: true });
  assert.equal(typed, "sec,ret");
  assert.equal(JSON.stringify(filled).includes("sec,ret"), false);
  const log = await readPasswordAccess(opts);
  assert.equal(log.length, 1);
  assert.equal(log[0].title, "GitHub");
  assert.equal(log[0].url, "https://github.com/login");
  assert.equal(log[0].username, "yan");
  assert.equal(log[0].reason, "Sign in to GitHub to read the repo");
  assert.equal(JSON.stringify(log).includes("sec,ret"), false);

  const code = await otpAccount({
    ...opts,
    id: github.id,
    reason: "GitHub 2FA",
    now: 59_000,
  });
  assert.equal(code.code, "287082");
  const afterOtp = await readPasswordAccess(opts);
  assert.equal(afterOtp[0].reason, "GitHub 2FA");
  assert.equal(JSON.stringify(afterOtp).includes("GEZDGNBVGY3TQOJQ"), false);

  const second = await writeCsv(
    dir,
    "two.csv",
    [
      CSV_HEADER,
      "GitHub,https://github.com/login,yan,secret-two,,",
      "New,https://new.example,yan,fresh,,",
      "Same,https://same.example,yan,same-pass,,",
    ].join("\n")
  );
  const again = await importCsv(second, opts);
  assert.equal(again.added, 1);
  assert.equal(again.updated, 1);
  assert.equal(again.unchanged, 1);
  const old = (await listAccounts(opts)).find((row) => row.title === "Old");
  assert.ok(old);
  let kept = "";
  await fillAccount({
    ...opts,
    id: old.id,
    reason: "Old site still there",
    browser: "chrome",
    ref: "4",
    typePassword: async ({ secret }) => {
      kept = secret;
    },
  });
  assert.equal(kept, "keep-me");
  let next = "";
  await fillAccount({
    ...opts,
    id: github.id,
    reason: "Updated GitHub password",
    browser: "ardia",
    ref: "e2",
    typePassword: async ({ secret }) => {
      next = secret;
    },
  });
  assert.equal(next, "secret-two");
});

test("a bad CSV is left on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yl-passwords-bad-"));
  const file = await writeCsv(dir, "bad.csv", "name,value\nnope,x\n");
  await assert.rejects(() => importCsv(file, vaultOpts(dir)), /title column/);
  const still = await readFile(file, "utf8");
  assert.match(still, /nope/);
});

test("file backend cannot use the real directory", async () => {
  await assert.rejects(
    () => listAccounts({ dir: passwordsDir(), backend: "file" }),
    /real password directory/
  );
});

test("fill without a reason writes nothing from the CLI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yl-passwords-cli-"));
  const file = await writeCsv(
    dir,
    "cli.csv",
    `${CSV_HEADER}\nGitHub,https://github.com/login,yan,secret-one,,\n`
  );
  await importCsv(file, vaultOpts(dir));
  const id = (await listAccounts(vaultOpts(dir)))[0].id;
  const script = fileURLToPath(new URL("./passwords.js", import.meta.url));
  const child = spawn(process.execPath, [script, "fill", "--id", id, "--browser", "ardia", "--ref", "e1"], {
    env: { ...process.env, PASSWORDS_DIR: dir, PASSWORDS_BACKEND: "file" },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /reason/);
  assert.equal((await readPasswordAccess(vaultOpts(dir))).length, 0);
  const raw = await readFile(join(dir, "secrets", "yanylevin.passwords", id), "utf8");
  assert.equal(raw, "secret-one");
});

test("unlock-dialog types only when Passwords or a system dialog is in front", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yl-passwords-mac-"));
  const opts = vaultOpts(dir);
  await setMacPassword("studio-secret", opts);
  let typed = "";
  await assert.rejects(
    () =>
      unlockDialog({
        ...opts,
        reason: "Read a code",
        frontmostApp: async () => "Safari",
        typePassword: async ({ secret }) => {
          typed = secret;
        },
      }),
    /in front/
  );
  assert.equal(typed, "");
  assert.equal((await readPasswordAccess(opts)).length, 0);

  const result = await unlockDialog({
    ...opts,
    reason: "Read the GitHub code in Passwords",
    frontmostApp: async () => "Passwords",
    typePassword: async ({ secret }) => {
      typed = secret;
    },
  });
  assert.deepEqual(result, { ok: true, typed: true });
  assert.equal(typed, "studio-secret");
  const log = await readPasswordAccess(opts);
  assert.equal(log[0].title, "Mac login");
  assert.equal(log[0].reason, "Read the GitHub code in Passwords");
  assert.equal(JSON.stringify(log).includes("studio-secret"), false);
});

test("the access reader drops a password field someone stuffed into the log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yl-passwords-poison-"));
  const { appendFile, mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  await appendFile(
    join(dir, "access.jsonl"),
    `${JSON.stringify({
      at: "2026-11-26T01:00:00.000Z",
      title: "GitHub",
      url: "https://github.com",
      username: "yan",
      reason: "test",
      password: "should-not-surface",
    })}\n`
  );
  const rows = await readPasswordAccess(vaultOpts(dir));
  assert.equal(rows.length, 1);
  assert.equal("password" in rows[0], false);
  assert.equal(JSON.stringify(rows).includes("should-not-surface"), false);
});
