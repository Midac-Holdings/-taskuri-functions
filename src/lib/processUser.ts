import { config } from "../config";
import { judgeMail } from "./aoai";
import { restrictItemToUser } from "./sharepointRest";
import {
  MailMessage,
  createListItem,
  deleteListItem,
  getListItems,
  listInboxMessagesSince,
  listSentSince,
  odataString,
  updateListItemFields,
} from "./graph";
import { MailMeta, UserSetting, toTaskFields } from "./lists";
import { determineRole, isExcludedSender } from "./recipient";
import { buildReplyIndex, findReplyAfter } from "./replies";
import { toJst } from "./time";

export interface Logger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface UserRunResult {
  user: string;
  mails: number;
  judged: number;
  tasksCreated: number;
  skippedExcluded: number;
  skippedDuplicate: number;
  failed: number;
}

/** 並列数を絞って順に処理する */
async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

async function alreadyProcessed(sourceMessageId: string, userEmail: string): Promise<boolean> {
  const items = await getListItems(
    config.taskListId,
    `fields/SourceMessageId eq ${odataString(sourceMessageId)} and fields/AssigneeEmail eq ${odataString(userEmail)}`,
  );
  return items.length > 0;
}

/**
 * タスクを作成して、すぐに本人だけが見られる権限にする。
 * 権限設定に失敗したら、他の人に見える状態で残さないようアイテムを削除する。
 */
async function createSecuredTask(userEmail: string, fields: Record<string, unknown>, logger: Logger): Promise<void> {
  const itemId = await createListItem(config.taskListId, fields);
  try {
    await restrictItemToUser(config.taskListId, itemId, userEmail);
  } catch (e) {
    try {
      await deleteListItem(config.taskListId, itemId);
    } catch (e2) {
      logger.error(`[重要] 権限設定に失敗したタスク(ID ${itemId})を削除できませんでした。手動で削除してください`, e2);
    }
    throw e;
  }
}

const addr = (m: MailMessage) =>
  m.from?.emailAddress?.name
    ? `${m.from.emailAddress.name} <${m.from.emailAddress.address ?? ""}>`
    : m.from?.emailAddress?.address ?? "(不明)";

export async function processUser(s: UserSetting, now: Date, logger: Logger): Promise<UserRunResult> {
  const result: UserRunResult = {
    user: s.email, mails: 0, judged: 0, tasksCreated: 0, skippedExcluded: 0, skippedDuplicate: 0, failed: 0,
  };
  const since = s.lastRunAt ?? new Date(now.getTime() - config.firstRunLookbackHours * 3600_000).toISOString();
  const mails = await listInboxMessagesSince(s.email, since, config.maxMailsPerRun);
  result.mails = mails.length;
  const replyIndex = buildReplyIndex(await listSentSince(s.email, since, 1000));
  const today = toJst(now).date;
  const myAddresses = [s.email, ...s.mailAliases];

  const targets = mails.filter((m) => {
    const fromMe = myAddresses.some((a) => a.toLowerCase() === (m.from?.emailAddress?.address ?? "").toLowerCase());
    const excluded = fromMe || isExcludedSender(m.from, s.excludeSenders);
    if (excluded) result.skippedExcluded++;
    return !excluded;
  });

  await mapLimit(targets, config.aiConcurrency, async (m) => {
    const sourceMessageId = m.internetMessageId ?? m.id;
    try {
      if (await alreadyProcessed(sourceMessageId, s.email)) {
        result.skippedDuplicate++;
        return;
      }
      const recipient = determineRole(myAddresses, m.toRecipients, m.ccRecipients);
      const judgement = await judgeMail({
        userName: s.displayName,
        nameAliases: s.nameAliases,
        todayJst: today,
        recipient,
        from: addr(m),
        subject: m.subject ?? "(件名なし)",
        receivedAt: m.receivedDateTime,
        importance: m.importance,
        body: m.uniqueBody?.content ?? m.bodyPreview ?? "",
        reply: findReplyAfter(replyIndex, m.conversationId, m.receivedDateTime),
      });
      result.judged++;
      if (!judgement.actionRequired) return;

      const meta: MailMeta = {
        sourceMessageId,
        subject: m.subject ?? "",
        from: addr(m),
        receivedAt: m.receivedDateTime,
        webLink: m.webLink ?? "",
        role: recipient.role,
      };
      for (const t of judgement.tasks) {
        await createSecuredTask(s.email, toTaskFields(s.email, t, judgement, meta), logger);
        result.tasksCreated++;
      }
    } catch (e) {
      result.failed++;
      logger.error(`[${s.email}] メール処理に失敗: ${m.subject}`, e);
    }
  });

  // 取得上限で打ち切った場合は、最後に読んだメールの時刻から次回再開する
  const truncated = mails.length >= config.maxMailsPerRun;
  const nextSince = truncated ? mails[mails.length - 1].receivedDateTime : now.toISOString();
  // 失敗があった場合は LastRunAt を進めず、次回に再試行(処理済みは重複チェックで除外される)
  if (result.failed === 0) {
    await updateListItemFields(config.settingsListId, s.itemId, { LastRunAt: nextSince });
  } else {
    logger.warn(`[${s.email}] ${result.failed}件失敗したため LastRunAt を更新しません`);
  }
  return result;
}
