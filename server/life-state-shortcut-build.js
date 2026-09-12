/**
 * Build and sign Yan's life-state Shortcuts. Token from LOCATION_INGEST_TOKEN
 * or HEALTH_INGEST_TOKEN. people-who-know-me still imports on the iPhone.
 * Automations (plug in, unplug, Driving Focus, Tesla Bluetooth) are added by Yan.
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
export const TOKEN_PLACEHOLDER = "__LOCATION_INGEST_TOKEN__";
export const URL_PLACEHOLDER = "__LIFE_STATE_INTENT_URL__";
export const DEFAULT_URL = "https://api.yanylevin.com/api/education/life-state-intent";
const ICLOUD_DIR = join(
  homedir(),
  "Library/Mobile Documents/com~apple~CloudDocs/YanLifeState"
);

export const SHORTCUT_SPECS = [
  {
    id: "yan-life-state-dock",
    name: "Yan Life State Dock",
    iconGlyph: 59511,
    iconColor: 4278080147,
    comment: [
      "Yan Life State Dock. Four finished POST blocks. No variables to fill.",
      "Two identical plugged_in copies first. Put each in its leftover If branch.",
      "Then shower: going_to_shower, portrait.",
      "Then sleep: going_to_sleep, landscape.",
      "Bedroom Boolean off can still post plugged_in. Do not run more than one POST.",
    ],
    posts: [
      {
        key: "plugged-a",
        label: "Plugged in",
        intent: "plugged_in",
        note: "Plugged in, not shower or sleep.",
      },
      {
        key: "plugged-b",
        label: "Plugged in",
        intent: "plugged_in",
        note: "Plugged in, not shower or sleep.",
      },
      {
        key: "shower",
        label: "Shower",
        intent: "going_to_shower",
        orientation: "portrait",
        note: "Portrait branch.",
      },
      {
        key: "sleep",
        label: "Sleep",
        intent: "going_to_sleep",
        orientation: "landscape",
        note: "Landscape branch.",
      },
    ],
  },
  {
    id: "yan-life-state-unplug",
    name: "Yan Life State Unplug",
    iconGlyph: 59512,
    iconColor: 4282601983,
    comment: [
      "Yan Life State Unplug. One POST when the iPhone leaves power.",
      "Hook a personal automation: Is Disconnected From Power. No Ifs.",
    ],
    posts: [{ key: "unplug", label: "Unplug", intent: "unplugged" }],
  },
  {
    id: "yan-life-state-driving-focus",
    name: "Yan Life State Driving Focus",
    iconGlyph: 59446,
    iconColor: 4292093695,
    comment: [
      "Yan Life State Driving Focus. One POST when Driving Focus turns on.",
      "iOS also turns this on in any car, including passenger. Tesla Bluetooth is the Tesla tell.",
      "Flipping to Personal Focus and back is the same trip on the Mac (15 min resume).",
    ],
    posts: [{ key: "driving", label: "Driving Focus", intent: "driving_focus" }],
  },
  {
    id: "yan-life-state-tesla",
    name: "Yan Life State Tesla",
    iconGlyph: 59816,
    iconColor: 4282137660,
    comment: [
      "Yan Life State Tesla. One POST when Tesla Bluetooth connects.",
      "This is the Tesla, not any car. Hook: When a Bluetooth device connects.",
      "Brief Bluetooth drops are the same trip on the Mac (10 min resume).",
    ],
    posts: [{ key: "tesla", label: "Tesla", intent: "tesla_bluetooth" }],
  },
];

export const SHORTCUT_NAME = SHORTCUT_SPECS[0].name;

function sourceDir(spec) {
  return join(ROOT, "ios", "shortcuts", spec.id);
}

function stableUuid(specId, name) {
  const hex = createHash("sha256").update(`yan-life-state:${specId}:${name}`).digest("hex");
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

function commentAction(id, lines) {
  return {
    WFWorkflowActionIdentifier: "is.workflow.actions.comment",
    WFWorkflowActionParameters: {
      UUID: id,
      WFCommentActionText: lines.join("\n"),
    },
  };
}

function downloadPost(id, outputName, url, token, intent, orientation) {
  const jsonItems = [dictItem("intent", intent)];
  if (orientation) jsonItems.push(dictItem("orientation", orientation));
  return {
    WFWorkflowActionIdentifier: "is.workflow.actions.downloadurl",
    WFWorkflowActionParameters: {
      UUID: id,
      CustomOutputName: outputName,
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
  };
}

function postSuccessCheck(specId, idPrefix, downloadId, downloadName, label) {
  const responseDictId = stableUuid(specId, `${idPrefix}-post-dict`);
  const receivedId = stableUuid(specId, `${idPrefix}-post-received`);
  const receivedToken = actionOutput(receivedId, `${label} received`);
  receivedToken.Value.Aggrandizements = [
    {
      Type: "WFCoercionVariableAggrandizement",
      CoercionItemClass: "WFStringContentItem",
    },
  ];
  const ifGroup = stableUuid(specId, `${idPrefix}-if-post-fail`);
  return [
    {
      WFWorkflowActionIdentifier: "is.workflow.actions.detect.dictionary",
      WFWorkflowActionParameters: {
        UUID: responseDictId,
        CustomOutputName: `${label} Response`,
        WFInput: actionOutput(downloadId, downloadName),
      },
    },
    {
      WFWorkflowActionIdentifier: "is.workflow.actions.getvalueforkey",
      WFWorkflowActionParameters: {
        UUID: receivedId,
        CustomOutputName: `${label} received`,
        WFDictionaryKey: "received",
        WFGetDictionaryValueType: "Value",
        WFInput: actionOutput(responseDictId, `${label} Response`),
      },
    },
    {
      WFWorkflowActionIdentifier: "is.workflow.actions.conditional",
      WFWorkflowActionParameters: {
        UUID: stableUuid(specId, `${idPrefix}-if-post-fail-start`),
        GroupingIdentifier: ifGroup,
        WFControlFlowMode: 0,
        WFCondition: 4,
        WFConditionalActionString: "yes",
        WFInput: {
          Type: "Variable",
          Variable: receivedToken,
        },
      },
    },
    {
      WFWorkflowActionIdentifier: "is.workflow.actions.conditional",
      WFWorkflowActionParameters: {
        UUID: stableUuid(specId, `${idPrefix}-if-post-fail-otherwise`),
        GroupingIdentifier: ifGroup,
        WFControlFlowMode: 1,
      },
    },
    {
      WFWorkflowActionIdentifier: "is.workflow.actions.notification",
      WFWorkflowActionParameters: {
        UUID: stableUuid(specId, `${idPrefix}-notification-fail`),
        WFNotificationActionTitle: label,
        WFNotificationActionBody: "Life-state signal did not reach the Mac.",
      },
    },
    {
      WFWorkflowActionIdentifier: "is.workflow.actions.conditional",
      WFWorkflowActionParameters: {
        UUID: stableUuid(specId, `${idPrefix}-if-post-fail-end`),
        GroupingIdentifier: ifGroup,
        WFControlFlowMode: 2,
      },
    },
  ];
}

/**
 * @param {{ token?: string, url?: string, spec?: object }} [opts]
 */
