/**
 * SharePointリストの列定義(内部名)と変換。
 * 市民開発者に渡す仕様と一致させること(README の「リスト定義」)。
 */
import { ExtractedTask, MailJudgement } from "./prompt";
import { ROLE_LABEL, RecipientRole } from "./recipient";
import { toSharePointDate } from "./time";

// ---------------------------------------------------------------- 設定リスト(TaskuriSettings)

export interface SettingsFields {
  Title?: string;          // 対象ユーザーのメールアドレス
  DisplayName?: string;    // 表示名
  Enabled?: boolean;       // 有効
  RunTime?: string;        // 実行時刻 "07:30"(市民開発のGUIから変更可)
  WeekdaysOnly?: boolean;  // 平日のみ
  NameAliases?: string;    // 呼ばれ方(カンマ・改行区切り)
  MailAliases?: string;    // 本人の別アドレス(カンマ・改行区切り)
  ExcludeSenders?: string; // 除外する送信者(1行1件、部分一致)
  LastRunAt?: string;      // 前回実行日時(基盤が更新)
}

export interface UserSetting {
  itemId: string;
  email: string;
  displayName: string;
  enabled: boolean;
  runTime: string | null;
  weekdaysOnly: boolean;
  nameAliases: string[];
  mailAliases: string[];
  excludeSenders: string[];
  lastRunAt: string | null;
}

const splitList = (s: string | undefined) =>
  (s ?? "").split(/[,、\n\r]+/).map((x) => x.trim()).filter(Boolean);

export function toUserSetting(itemId: string, f: SettingsFields): UserSetting | null {
  const email = (f.Title ?? "").trim();
  if (!email.includes("@")) return null;
  return {
    itemId,
    email,
    displayName: (f.DisplayName ?? "").trim() || email.split("@")[0],
    enabled: f.Enabled !== false, // 未設定は有効扱い
    runTime: f.RunTime ?? null,
    weekdaysOnly: f.WeekdaysOnly !== false, // 未設定は平日のみ
    nameAliases: splitList(f.NameAliases),
    mailAliases: splitList(f.MailAliases),
    excludeSenders: (f.ExcludeSenders ?? "").split(/[\n\r]+/).map((x) => x.trim()).filter(Boolean),
    lastRunAt: f.LastRunAt ?? null,
  };
}

// ---------------------------------------------------------------- タスクリスト(TaskuriTasks)

export const STATUS_OPEN = "未着手";

export interface MailMeta {
  sourceMessageId: string;
  subject: string;
  from: string;
  receivedAt: string;
  webLink: string;
  role: RecipientRole;
}

export function toTaskFields(
  userEmail: string,
  task: ExtractedTask,
  judgement: MailJudgement,
  mail: MailMeta,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    Title: task.title,
    Detail: task.detail,
    ActionType: task.actionType,
    Priority: task.priority,
    Status: STATUS_OPEN,
    AssigneeEmail: userEmail,
    RecipientRole: ROLE_LABEL[mail.role],
    Interpretation: judgement.interpretation,
    Reason: judgement.reason,
    SourceMessageId: mail.sourceMessageId,
    MailSubject: mail.subject.slice(0, 255),
    MailFrom: mail.from.slice(0, 255),
    MailReceivedAt: mail.receivedAt,
    MailWebLink: mail.webLink,
  };
  // 日付列に null を送ると Graph がエラーにすることがあるので、値があるときだけ送る
  if (task.dueDate) fields.DueDate = toSharePointDate(task.dueDate);
  return fields;
}
