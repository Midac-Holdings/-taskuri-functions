import { test } from "node:test";
import assert from "node:assert/strict";
import { isDue, parseRunTime, toJst, toSharePointDate } from "../src/lib/time";
import { determineRole, isExcludedSender } from "../src/lib/recipient";
import { JUDGEMENT_SCHEMA, buildUserMessage, sanitizeJudgement } from "../src/lib/prompt";
import { toUserSetting } from "../src/lib/lists";

const a = (address: string, name = "") => ({ emailAddress: { address, name } });

test("JST変換: UTC 22:30 は翌日 7:30", () => {
  const n = toJst(new Date("2026-11-12T22:30:00Z"));
  assert.equal(n.date, "2026-11-13");
  assert.equal(n.minutes, 7 * 60 + 30);
  assert.equal(n.weekday, 5); // 金曜
});

test("実行時刻の解釈", () => {
  assert.equal(parseRunTime("7:30"), 450);
  assert.equal(parseRunTime("08:05"), 485);
  assert.equal(parseRunTime("25:00"), 450); // 不正→既定 07:30
  assert.equal(parseRunTime(null), 450);
});

test("isDue: 時刻前は実行しない／時刻後に1日1回だけ", () => {
  const base = { enabled: true, runTime: "07:30", weekdaysOnly: true };
  assert.equal(isDue(base, new Date("2026-11-12T22:15:00Z")), false); // 7:15 JST
  assert.equal(isDue(base, new Date("2026-11-12T22:30:00Z")), true);  // 7:30 JST
  assert.equal(isDue({ ...base, lastRunAt: "2026-11-12T22:30:00Z" }, new Date("2026-11-12T22:45:00Z")), false);
  assert.equal(isDue({ ...base, lastRunAt: "2026-11-11T22:30:00Z" }, new Date("2026-11-12T22:45:00Z")), true);
  // 当日の実行時刻より前の手動実行は、定時実行を妨げない
  assert.equal(isDue({ ...base, lastRunAt: "2026-11-12T21:00:00Z" }, new Date("2026-11-12T22:45:00Z")), true);
});

test("isDue: 土日・無効は実行しない", () => {
  const sat = new Date("2026-11-13T23:00:00Z"); // 11/14(土) 8:00 JST
  assert.equal(isDue({ enabled: true, runTime: "07:30", weekdaysOnly: true }, sat), false);
  assert.equal(isDue({ enabled: true, runTime: "07:30", weekdaysOnly: false }, sat), true);
  assert.equal(isDue({ enabled: false, runTime: "07:30", weekdaysOnly: false }, sat), false);
});

test("宛先の立場判定", () => {
  const me = ["Taro@Example.com"];
  assert.equal(determineRole(me, [a("taro@example.com")], []).role, "to_single");
  assert.equal(determineRole(me, [a("taro@example.com"), a("hanako@example.com")], []).role, "to_multi");
  assert.equal(determineRole(me, [a("hanako@example.com")], [a("taro@example.com")]).role, "cc");
  assert.equal(determineRole(me, [a("all@example.com")], []).role, "other");
  // ToとCCの両方にいる場合はToを優先
  assert.equal(determineRole(me, [a("taro@example.com")], [a("taro@example.com")]).role, "to_single");
  // エイリアス
  assert.equal(determineRole([...me, "t.yamada@example.com"], [a("t.yamada@example.com")], []).role, "to_single");
});

test("除外送信者", () => {
  assert.equal(isExcludedSender(a("noreply@service.jp", "通知"), ["noreply@"]), true);
  assert.equal(isExcludedSender(a("boss@example.com", "部長"), ["noreply@", "メルマガ"]), false);
});

test("スキーマ: strict のため全プロパティが required", () => {
  const check = (s: any) => {
    if (s.type === "object") {
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
      assert.equal(s.additionalProperties, false);
      Object.values(s.properties).forEach(check);
    }
    if (s.type === "array") check(s.items);
  };
  check(JUDGEMENT_SCHEMA);
});

test("sanitize: 不正値を丸め、アクションなしならタスクを空にする", () => {
  const j = sanitizeJudgement({
    interpretation: "謎",
    actionRequired: true,
    reason: "x",
    tasks: [{ title: " 見積を送る ", detail: "", actionType: "電話", dueDate: "11/20", priority: "最優先" }],
  });
  assert.equal(j.interpretation, "判断できない");
  assert.equal(j.tasks[0].title, "見積を送る");
  assert.equal(j.tasks[0].actionType, "その他");
  assert.equal(j.tasks[0].dueDate, null);
  assert.equal(j.tasks[0].priority, "中");

  const none = sanitizeJudgement({ interpretation: "参考共有", actionRequired: false, reason: "", tasks: [{ title: "x" }] });
  assert.equal(none.actionRequired, false);
  assert.equal(none.tasks.length, 0);

  const empty = sanitizeJudgement({ interpretation: "自分への個別依頼", actionRequired: true, reason: "", tasks: [] });
  assert.equal(empty.actionRequired, false);
});

test("プロンプト: 立場と本文が入り、長い本文は切り詰める", () => {
  const msg = buildUserMessage(
    {
      userName: "山田太郎",
      nameAliases: ["山田さん"],
      todayJst: "2026-11-13",
      recipient: determineRole(["taro@example.com"], [a("hanako@example.com", "佐藤花子")], [a("taro@example.com", "山田太郎")]),
      from: "佐藤花子 <hanako@example.com>",
      subject: "見積の件",
      receivedAt: "2026-11-13T00:10:00Z",
      body: "あ".repeat(50),
    },
    10,
  );
  assert.match(msg, /立場: CC/);
  assert.match(msg, /To\(1名\): 佐藤花子/);
  assert.match(msg, /以下省略/);
});

test("設定リストの読み込み: 既定値", () => {
  const s = toUserSetting("1", { Title: "taro@example.com", NameAliases: "山田さん、やまだ", ExcludeSenders: "noreply@\nメルマガ" })!;
  assert.equal(s.enabled, true);
  assert.equal(s.weekdaysOnly, true);
  assert.deepEqual(s.nameAliases, ["山田さん", "やまだ"]);
  assert.deepEqual(s.excludeSenders, ["noreply@", "メルマガ"]);
  assert.equal(toUserSetting("2", { Title: "不正" }), null);
});

test("SharePoint REST: 権限設定のURLとクレーム", async () => {
  const { claimsFor, breakInheritancePath, addRolePath } = await import("../src/lib/sharepointRest");
  assert.equal(claimsFor(" Taro@Example.com "), "i:0#.f|membership|taro@example.com");
  assert.equal(
    breakInheritancePath("{ABC-123}", "42"),
    "/_api/web/lists(guid'ABC-123')/items(42)/breakroleinheritance(copyRoleAssignments=false,clearSubscopes=true)",
  );
  assert.equal(
    addRolePath("abc-123", "42", 7, 1073741827),
    "/_api/web/lists(guid'abc-123')/items(42)/roleassignments/addroleassignment(principalid=7,roledefid=1073741827)",
  );
});

test("日付列: 正午UTCで書く", () => {
  assert.equal(toSharePointDate("2026-11-20"), "2026-11-20T12:00:00Z");
});
