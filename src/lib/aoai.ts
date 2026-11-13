import { AzureOpenAI } from "openai";
import { getBearerTokenProvider } from "@azure/identity";
import { config } from "../config";
import { credential } from "./identity";
import {
  JUDGEMENT_SCHEMA,
  MailJudgement,
  PromptInput,
  SYSTEM_PROMPT,
  buildUserMessage,
  sanitizeJudgement,
} from "./prompt";

let client: AzureOpenAI | undefined;

/** 自社デプロイのAOAIにマネージドIDで接続する(キーは使わない) */
function getClient(): AzureOpenAI {
  if (!client) {
    client = new AzureOpenAI({
      endpoint: config.aoaiEndpoint,
      deployment: config.aoaiDeployment,
      apiVersion: config.aoaiApiVersion,
      azureADTokenProvider: getBearerTokenProvider(credential, "https://cognitiveservices.azure.com/.default"),
    });
  }
  return client;
}

export async function judgeMail(input: PromptInput): Promise<MailJudgement> {
  const temperature = config.aoaiTemperature;
  const res = await getClient().chat.completions.create({
    model: config.aoaiDeployment,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(input, config.bodyMaxChars) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "taskuri_judgement",
        strict: true,
        schema: JUDGEMENT_SCHEMA as unknown as Record<string, unknown>,
      },
    },
    ...(temperature !== undefined ? { temperature } : {}),
  });

  const choice = res.choices[0];
  if (choice?.finish_reason === "content_filter") {
    return { interpretation: "判断できない", actionRequired: false, reason: "コンテンツフィルターにより判定不可", tasks: [] };
  }
  const text = choice?.message?.content;
  if (!text) throw new Error("AOAIの応答が空です");
  return sanitizeJudgement(JSON.parse(text));
}
