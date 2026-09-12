import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expandHomeArgs,
  findHomeclawCli,
  HOMECLAW_CLI_IN_APP,
  MAS_URL,
  missingInstallMessage,
  parseSetPairs,
  runHome,
} from "./home-cli.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("home-cli HomeClaw wrapper", () => {
  it("wraps homeclaw-cli instead of compiling yl-home", async () => {
    const js = await readFile(join(ROOT, "server/home-cli.js"), "utf8");
    assert.match(js, /homeclaw-cli/);
    assert.match(js, /HomeClaw\.app/);
    assert.match(js, /id6759682551/);
    assert.doesNotMatch(js, /xcodebuild/);
    assert.doesNotMatch(js, /DEVELOPMENT_TEAM/);
  });

  it("maps on/off/lock aliases to HomeClaw characteristics", () => {
    assert.deepEqual(parseSetPairs(["on"]), [["power", "true"]]);
    assert.deepEqual(parseSetPairs(["off"]), [["power", "false"]]);
    assert.deepEqual(parseSetPairs(["brightness", "40"]), [["brightness", "40"]]);
    assert.deepEqual(parseSetPairs(["lock", "locked"]), [
      ["lock_target_state", "locked"],
    ]);
    assert.deepEqual(parseSetPairs(["on", "brightness", "70"]), [
      ["power", "true"],
      ["brightness", "70"],
    ]);
    assert.deepEqual(expandHomeArgs(["homes"]), [["status"]]);
    assert.deepEqual(expandHomeArgs(["rooms"]), [["list"]]);
    assert.deepEqual(expandHomeArgs(["list", "--type", "lightbulb"]), [
      ["list", "--category", "lightbulb"],
    ]);
    assert.deepEqual(
      expandHomeArgs(["set", "Kitchen Light", "on", "brightness", "40"]),
      [
        ["set", "Kitchen Light", "power", "true"],
        ["set", "Kitchen Light", "brightness", "40"],
      ]
    );
    assert.deepEqual(
      expandHomeArgs([
        "set",
        "Switch",
        "power",
        "true",
        "--service-index",
        "2",
      ]),
      [["set", "Switch", "power", "true", "--service-index", "2"]]
    );
  });

  it("points at the App Store when HomeClaw is missing", async () => {
    assert.match(missingInstallMessage(), /id6759682551/);
    assert.equal(MAS_URL.includes("id6759682551"), true);
    const fake = "/tmp/yanylevin-no-homeclaw-cli";
    await assert.rejects(
      () => runHome(["status"], { bin: fake }),
      (err) => {
        assert.match(String(err.message), /ENOENT|homeclaw-cli failed|not installed/i);
        return true;
      }
    );
  });

  it("looks in /Applications/HomeClaw.app for the CLI", () => {
    assert.equal(
      HOMECLAW_CLI_IN_APP,
      "/Applications/HomeClaw.app/Contents/MacOS/homeclaw-cli"
    );
    assert.equal(typeof findHomeclawCli, "function");
  });
});
