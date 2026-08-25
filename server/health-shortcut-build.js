/**
 * Build and sign the iPhone "Yan Health Sync" Shortcut.
 * Substitutes HEALTH_INGEST_TOKEN, signs, copies to iCloud Drive.
 * `shortcuts sign --mode anyone` currently fails on this Mac ("file doesn't exist").
 * people-who-know-me still imports on Yan's iPhone.
 */

import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = join(ROOT, "ios", "shortcuts", "yan-health-sync");
const SOURCE_PLIST = join(SOURCE_DIR, "workflow.plist");
const TOKEN_PLACEHOLDER = "__HEALTH_INGEST_TOKEN__";
const URL_PLACEHOLDER = "__HEALTH_INGEST_URL__";
const DEFAULT_URL = "https://api.yanylevin.com/api/education/health";
const ICLOUD_DIR = join(
  homedir(),
  "Library/Mobile Documents/com~apple~CloudDocs/YanHealth"
);

function stableUuid(name) {
  const hex = createHash("sha256").update(`yan-health-sync:${name}`).digest("hex");
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

/** Property of an Action output. iOS 27 has no generic Get Details action. */
function propertyOutput(uuid, name, propertyName, propertyId) {
  const token = actionOutput(uuid, name);
  token.Value.Aggrandizements = [
    {
      Type: "WFPropertyVariableAggrandizement",
      PropertyName: propertyName,
      ...(propertyId ? { PropertyUserInfo: propertyId } : {}),
    },
  ];
  return token;
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

function healthFilter(typeLabel, days) {
  return {
    Value: {
      WFActionParameterFilterPrefix: 1,
      WFContentPredicateBoundedDate: false,
      WFActionParameterFilterTemplates: [
        {
          Bounded: true,
          Operator: 4,
          Property: "Type",
          Removable: false,
          Values: {
            Enumeration: {
              Value: typeLabel,
              WFSerializationType: "WFStringSubstitutableState",
            },
          },
        },
        {
          Bounded: true,
          Operator: 1001,
          Property: "Start Date",
          Removable: false,
          Values: {
            Number: String(days),
            // NSCalendarUnitDay. 16384 is yearForWeekOfYear, which leaves
            // the "days" picker blank on iOS 27.
            Unit: 16,
          },
        },
      ],
    },
    WFSerializationType: "WFContentPredicateTableTemplate",
  };
}

function findHealthAction(id, typeLabel, days, outputName, limit) {
  return {
    WFWorkflowActionIdentifier: "is.workflow.actions.filter.health.quantity",
    WFWorkflowActionParameters: {
      UUID: id,
      CustomOutputName: outputName,
      WFContentItemFilter: healthFilter(typeLabel, days),
      WFContentItemSortOrder: "Latest First",
      WFContentItemSortProperty: "Start Date",
      WFContentItemLimitEnabled: true,
      WFContentItemLimitNumber: limit,
    },
  };
}

function getDetailsAction(
  id,
  property,
  inputId,
  inputName,
  outputName,
  actionIdentifier = "is.workflow.actions.properties.health.quantity"
) {
  return {
    WFWorkflowActionIdentifier: actionIdentifier,
    WFWorkflowActionParameters: {
      UUID: id,
      CustomOutputName: outputName,
      WFContentItemPropertyName: property,
      WFInput: actionOutput(inputId, inputName),
    },
  };
}

/**
 * Actions by Sindre Sorhus, iOS-only. Stock Find Health Samples cannot
 * query workouts (Workout is not a Health sample type).
 *
 * Find Workout has no date window, only type / sort / limit. Sort latest
 * startDate and cap the list. Two days of gym is well under WORKOUT_FIND_LIMIT.
 */
function findWorkoutAction(id, outputName, limit) {
  return {
    WFWorkflowActionIdentifier: "com.sindresorhus.Actions.WorkoutAppEntity",
    WFWorkflowActionParameters: {
      UUID: id,
      CustomOutputName: outputName,
      AppIntentDescriptor: {
        TeamIdentifier: "YG56YK5RN5",
        BundleIdentifier: "com.sindresorhus.Actions",
        Name: "Actions",
        AppIntentIdentifier: "WorkoutAppEntity",
        ActionRequiresAppInstallation: true,
      },
      WFContentItemSortProperty: "startDate",
      WFContentItemSortOrder: "Latest First",
      WFContentItemLimitEnabled: true,
      WFContentItemLimitNumber: limit,
      WFContentItemFilter: {
        Value: {
          WFActionParameterFilterPrefix: 1,
          WFContentPredicateBoundedDate: false,
          WFActionParameterFilterTemplates: [],
        },
        WFSerializationType: "WFContentPredicateTableTemplate",
      },
    },
  };
}

function setVariableAction(id, name, inputId, inputName, token) {
  return {
    WFWorkflowActionIdentifier: "is.workflow.actions.setvariable",
    WFWorkflowActionParameters: {
      UUID: id,
      WFVariableName: name,
      WFInput: token || actionOutput(inputId, inputName),
    },
  };
}

/** Quantity / category samples: last N days, zip starts+values (+ optional extras). */
// Full Apple XML export ingested 2026-08-20. Ongoing window is 2 days.
// Actions Find Workout cannot filter by date, so the shortcut takes the
// latest WORKOUT_FIND_LIMIT instead of a calendar range.
export const WORKOUT_LOOKBACK_DAYS = 2;
export const WORKOUT_FIND_LIMIT = 20;
export const SAMPLE_LOOKBACK_DAYS = 2;
// Safety cap. Active Calories is written constantly; the 2-day filter is
// the real bound.
export const SAMPLE_FIND_LIMIT = 120;

/** Find Health Samples types the shortcut never queries. */
export const SHORTCUT_EXCLUDED_LABELS = [
  "UV Index",
  "State of Mind",
  "Cycling Speed",
  "Cycling Cadence",
  "Time in Daylight",
  "Physical Effort",
  "Workout Effort Score",
];

export const HEALTH_SAMPLE_SERIES = [
  { camel: "sleep", label: "Sleep", days: SAMPLE_LOOKBACK_DAYS, extras: ["End Date", "Name"] },
  { camel: "steps", label: "Steps", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "walkRunDistance", label: "Walking + Running Distance", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "cyclingDistance", label: "Cycling Distance", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "flights", label: "Flights Climbed", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "exerciseMinutes", label: "Exercise Time", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "standMinutes", label: "Stand Time", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "activeCalories", label: "Active Calories", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "restingCalories", label: "Resting Calories", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "restingHr", label: "Resting Heart Rate", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "walkingHr", label: "Walking Heart Rate Average", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "hrv", label: "Heart Rate Variability", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "respiratoryRate", label: "Respiratory Rate", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "vo2Max", label: "VO2 Max", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "wristTemp", label: "Sleep Wrist Temperature", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "mindful", label: "Mindful Session", days: SAMPLE_LOOKBACK_DAYS },
  // Labels from Yan Health Sync 2 after he retapped the picker.
  { camel: "cardioRecovery", label: "Heart Rate Recovery, 1 min", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "walkingSpeed", label: "Walking Speed", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "walkingStepLength", label: "Step Length", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "walkingDoubleSupport", label: "Double Support Time", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "walkingAsymmetry", label: "Walking Asymmetry", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "stairAscentSpeed", label: "Stair Speed: Up", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "stairDescentSpeed", label: "Stair Speed: Down", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "runningPower", label: "Running Power", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "runningSpeed", label: "Running Speed", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "runningStride", label: "Running Stride Length", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "runningGroundContact", label: "Running Ground Contact Time", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "runningVerticalOscillation", label: "Running Vertical Oscillation", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "environmentalAudio", label: "Environmental Audio Exposure", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "headphoneAudio", label: "Headphone Audio Exposure", days: SAMPLE_LOOKBACK_DAYS },
  { camel: "swimmingDistance", label: "Swimming Distance", days: SAMPLE_LOOKBACK_DAYS },
];

export const SHORTCUT_SERIES_CAMELS = HEALTH_SAMPLE_SERIES.map((s) => s.camel);

/** Archive-only series the shortcut cannot send. Summer takeaways must ignore these. */
export const ARCHIVE_ONLY_SERIES = [
  "uvIndex",
  "stateOfMind",
  "cyclingSpeed",
  "cyclingCadence",
  "timeInDaylight",
  "physicalEffort",
  "effortScore",
];

const WORKOUT_DETAILS = [
  { property: "Workout Type", identifier: "workoutType", camel: "workoutNames" },
  { property: "Start Date", identifier: "startDate", camel: "workoutStarts" },
  { property: "End Date", identifier: "endDate", camel: "workoutEnds" },
  { property: "Duration", identifier: "duration", camel: "workoutDurations" },
  {
    property: "Active Calories (kcal)",
    identifier: "activeCalories",
    camel: "workoutEnergies",
  },
  {
    property: "Average Heart Rate (bpm)",
    identifier: "averageHeartRate",
    camel: "workoutAvgHrs",
  },
  { property: "Source Name", identifier: "sourceName", camel: "workoutSources" },
  { property: "Total Distance", identifier: "totalDistance", camel: "workoutDistances" },
];

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
        "Yan Health Sync. Posts Apple Health to the Mac Personal Agent.",
        "Workouts: Actions Find Workout, latest 20 (about 2 days).",
        "Sleep, steps, vitals, walking, running, hearing, cardio recovery, swimming: last 2 days. Nothing at 14 days.",
        "Not queried: UV Index, State of Mind, cycling speed/cadence, Time in Daylight, Physical Effort, Workout Effort Score.",
        "Needs the Actions app. Run it yourself. Overlapping dumps are fine.",
        "Silent on success. Notifies only if received is not yes.",
        "Settings → Shortcuts → Advanced → Allow Sharing Large Amounts of Data.",
      ].join("\n"),
    },
  });

  const workoutFindId = stableUuid("find-workouts");
  const workoutFindName = "Workouts";
  actions.push(findWorkoutAction(workoutFindId, workoutFindName, WORKOUT_FIND_LIMIT));
  for (const detail of WORKOUT_DETAILS) {
    actions.push(
      setVariableAction(
        stableUuid(`workout-var-${detail.camel}`),
        detail.camel,
        workoutFindId,
        workoutFindName,
        propertyOutput(
          workoutFindId,
          workoutFindName,
          detail.property,
          detail.identifier
        )
      )
    );
  }

  const jsonKeys = ["workouts", ...WORKOUT_DETAILS.map((d) => d.camel)];
  const jsonItems = () =>
    jsonKeys.map((key) =>
      key === "workouts"
        ? dictItem("workouts", actionOutput(workoutFindId, workoutFindName))
        : dictItem(key, namedVariable(key))
    );

  for (const series of HEALTH_SAMPLE_SERIES) {
    const findId = stableUuid(`find-${series.camel}`);
    const findName = `${series.label} Samples`;
    actions.push(findHealthAction(findId, series.label, series.days, findName, SAMPLE_FIND_LIMIT));

    const startId = stableUuid(`detail-${series.camel}-start`);
    const startName = `${series.camel} start`;
    actions.push(
      getDetailsAction(startId, "Start Date", findId, findName, startName)
    );
    actions.push(
      setVariableAction(
        stableUuid(`var-${series.camel}-starts`),
        `${series.camel}Starts`,
        startId,
        startName
      )
    );
    jsonKeys.push(`${series.camel}Starts`);

    const valueId = stableUuid(`detail-${series.camel}-value`);
    const valueName = `${series.camel} value`;
    actions.push(
      getDetailsAction(valueId, "Value", findId, findName, valueName)
    );
    actions.push(
      setVariableAction(
        stableUuid(`var-${series.camel}-values`),
        `${series.camel}Values`,
        valueId,
        valueName
      )
    );
    jsonKeys.push(`${series.camel}Values`);

    for (const extra of series.extras || []) {
      const extraId = stableUuid(`detail-${series.camel}-${extra}`);
      const extraName = `${series.camel} ${extra}`;
      const varName =
        extra === "End Date"
          ? `${series.camel}Ends`
          : extra === "Name"
            ? `${series.camel}Names`
            : `${series.camel}${extra.replace(/\s+/g, "")}`;
      actions.push(
        getDetailsAction(extraId, extra, findId, findName, extraName)
      );
      actions.push(
        setVariableAction(
          stableUuid(`var-${series.camel}-${extra}`),
          varName,
          extraId,
          extraName
        )
      );
      jsonKeys.push(varName);
    }
  }

  const dictId = stableUuid("dictionary");
  actions.push({
    WFWorkflowActionIdentifier: "is.workflow.actions.dictionary",
    WFWorkflowActionParameters: {
      UUID: dictId,
      CustomOutputName: "Health JSON",
      WFItems: {
        Value: {
          WFDictionaryFieldValueItems: jsonItems(),
        },
        WFSerializationType: "WFDictionaryFieldValue",
      },
    },
  });

  const downloadId = stableUuid("download");
  actions.push({
    WFWorkflowActionIdentifier: "is.workflow.actions.downloadurl",
    WFWorkflowActionParameters: {
      UUID: downloadId,
      CustomOutputName: "Health POST",
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
        Value: {
          WFDictionaryFieldValueItems: jsonItems(),
        },
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
      CustomOutputName: "Health Response",
      WFInput: actionOutput(downloadId, "Health POST"),
    },
  });

  const receivedId = stableUuid("post-received");
  const receivedToken = actionOutput(receivedId, "Health received");
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
      CustomOutputName: "Health received",
      WFDictionaryKey: "received",
      WFGetDictionaryValueType: "Value",
      WFInput: actionOutput(responseDictId, "Health Response"),
    },
  });

  // Classic If (WFInput + WFCondition 4), not the WFConditions table.
  // That table broke the If on import. JSON true also made a false alarm
  // after a hand fix. The POST now returns received: "yes" as text.
  // If received is yes: do nothing. Otherwise: notify.
  // A dead network still stops Get Contents of URL with a system error.
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
      WFNotificationActionTitle: "Yan Health Sync",
      WFNotificationActionBody: "Health dump did not reach the Mac.",
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
      WFWorkflowIconGlyphNumber: 59457,
      WFWorkflowIconStartColor: 4282601983,
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

