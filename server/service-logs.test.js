import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import {
  SERVICE_LOG_DIR,
  SERVICE_LOG_ARCHIVE_DIR,
  SERVICE_LOGS,
  SERVICE_LOG_FILES,
  SERVER_LOG_PATH,
  AGENT_WORKER_LOG_PATH,
} from "./service-logs.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROTATE_SCRIPT = join(REPO_ROOT, "scripts/rotate-service-logs.sh");

describe("service-logs", () => {
  it("puts every service log under ~/Library/Logs/yanylevin", () => {
    const dir = join(homedir(), "Library/Logs/yanylevin");
    assert.equal(SERVICE_LOG_DIR, dir);
    assert.equal(SERVICE_LOG_ARCHIVE_DIR, join(dir, "archive"));
    assert.equal(SERVER_LOG_PATH, join(dir, "personal-agent-server.log"));
    assert.equal(AGENT_WORKER_LOG_PATH, join(dir, "personal-agent-worker.log"));
    for (const [name, file] of Object.entries(SERVICE_LOG_FILES)) {
      assert.equal(SERVICE_LOGS[name], join(dir, file), name);
      assert.ok(file.endsWith(".log"), name);
      assert.ok(!file.includes("/"), name);
    }
  });
});

describe("rotate-service-logs.sh", () => {
  it("copy-truncates live logs and gzips a dated archive", () => {
    const root = mkdtempSync(join(tmpdir(), "yl-logrotate-"));
    const archive = join(root, "archive");
    const live = join(root, "personal-agent-server.log");
    writeFileSync(live, "yesterday-line\n");
    const result = spawnSync("bash", [ROTATE_SCRIPT], {
      env: {
        ...process.env,
        SERVICE_LOG_DIR: root,
        SERVICE_LOG_ARCHIVE_DIR: archive,
        ROTATE_STAMP: "2026-11-11",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(live, "utf8"), "");
    const gz = join(archive, "yanylevin-server-2026-11-11.log.gz");
    assert.equal(existsSync(gz), true, result.stdout);
    assert.equal(gunzipSync(readFileSync(gz)).toString(), "yesterday-line\n");
  });

  it("merges into an existing same-stamp archive instead of replacing it", () => {
    const root = mkdtempSync(join(tmpdir(), "yl-logrotate-"));
    const archive = join(root, "archive");
    const live = join(root, "personal-agent-server.log");
    writeFileSync(live, "first\n");
    const env = {
      ...process.env,
      SERVICE_LOG_DIR: root,
      SERVICE_LOG_ARCHIVE_DIR: archive,
      ROTATE_STAMP: "2026-11-11",
    };
    let result = spawnSync("bash", [ROTATE_SCRIPT], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    writeFileSync(live, "second\n");
    result = spawnSync("bash", [ROTATE_SCRIPT], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const gz = join(archive, "yanylevin-server-2026-11-11.log.gz");
    assert.equal(gunzipSync(readFileSync(gz)).toString(), "first\nsecond\n");
    assert.equal(readFileSync(live, "utf8"), "");
  });

  it("skips missing or empty logs", () => {
    const root = mkdtempSync(join(tmpdir(), "yl-logrotate-"));
    const archive = join(root, "archive");
    writeFileSync(join(root, "personal-agent-server.log"), "");
    const result = spawnSync("bash", [ROTATE_SCRIPT], {
      env: {
        ...process.env,
        SERVICE_LOG_DIR: root,
        SERVICE_LOG_ARCHIVE_DIR: archive,
        ROTATE_STAMP: "2026-11-11",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(join(archive, "yanylevin-server-2026-11-11.log.gz")), false);
  });
});
