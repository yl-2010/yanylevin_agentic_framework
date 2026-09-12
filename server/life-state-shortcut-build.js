/**
 * Build and sign the iPhone "Yan Life State Dock" Shortcut.
 * POSTs going_to_shower / going_to_sleep. Yan adds orientation, Bedroom
 * Boolean, and If/Otherwise himself. Token from LOCATION_INGEST_TOKEN or
 * HEALTH_INGEST_TOKEN. people-who-know-me still imports on Yan's iPhone.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = join(ROOT, "ios", "shortcuts", "yan-life-state-dock");
const SOURCE_PLIST = join(SOURCE_DIR, "workflow.plist");
export const TOKEN_PLACEHOLDER = "__LOCATION_INGEST_TOKEN__";
export const URL_PLACEHOLDER = "__LIFE_STATE_INTENT_URL__";
export const DEFAULT_URL = "https://api.yanylevin.com/api/education/life-state-intent";
export const SHORTCUT_NAME = "Yan Life State Dock";
const ICLOUD_DIR = join(
  homedir(),
  "Library/Mobile Documents/com~apple~CloudDocs/YanLifeState"
);

function stableUuid(name) {
  const hex = createHash("sha256").update(`yan-life-state-dock:${name}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`.toUpperCase();
}

function actionOutput(uuid, name) {
  return {
    Value: {
      OutputName: name,
      OutputUUID: uuid,
      Type: "ActionOutput",
    },
    WFSerializationType: "WFTextTokenAttachment",
  };
}

function namedVariable(name) {
  return {
    Value: {
      Type: "Variable",
      VariableName: name,
    },
    WFSerializationType: "WFTextTokenAttachment",
  };
}

function textToken(string) {
  return {
    Value: { string },
    WFSerializationType: "WFTextTokenString",
  };
}

function dictItem(key, value, itemType = 0) {
  const item = {
    WFItemType: itemType,
    WFKey: textToken(key),
  };
  if (value && typeof value === "object" && value.WFSerializationType) {
    item.WFValue = value;
  } else {
    item.WFValue = textToken(String(value ?? ""));
  }
  return item;
}

function setVariableText(id, name, string) {
  return {
    WFWorkflowActionIdentifier: "is.workflow.actions.setvariable",
    WFWorkflowActionParameters: {
      UUID: id,
      WFVariableName: name,
      WFInput: textToken(string),
    },
  };
}

/**
 * @param {{ token?: string, url?: string }} [opts]
 */
export function buildWorkflow(opts = {}) {
  const token = opts.token || TOKEN_PLACEHOLDER;
  const url = opts.url || URL_PLACEHOLDER;
  /** @type {object[]} */
  const actions = [];

  actions.push({
    WFWorkflowActionIdentifier: "is.workflow.actions.comment",
    WFWorkflowActionParameters: {
      UUID: stableUuid("comment"),
      WFCommentActionText: [
        "Yan Life State Dock. POSTs phone-dock intent to the Mac 5-minute log.",
        "Stub. Add Get Device Orientation and Bedroom Boolean yourself.",
        "Only POST when Bedroom Boolean is on.",
        "Portrait: Intent going_to_shower, Orientation portrait.",
        "Landscape: Intent going_to_sleep, Orientation landscape.",
        "Replace the two Set Variable actions, or wrap this POST in your Ifs.",
        "Hook from the existing plug-in automation, or paste these last actions into it.",
        "Silent on success. Notifies only if received is not yes.",
      ].join("\n"),
    },
  });

  actions.push(setVariableText(stableUuid("var-intent"), "Intent", "going_to_shower"));
  actions.push(setVariableText(stableUuid("var-orientation"), "Orientation", "portrait"));

  const jsonItems = [
    dictItem("intent", namedVariable("Intent")),
    dictItem("orientation", namedVariable("Orientation")),
  ];

  const downloadId = stableUuid("download");
  actions.push({
    WFWorkflowActionIdentifier: "is.workflow.actions.downloadurl",
    WFWorkflowActionParameters: {
      UUID: downloadId,
      CustomOutputName: "Dock POST",
      ShowHeaders: true,
      WFHTTPMethod: "POST",
      WFHTTPBodyType: "JSON",
      WFURL: url,
      WFHTTPHeaders: {
        Value: {
          WFDictionaryFieldValueItems: [
            dictItem("Authorization", `Bearer ${token}`),
            dictItem("Content-Type", "application/json"),
          ],
        },
        WFSerializationType: "WFDictionaryFieldValue",
      },
      WFJSONValues: {
        Value: { WFDictionaryFieldValueItems: jsonItems },
        WFSerializationType: "WFDictionaryFieldValue",
      },
      WFFormValues: {
        Value: { WFDictionaryFieldValueItems: [] },
        WFSerializationType: "WFDictionaryFieldValue",
      },
    },
  });

  const responseDictId = stableUuid("post-dict");
  actions.push({
    WFWorkflowActionIdentifier: "is.workflow.actions.detect.dictionary",
    WFWorkflowActionParameters: {
      UUID: responseDictId,
      CustomOutputName: "Dock Response",
      WFInput: actionOutput(downloadId, "Dock POST"),
    },
  });

  const receivedId = stableUuid("post-received");
  const receivedToken = actionOutput(receivedId, "Dock received");
  receivedToken.Value.Aggrandizements = [
    {
      Type: "WFCoercionVariableAggrandizement",
      CoercionItemClass: "WFStringContentItem",
    },
  ];
  actions.push({
    WFWorkflowActionIdentifier: "is.workflow.actions.getvalueforkey",
    WFWorkflowActionParameters: {
      UUID: receivedId,
      CustomOutputName: "Dock received",
      WFDictionaryKey: "received",
      WFGetDictionaryValueType: "Value",
      WFInput: actionOutput(responseDictId, "Dock Response"),
    },
  });

  const ifGroup = stableUuid("if-post-fail");
  actions.push({
    WFWorkflowActionIdentifier: "is.workflow.actions.conditional",
    WFWorkflowActionParameters: {
      UUID: stableUuid("if-post-fail-start"),
      GroupingIdentifier: ifGroup,
      WFControlFlowMode: 0,
      WFCondition: 4,
      WFConditionalActionString: "yes",
      WFInput: {
        Type: "Variable",
        Variable: receivedToken,
      },
    },
  });
  actions.push({
    WFWorkflowActionIdentifier: "is.workflow.actions.conditional",
    WFWorkflowActionParameters: {
      UUID: stableUuid("if-post-fail-otherwise"),
      GroupingIdentifier: ifGroup,
      WFControlFlowMode: 1,
    },
  });
  actions.push({
    WFWorkflowActionIdentifier: "is.workflow.actions.notification",
    WFWorkflowActionParameters: {
      UUID: stableUuid("notification-fail"),
      WFNotificationActionTitle: SHORTCUT_NAME,
      WFNotificationActionBody: "Dock intent did not reach the Mac.",
    },
  });
  actions.push({
    WFWorkflowActionIdentifier: "is.workflow.actions.conditional",
    WFWorkflowActionParameters: {
      UUID: stableUuid("if-post-fail-end"),
      GroupingIdentifier: ifGroup,
      WFControlFlowMode: 2,
    },
  });

  return {
    WFWorkflowActions: actions,
    WFWorkflowClientRelease: "26.0",
    WFWorkflowClientVersion: "3607.0.5",
    WFWorkflowHasOutputFallback: false,
    WFWorkflowHasShortcutInputVariables: false,
    WFWorkflowIcon: {
      WFWorkflowIconGlyphNumber: 59511,
      WFWorkflowIconStartColor: 4278080147,
    },
    WFWorkflowImportQuestions: [],
    WFWorkflowInputContentItemClasses: [],
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: "900",
    WFWorkflowOutputContentItemClasses: [],
    WFWorkflowTypes: [],
    WFQuickActionSurfaces: [],
  };
}

