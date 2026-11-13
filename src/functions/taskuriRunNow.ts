import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { run } from "../lib/runner";

/**
 * 手動実行(テスト・「今すぐ更新」ボタン用)。関数キーが必要。
 * POST /api/taskuri/run?user=someone@example.com
 * 実行時刻の判定は無視し、前回実行以降のメールを処理する。
 */
app.http("taskuriRunNow", {
  methods: ["POST"],
  authLevel: "function",
  route: "taskuri/run",
  handler: async (req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    const user = req.query.get("user") ?? undefined;
    if (!user) return { status: 400, jsonBody: { error: "user パラメータを指定してください" } };
    const results = await run(new Date(), context, { onlyUser: user, force: true });
    if (!results.length) return { status: 404, jsonBody: { error: "設定リストに該当ユーザーがいないか、処理に失敗しました" } };
    return { status: 200, jsonBody: results[0] };
  },
});
