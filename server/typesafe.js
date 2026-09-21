/**
 * TypeSafe Jev client. Classify, route, or score. Does not generate text.
 * Key lives in server/.env as TYPESAFE_API_KEY. Never send it to a browser.
 */

import { fileURLToPath } from "node:url";
import {
  TypeSafeClient,
  choice,
  noul,
  score,
} from "@typesafe-ai/sdk";

const DEFAULT_MODEL = "jev-latest";

export { TypeSafeClient, choice, noul, score };

export function typesafeConfig() {
  const apiKey = String(process.env.TYPESAFE_API_KEY || "").trim();
  const baseURL = String(process.env.TYPESAFE_BASE_URL || "").trim();
  const defaultModel =
    String(process.env.TYPESAFE_DEFAULT_MODEL || "").trim() || DEFAULT_MODEL;
  return {
    apiKey,
    baseURL: baseURL || "",
    defaultModel,
    configured: Boolean(apiKey),
  };
}

export function getTypesafeClient() {
  const { apiKey, baseURL, defaultModel, configured } = typesafeConfig();
  if (!configured) {
    throw new Error("TYPESAFE_API_KEY is missing in server/.env");
  }
  /** @type {import("@typesafe-ai/sdk").TypeSafeClientConfig} */
  const config = { apiKey, defaultModel };
  if (baseURL) config.baseURL = baseURL;
  return new TypeSafeClient(config);
}

/**
 * @param {import("@typesafe-ai/sdk").SystemOneRequest} request
 * @param {import("@typesafe-ai/sdk").RequestOptions} [options]
 */
export function systemOne(request, options) {
  return getTypesafeClient().systemOne(request, options);
}

export async function pingTypesafe() {
  const result = await systemOne({
    state: { purpose: "repo smoke test", text: "The smoke test ran." },
    questions: {
      is_smoke_test: noul("Is this a software smoke test?", {
        true: "A check that the API client works",
        false: "A real user message or production payload",
      }),
    },
  });
  return {
    ok: true,
    model: result.model,
    noul: result.answers.is_smoke_test.noul,
    usage: result.usage,
  };
}

const isCli =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const cmd = process.argv[2] || "ping";
  if (cmd !== "ping") {
    console.error("usage: node --env-file=.env typesafe.js ping");
    process.exit(2);
  }
  pingTypesafe()
    .then((out) => {
      console.log(JSON.stringify(out));
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