function envValue(text, key) {
  const match = String(text || "").match(new RegExp(`^\\s*${key}=(.*)$`, "m"));
  if (!match) return "";
  return String(match[1] || "").trim().replace(/^["']|["']$/g, "");
}

async function readDotEnv() {
  const envPath = join(ROOT, "server", ".env");
  try {
    return { path: envPath, text: await readFile(envPath, "utf8") };
  } catch {
    return { path: envPath, text: "" };
  }
}

export async function resolveIngestToken() {
  const env = await readDotEnv();
  const token =
    envValue(env.text, "LOCATION_INGEST_TOKEN") ||
    envValue(env.text, "HEALTH_INGEST_TOKEN");
  if (token) return token;
  throw new Error(
    "Set LOCATION_INGEST_TOKEN or HEALTH_INGEST_TOKEN in server/.env, then retry."
  );
}

export async function writePlaceholderPlist() {
  await mkdir(SOURCE_DIR, { recursive: true });
  const jsonPath = join(SOURCE_DIR, "workflow.json");
  const workflow = buildWorkflow({
    token: TOKEN_PLACEHOLDER,
    url: URL_PLACEHOLDER,
  });
  await writeFile(jsonPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
  await execFileAsync("plutil", ["-convert", "xml1", jsonPath, "-o", SOURCE_PLIST]);
  return SOURCE_PLIST;
}

/**
 * @param {{ token?: string, url?: string, icloud?: boolean }} [opts]
 */
export async function buildAndSignShortcut(opts = {}) {
  const token = opts.token || (await resolveIngestToken());
  const url = opts.url || DEFAULT_URL;
  await mkdir(SOURCE_DIR, { recursive: true });
  await writePlaceholderPlist();

  const filledJson = join(SOURCE_DIR, "workflow.filled.json");
  const filledPlist = join(SOURCE_DIR, "workflow.filled.plist");
  const filledBinary = join(SOURCE_DIR, "workflow.filled.shortcut");
  const signedPath = join(SOURCE_DIR, `${SHORTCUT_NAME}.shortcut`);
  const workflow = buildWorkflow({ token, url });
  await writeFile(filledJson, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
  await execFileAsync("plutil", ["-convert", "xml1", filledJson, "-o", filledPlist]);
  await execFileAsync("plutil", [
    "-convert",
    "binary1",
    filledPlist,
    "-o",
    filledBinary,
  ]);
  await execFileAsync("shortcuts", [
    "sign",
    "--mode",
    "people-who-know-me",
    "--input",
    filledBinary,
    "--output",
    signedPath,
  ]);

  let icloudPath = "";
  if (opts.icloud !== false) {
    await mkdir(ICLOUD_DIR, { recursive: true });
    icloudPath = join(ICLOUD_DIR, `${SHORTCUT_NAME}.shortcut`);
    await copyFile(signedPath, icloudPath);
    const setupSrc = join(SOURCE_DIR, "SETUP.md");
    try {
      await copyFile(setupSrc, join(ICLOUD_DIR, "SETUP.md"));
    } catch {
      /* SETUP.md written in the same run */
    }
  }

  return { signedPath, icloudPath, sourcePlist: SOURCE_PLIST };
}

const isMain = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return pathToFileURL(arg).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  buildAndSignShortcut()
    .then((result) => {
      console.log("[life-state-shortcut] signed", result.signedPath);
      if (result.icloudPath) console.log("[life-state-shortcut] iCloud", result.icloudPath);
    })
    .catch((err) => {
      console.error("[life-state-shortcut] failed", err);
      process.exitCode = 1;
    });
}