async function readDotEnv() {
  const envPath = join(ROOT, "server", ".env");
  try {
    return { path: envPath, text: await readFile(envPath, "utf8") };
  } catch {
    return { path: envPath, text: "" };
  }
}

export async function ensureHealthIngestToken() {
  const env = await readDotEnv();
  const match = env.text.match(/^\s*HEALTH_INGEST_TOKEN=(.*)$/m);
  const existing = match ? String(match[1] || "").trim().replace(/^["']|["']$/g, "") : "";
  if (existing) return existing;
  const token = randomBytes(32).toString("hex");
  const line = `\n# iPhone Shortcut POST /api/education/health\nHEALTH_INGEST_TOKEN=${token}\n`;
  await writeFile(env.path, `${env.text.trimEnd()}${line}`, "utf8");
  return token;
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
  const token = opts.token || (await ensureHealthIngestToken());
  const url = opts.url || DEFAULT_URL;
  await mkdir(SOURCE_DIR, { recursive: true });
  await writePlaceholderPlist();

  const filledJson = join(SOURCE_DIR, "workflow.filled.json");
  const filledPlist = join(SOURCE_DIR, "workflow.filled.plist");
  const filledBinary = join(SOURCE_DIR, "workflow.filled.shortcut");
  const signedPath = join(SOURCE_DIR, "Yan Health Sync.shortcut");
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
    icloudPath = join(ICLOUD_DIR, "Yan Health Sync.shortcut");
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
      console.log("[health-shortcut] signed", result.signedPath);
      if (result.icloudPath) console.log("[health-shortcut] iCloud", result.icloudPath);
    })
    .catch((err) => {
      console.error("[health-shortcut] failed", err);
      process.exitCode = 1;
    });
}
