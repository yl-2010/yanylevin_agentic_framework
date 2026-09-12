import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("home-cli source", () => {
  it("builds the Catalyst helper and exposes HomeKit commands", async () => {
    const js = await readFile(join(ROOT, "server/home-cli.js"), "utf8");
    assert.match(js, /macos\/YLHome/);
    assert.match(js, /xcodebuild/);
    assert.match(js, /Mac Catalyst/);
    assert.match(js, /com\.apple\.developer\.homekit|DEVELOPMENT_TEAM/);
    const swift = await readFile(join(ROOT, "macos/YLHome/HomeCLI.swift"), "utf8");
    assert.match(swift, /HMHomeManager/);
    assert.match(swift, /HMCharacteristicTypeBrightness/);
    assert.match(swift, /func coerce/);
    const entitlements = await readFile(
      join(ROOT, "macos/YLHome/YLHome.entitlements"),
      "utf8"
    );
    assert.match(entitlements, /com\.apple\.developer\.homekit/);
  });
});
