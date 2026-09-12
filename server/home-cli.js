/**
 * Apple Home CLI wrapper for Yan's Personal Agent.
 * Builds macos/YLHome (Mac Catalyst + HomeKit) on first use.
 */

import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(ROOT, "macos/YLHome");
const APP = join(SRC_DIR, "yl-home.app");
const BIN = join(APP, "Contents/MacOS/yl-home");
const PROJECT_YML = join(SRC_DIR, "project.yml");
const XCODEPROJ = join(SRC_DIR, "YLHome.xcodeproj");
const DERIVED = join(SRC_DIR, "DerivedData");
const TEAM = "YOUR_TEAM_ID";

const SRC_FILES = [
  join(SRC_DIR, "AppDelegate.swift"),
  join(SRC_DIR, "HomeCLI.swift"),
  join(SRC_DIR, "Info.plist"),
  join(SRC_DIR, "YLHome.entitlements"),
  PROJECT_YML,
];

/** @type {Promise<string>|null} */
let compiling = null;

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function newestMtime(paths) {
  const stats = await Promise.all(paths.map((p) => stat(p)));
  return Math.max(...stats.map((s) => s.mtimeMs));
}

async function binNeedsBuild() {
  if (!(await exists(BIN))) return true;
  try {
    const binStat = await stat(BIN);
    const present = [];
    for (const p of SRC_FILES) {
      if (await exists(p)) present.push(p);
    }
    if (!present.length) return true;
    return (await newestMtime(present)) > binStat.mtimeMs;
  } catch {
    return true;
  }
}

function xcodegenBin() {
  return process.env.XCODEGEN || "xcodegen";
}

async function ensureXcodeproj() {
  const ymlStat = await stat(PROJECT_YML);
  if (await exists(join(XCODEPROJ, "project.pbxproj"))) {
    const projStat = await stat(join(XCODEPROJ, "project.pbxproj"));
    if (projStat.mtimeMs >= ymlStat.mtimeMs) return;
  }
  await execFileAsync(xcodegenBin(), ["generate"], {
    cwd: SRC_DIR,
    timeout: 60_000,
  });
  const plist = await readFile(join(SRC_DIR, "Info.plist"), "utf8");
  if (!plist.includes("NSHomeKitUsageDescription")) {
    throw new Error("xcodegen wiped NSHomeKitUsageDescription from Info.plist");
  }
}

function builtAppPath() {
  return join(DERIVED, "Build/Products/Release-maccatalyst/yl-home.app");
}

async function buildApp() {
  await ensureXcodeproj();
  try {
    await execFileAsync(
      "xcodebuild",
      [
        "-project",
        XCODEPROJ,
        "-scheme",
        "YLHome",
        "-configuration",
        "Release",
        "-destination",
        "platform=macOS,arch=arm64,variant=Mac Catalyst,name=My Mac",
        "-derivedDataPath",
        DERIVED,
        "-allowProvisioningUpdates",
        "-allowProvisioningDeviceRegistration",
        `DEVELOPMENT_TEAM=${TEAM}`,
        "CODE_SIGN_STYLE=Automatic",
        "CODE_SIGN_IDENTITY=Apple Development",
        "SUPPORTS_MACCATALYST=YES",
      ],
      { cwd: SRC_DIR, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }
    );
  } catch (err) {
    const detail = String(err.stderr || err.stdout || err.message || err);
    if (/homekit not found/i.test(detail)) {
      throw new Error(
        "HomeKit entitlement is not available on this Apple Developer team (Personal Team). Enroll in the paid Apple Developer Program, enable HomeKit on com.yanylevin.yl-home, then rebuild. Same paid-team gate as Sign in with Apple and App Groups on the iOS app."
      );
    }
    throw new Error(detail.slice(-2500) || "xcodebuild failed");
  }
  const built = builtAppPath();
  if (!(await exists(join(built, "Contents/MacOS/yl-home")))) {
    throw new Error(`xcodebuild finished but ${built} is missing`);
  }
  await rm(APP, { recursive: true, force: true });
  await execFileAsync("cp", ["-R", built, APP], { timeout: 15_000 });
}

export async function ensureHomeBin() {
  if (!(await binNeedsBuild())) return BIN;
  if (compiling) return compiling;
  compiling = (async () => {
    await buildApp();
    return BIN;
  })().finally(() => {
    compiling = null;
  });
  return compiling;
}

/**
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function runHome(args, opts = {}) {
  const bin = await ensureHomeBin();
  const dir = await mkdtemp(join(tmpdir(), "yl-home-"));
  const outFile = join(dir, "out.json");
  try {
    const { stdout, stderr } = await execFileAsync(bin, [...args, "--out", outFile], {
      timeout: opts.timeoutMs || 70_000,
      maxBuffer: 4 * 1024 * 1024,
    }).catch(async (err) => {
      const fromFile = await readJsonIfPresent(outFile);
      if (fromFile) return { stdout: JSON.stringify(fromFile), stderr: String(err.stderr || "") };
      throw err;
    });
    const fromFile = await readJsonIfPresent(outFile);
    if (fromFile) return fromFile;
    const text = String(stdout || "").trim();
    if (!text) {
      const err = String(stderr || "").trim();
      throw new Error(err || "yl-home produced no output");
    }
    const line = text.split("\n").filter(Boolean).at(-1);
    return JSON.parse(line);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readJsonIfPresent(path) {
  try {
    const raw = await readFile(path, "utf8");
    const text = raw.trim();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const isCli =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  runHome(process.argv.slice(2))
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      if (r && r.ok === false) process.exit(1);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