export function buildWorkflow(opts = {}) {
  const spec = opts.spec || SHORTCUT_SPECS[0];
  const token = opts.token || TOKEN_PLACEHOLDER;
  const url = opts.url || URL_PLACEHOLDER;
  /** @type {object[]} */
  const actions = [commentAction(stableUuid(spec.id, "comment"), spec.comment)];
  for (const post of spec.posts) {
    const downloadId = stableUuid(spec.id, `download-${post.key}`);
    const outputName = `${post.label} POST`;
    if (post.note) {
      actions.push(commentAction(stableUuid(spec.id, `comment-${post.key}`), [post.note]));
    }
    actions.push(
      downloadPost(downloadId, outputName, url, token, post.intent, post.orientation || "")
    );
    actions.push(
      ...postSuccessCheck(spec.id, post.key, downloadId, outputName, post.label)
    );
  }
  return {
    WFWorkflowActions: actions,
    WFWorkflowClientRelease: "26.0",
    WFWorkflowClientVersion: "3607.0.5",
    WFWorkflowHasOutputFallback: false,
    WFWorkflowHasShortcutInputVariables: false,
    WFWorkflowIcon: {
      WFWorkflowIconGlyphNumber: spec.iconGlyph,
      WFWorkflowIconStartColor: spec.iconColor,
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

export async function writePlaceholderPlist(spec = SHORTCUT_SPECS[0]) {
  const dir = sourceDir(spec);
  await mkdir(dir, { recursive: true });
  const jsonPath = join(dir, "workflow.json");
  const workflow = buildWorkflow({
    spec,
    token: TOKEN_PLACEHOLDER,
    url: URL_PLACEHOLDER,
  });
  await writeFile(jsonPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
  const plistPath = join(dir, "workflow.plist");
  await execFileAsync("plutil", ["-convert", "xml1", jsonPath, "-o", plistPath]);
  return plistPath;
}

/**
 * @param {{ spec?: object, token?: string, url?: string, icloud?: boolean }} [opts]
 */
export async function buildAndSignShortcut(opts = {}) {
  const spec = opts.spec || SHORTCUT_SPECS[0];
  const token = opts.token || (await resolveIngestToken());
  const url = opts.url || DEFAULT_URL;
  const dir = sourceDir(spec);
  await mkdir(dir, { recursive: true });
  await writePlaceholderPlist(spec);

  const filledJson = join(dir, "workflow.filled.json");
  const filledPlist = join(dir, "workflow.filled.plist");
  const filledBinary = join(dir, "workflow.filled.shortcut");
  const signedPath = join(dir, `${spec.name}.shortcut`);
  const workflow = buildWorkflow({ spec, token, url });
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
    icloudPath = join(ICLOUD_DIR, `${spec.name}.shortcut`);
    await copyFile(signedPath, icloudPath);
    const setupSrc = join(dir, "SETUP.md");
    try {
      await copyFile(setupSrc, join(ICLOUD_DIR, `${spec.name} SETUP.md`));
    } catch {
      /* SETUP.md written in the same run */
    }
  }

  return { signedPath, icloudPath, specId: spec.id };
}

export async function buildAndSignAll(opts = {}) {
  const token = opts.token || (await resolveIngestToken());
  const url = opts.url || DEFAULT_URL;
  const results = [];
  for (const spec of SHORTCUT_SPECS) {
    results.push(await buildAndSignShortcut({ ...opts, spec, token, url }));
  }
  const combinedSetup = join(ROOT, "ios", "shortcuts", "yan-life-state-dock", "SETUP.md");
  try {
    await mkdir(ICLOUD_DIR, { recursive: true });
    await copyFile(combinedSetup, join(ICLOUD_DIR, "SETUP.md"));
  } catch {
    /* optional */
  }
  return results;
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
  buildAndSignAll()
    .then((results) => {
      for (const result of results) {
        console.log("[life-state-shortcut] signed", result.signedPath);
        if (result.icloudPath) console.log("[life-state-shortcut] iCloud", result.icloudPath);
      }
    })
    .catch((err) => {
      console.error("[life-state-shortcut] failed", err);
      process.exitCode = 1;
    });
}
