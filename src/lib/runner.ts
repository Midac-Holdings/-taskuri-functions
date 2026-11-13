import { config } from "../config";
import { getListItems } from "./graph";
import { SettingsFields, UserSetting, toUserSetting } from "./lists";
import { Logger, UserRunResult, processUser } from "./processUser";
import { hasUniquePermissions, restrictItemToUser } from "./sharepointRest";
import { isDue } from "./time";

export async function loadSettings(): Promise<UserSetting[]> {
  const items = await getListItems<SettingsFields>(config.settingsListId);
  return items.map((i) => toUserSetting(i.id, i.fields)).filter((x): x is UserSetting => x !== null);
}

/**
 * 設定リストの各行も本人だけが見られる・編集できるようにする。
 * 管理者が行を追加すると、次のタイマー実行(15分以内)で制限される。
 * 制限できなかったユーザーは、安全のためこの回の処理対象から外す。
 */
async function secureSettings(settings: UserSetting[], logger: Logger): Promise<UserSetting[]> {
  const ok: UserSetting[] = [];
  for (const s of settings) {
    try {
      if (!(await hasUniquePermissions(config.settingsListId, s.itemId))) {
        await restrictItemToUser(config.settingsListId, s.itemId, s.email);
        logger.log(`[${s.email}] 設定行を本人だけの権限にしました`);
      }
      ok.push(s);
    } catch (e) {
      logger.error(`[${s.email}] 設定行の権限設定に失敗したため、処理をスキップします`, e);
    }
  }
  return ok;
}

/**
 * @param onlyUser 指定時はそのユーザーだけ
 * @param force true なら実行時刻・実行済みの判定を無視する(手動実行用)
 */
export async function run(now: Date, logger: Logger, opts: { onlyUser?: string; force?: boolean } = {}): Promise<UserRunResult[]> {
  const all = await loadSettings();
  const scoped = opts.onlyUser ? all.filter((s) => s.email.toLowerCase() === opts.onlyUser!.toLowerCase()) : all;
  const settings = await secureSettings(scoped, logger);
  const targets = settings.filter((s) => (opts.force ? true : isDue(s, now)));

  const results: UserRunResult[] = [];
  // ユーザー単位は順番に処理(Graphのスロットリング対策)。1人の失敗で全体を止めない。
  for (const s of targets) {
    try {
      const r = await processUser(s, now, logger);
      logger.log(`[${s.email}] メール${r.mails}件 / 判定${r.judged}件 / タスク${r.tasksCreated}件作成`);
      results.push(r);
    } catch (e) {
      logger.error(`[${s.email}] 処理に失敗`, e);
    }
  }
  return results;
}
