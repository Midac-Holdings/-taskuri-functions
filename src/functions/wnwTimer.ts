import { app, InvocationContext, Timer } from "@azure/functions";
import { graphFetch } from "../lib/graph";
import { fetchNews } from "../lib/wnw/news";
import { runWnw } from "../lib/wnw/run";
import { ensureTable, getState, listSubscribers, saveState, TableTarget } from "../lib/wnw/table";

/**
 * What'sNew ウォッチャー:30分おきに会社HPの新着を確認し、新しい記事があれば登録者にメールする。
 * 登録者は市民開発基盤の画面(/cp/wnw/)で各自が登録する(Table Storage の WnwWatcher)。
 *
 * 設定(アプリ設定)
 *   WNW_TABLE_ENDPOINT  https://<ストレージアカウント名>.table.core.windows.net(未設定なら何もしない)
 *   WNW_TABLE_NAME      (任意)既定 WnwWatcher
 *   WNW_SENDER          送信元のメールボックス(例: noreply@midac.jp)。Exchange でこのメールボックスだけに Mail.Send を許可する
 *   WNW_APP_URL         (任意)メールの末尾に載せる、ウォッチャーの画面の URL
 *
 * スケジュールは固定(毎時 5分・35分、UTC)。アプリ設定に依存させないのは、未設定でタスクリ側の起動まで
 * 失敗させないため。
 */
app.timer("wnwTimer", {
  schedule: "0 5,35 * * * *",
  handler: async (_timer: Timer, context: InvocationContext): Promise<void> => {
    const endpoint = (process.env.WNW_TABLE_ENDPOINT ?? "").trim().replace(/\/+$/, "");
    const sender = (process.env.WNW_SENDER ?? "").trim();
    if (!endpoint || !sender) {
      context.log("What'sNew: WNW_TABLE_ENDPOINT または WNW_SENDER が未設定のため、何もしません");
      return;
    }
    const target: TableTarget = { endpoint, table: (process.env.WNW_TABLE_NAME ?? "").trim() || "WnwWatcher" };
    await ensureTable(target);

    await runWnw({
      fetchNews: () => fetchNews(),
      getState: () => getState(target),
      saveState: (ids) => saveState(target, ids),
      listSubscribers: () => listSubscribers(target),
      sendMail: (to, subject, html) =>
        graphFetch<void>(`/users/${encodeURIComponent(sender)}/sendMail`, {
          method: "POST",
          body: {
            message: {
              subject,
              body: { contentType: "HTML", content: html },
              toRecipients: [{ emailAddress: { address: to } }],
            },
            saveToSentItems: false,
          },
        }),
      appUrl: (process.env.WNW_APP_URL ?? "").trim() || undefined,
      log: (m) => (m.startsWith("[") ? context.warn(m) : context.log(m)),
    });
  },
});
