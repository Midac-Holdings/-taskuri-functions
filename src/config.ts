function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が未設定です`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** 設定値。必須項目は使う時点で読むので、テストでは未設定でも動く。 */
export const config = {
  get siteId() { return required("TASKURI_SITE_ID"); },
  get taskListId() { return required("TASKURI_TASK_LIST_ID"); },
  get settingsListId() { return required("TASKURI_SETTINGS_LIST_ID"); },
  get aoaiEndpoint() { return required("AOAI_ENDPOINT"); },
  get aoaiDeployment() { return required("AOAI_DEPLOYMENT"); },
  get aoaiApiVersion() { return process.env.AOAI_API_VERSION || "2024-10-21"; },
  /** 未設定なら temperature を送らない(o系・GPT-5系は指定不可のため) */
  get aoaiTemperature(): number | undefined {
    const v = process.env.AOAI_TEMPERATURE;
    return v === undefined || v === "" ? undefined : Number(v);
  },
  get maxMailsPerRun() { return num("TASKURI_MAX_MAILS", 50); },
  get firstRunLookbackHours() { return num("TASKURI_FIRST_LOOKBACK_HOURS", 24); },
  get bodyMaxChars() { return num("TASKURI_BODY_MAX_CHARS", 4000); },
  get aiConcurrency() { return num("TASKURI_AI_CONCURRENCY", 3); },
  /** 各アイテムにサイト所有者グループのフルコントロールも付けるか(既定: true。管理者の保守用) */
  get grantOwners() { return (process.env.TASKURI_GRANT_OWNERS ?? "true").toLowerCase() !== "false"; },
  defaultRunTime: "07:30",
};
