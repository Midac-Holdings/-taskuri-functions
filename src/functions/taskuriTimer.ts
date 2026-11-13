import { app, InvocationContext, Timer } from "@azure/functions";
import { run } from "../lib/runner";

/**
 * 15分おき(UTC)に起動し、設定リストの実行時刻(JST)を過ぎたユーザーだけ処理する。
 * これで市民開発のGUIから各自が実行時刻を変えられる。
 */
app.timer("taskuriTimer", {
  schedule: "%TASKURI_SCHEDULE%",
  handler: async (_timer: Timer, context: InvocationContext): Promise<void> => {
    const results = await run(new Date(), context);
    if (results.length) context.log(`タスクリ: ${results.length}名を処理しました`);
  },
});
