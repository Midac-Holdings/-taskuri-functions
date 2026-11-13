import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReplyIndex, findReplyAfter } from "../src/lib/replies";
import { isToday, renderReport, taskRows, TrialMail } from "../src/trial/report";
import { parseArgs } from "../src/trial/run";
import { buildUserMessage } from "../src/lib/prompt";
import { determineRole } from "../src/lib/recipient";

test("返信済みの判定: 受信より後の、同じ会話の最新の送信", () => {
  const idx = buildReplyIndex([
    { conversationId: "c1", sentDateTime: "2026-11-10T01:00:00Z", bodyPreview: "前の返信" },
    { conversationId: "c1", sentDateTime: "2026-11-12T03:00:00Z", bodyPreview: "承知しました。明日送ります" },
    { conversationId: "c2", sentDateTime: "2026-11-12T03:00:00Z", bodyPreview: "別件" },
    { sentDateTime: "2026-11-12T03:00:00Z" },
  ]);
  const r = findReplyAfter(idx, "c1", "2026-11-11T00:00:00Z");
  assert.equal(r?.preview, "承知しました。明日送ります");
  assert.equal(findReplyAfter(idx, "c1", "2026-11-13T00:00:00Z"), null);
  assert.equal(findReplyAfter(idx, "c3", "2026-11-01T00:00:00Z"), null);
  assert.equal(findReplyAfter(idx, undefined, "2026-11-01T00:00:00Z"), null);
});

test("プロンプト: 返信の有無が渡る", () => {
  const base = {
    userName: "山田", nameAliases: [], todayJst: "2026-11-13",
    recipient: determineRole(["t@example.com"], [{ emailAddress: { address: "t@example.com" } }], []),
    from: "x", subject: "s", receivedAt: "2026-11-12T00:00:00Z", body: "本文",
  };
  assert.match(buildUserMessage(base, 100), /本人の返信: なし/);
  assert.match(
    buildUserMessage({ ...base, reply: { sentAt: "2026-11-12T03:00:00Z", preview: "承知\nしました" } }, 100),
    /受信後に返信済み.*冒頭「承知 しました」/,
  );
});

test("検証モードの引数", () => {
  const a = parseArgs(["--days", "30", "--aliases", "山田さん、山田部長", "--exclude", "noreply@"]);
  assert.equal(a.days, 30);
  assert.equal(a.max, 1000);
  assert.deepEqual(a.aliases, ["山田さん", "山田部長"]);
  assert.deepEqual(a.exclude, ["noreply@"]);
  assert.throws(() => parseArgs(["--days", "365"]));
});

const mail = (over: Partial<TrialMail>): TrialMail => ({
  subject: "件名", from: "佐藤 <s@example.com>", receivedAt: "2026-11-12T00:00:00Z", role: "to_single", reply: null,
  judgement: { interpretation: "自分への個別依頼", actionRequired: true, reason: "理由", tasks: [] }, ...over,
});

test("レポート: 今日やるの振り分け・並び順・エスケープ", () => {
  const mails = [
    mail({ subject: "<script>x</script>", judgement: { interpretation: "自分への個別依頼", actionRequired: true, reason: "r",
      tasks: [{ title: "先の作業", detail: "", actionType: "対応", dueDate: "2026-11-20", priority: "中" },
              { title: "期限切れ", detail: "", actionType: "返信", dueDate: "2026-11-10", priority: "高" }] } }),
    mail({ judgement: { interpretation: "参考共有", actionRequired: false, reason: "CC", tasks: [] } }),
    mail({ judgement: { interpretation: "自分への個別依頼", actionRequired: true, reason: "r",
      tasks: [{ title: "期限なし低", detail: "", actionType: "確認", dueDate: null, priority: "低" }] } }),
  ];
  const rows = taskRows(mails);
  assert.deepEqual(rows.map((r) => r.title), ["期限切れ", "先の作業", "期限なし低"]);
  assert.equal(isToday(rows[0], "2026-11-13"), true);
  assert.equal(isToday(rows[1], "2026-11-13"), false);
  assert.equal(isToday(rows[2], "2026-11-13"), false);
  const html = renderReport({
    user: "山田", generatedAt: "2026-11-13T00:00:00Z", todayJst: "2026-11-13", days: 30,
    sinceIso: "2026-10-14T00:00:00Z", inboxCount: 3, excludedCount: 0, truncated: false, mails,
  });
  assert.ok(!html.includes("<script>x"));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /今日やる.*— 1件/);
  assert.match(html, /参考共有\(1通\)/);
  assert.ok(!/https?:\/\//.test(html), "外部読み込みなし");
});
