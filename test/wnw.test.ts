import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNews, NewsItem } from "../src/lib/wnw/news";
import { buildNewsMail } from "../src/lib/wnw/mail";
import { runWnw, WnwDeps } from "../src/lib/wnw/run";
import { getState, listSubscribers, saveState } from "../src/lib/wnw/table";

const HTML = `
<ul class="u-listNews">
  <li><div class="hd"><span class="day">2026.11.16</span><span class="icon">お知らせ</span></div>
    <a href="/news/20261116_0350.html"><span class="u-linktxt">電子メールの送受信障害回復について</span></a></li>
  <li><div class="hd"><span class="day">2026.11.5</span><span class="icon">法令・許可</span></div>
    <a href="/news/20261105_0347.html"><span class="u-linktxt">第２回 &amp; 出展</span></a></li>
  <li><div class="hd"><span class="day">2026.11.01</span><span class="icon">お知らせ</span></div>
    <a href="https://evil.example.com/a.html"><span class="u-linktxt">外部</span></a></li>
</ul>`;

test("会社HPの一覧を読む(外部リンクは捨てる)", () => {
  assert.deepEqual(parseNews(HTML), [
    { id: "20261116_0350", date: "2026-11-16", category: "お知らせ", title: "電子メールの送受信障害回復について", url: "https://www.midac.jp/news/20261116_0350.html" },
    { id: "20261105_0347", date: "2026-11-05", category: "法令・許可", title: "第２回 & 出展", url: "https://www.midac.jp/news/20261105_0347.html" },
  ]);
});

const item = (id: string, title = `記事${id}`): NewsItem => ({ id, date: "2026-11-17", category: "お知らせ", title, url: `https://www.midac.jp/news/${id}.html` });

test("メールの件名と本文(HTMLは無害化)", () => {
  const one = buildNewsMail([item("a", "<b>重要</b>")], "https://example.azurestaticapps.net/cp/wnw/");
  assert.equal(one.subject, "【会社HP 新着】<b>重要</b>");
  assert.match(one.html, /&lt;b&gt;重要&lt;\/b&gt;/);
  assert.doesNotMatch(one.html, /<b>重要/);
  assert.match(one.html, /cp\/wnw\//);
  const many = buildNewsMail(Array.from({ length: 12 }, (_, i) => item(String(i))));
  assert.equal(many.subject, "【会社HP 新着】記事0 ほか11件");
  assert.match(many.html, /ほかに 2 件あります/);
});

function deps(over: Partial<WnwDeps> & { items: NewsItem[]; seen: string[] | null; subs?: string[] }) {
  const sent: { to: string; subject: string }[] = [];
  const saved: string[][] = [];
  const logs: string[] = [];
  const d: WnwDeps = {
    fetchNews: async () => over.items,
    getState: async () => (over.seen ? { seenIds: over.seen } : null),
    saveState: async (ids) => void saved.push(ids),
    listSubscribers: async () => (over.subs ?? ["a@midac.jp", "b@midac.jp"]).map((email) => ({ email })),
    sendMail: async (to, subject) => void sent.push({ to, subject }),
    log: (m) => void logs.push(m),
    ...over,
  };
  return { d, sent, saved, logs };
}

test("初回は通知済みにするだけでメールは送らない", async () => {
  const { d, sent, saved } = deps({ items: [item("1"), item("2")], seen: null });
  assert.deepEqual(await runWnw(d), { kind: "initialized", items: 2 });
  assert.equal(sent.length, 0);
  assert.deepEqual(saved, [["1", "2"]]);
});

test("新しい記事がなければ何もしない", async () => {
  const { d, sent, saved } = deps({ items: [item("1"), item("2")], seen: ["1", "2"] });
  assert.deepEqual(await runWnw(d), { kind: "no-news" });
  assert.equal(sent.length, 0);
  assert.equal(saved.length, 0);
});

test("新しい記事を登録者全員に送り、通知済みに追加する", async () => {
  const { d, sent, saved } = deps({ items: [item("3", "新記事"), item("1"), item("2")], seen: ["1", "2", "old"] });
  assert.deepEqual(await runWnw(d), { kind: "notified", newItems: 1, sent: 2, failed: 0 });
  assert.deepEqual(sent.map((s) => s.to), ["a@midac.jp", "b@midac.jp"]);
  assert.equal(sent[0].subject, "【会社HP 新着】新記事");
  assert.deepEqual(saved, [["3", "1", "2", "old"]]);
});

test("登録者がいなくても通知済みは進める(後から登録した人に古い記事を送らない)", async () => {
  const { d, saved } = deps({ items: [item("3"), item("1")], seen: ["1"], subs: [] });
  assert.deepEqual(await runWnw(d), { kind: "notified", newItems: 1, sent: 0, failed: 0 });
  assert.deepEqual(saved, [["3", "1"]]);
});

test("一部の送信失敗はログに残して進める", async () => {
  const { d, saved, logs } = deps({
    items: [item("3"), item("1")],
    seen: ["1"],
    sendMail: async (to) => {
      if (to === "a@midac.jp") throw new Error("Graph 403");
    },
  });
  assert.deepEqual(await runWnw(d), { kind: "notified", newItems: 1, sent: 1, failed: 1 });
  assert.equal(saved.length, 1);
  assert.ok(logs.some((l) => l.includes("a@midac.jp") && l.includes("Graph 403")));
});

test("全員に失敗したら通知済みを更新せず、次回もう一度送る", async () => {
  const { d, saved } = deps({ items: [item("3"), item("1")], seen: ["1"], sendMail: async () => { throw new Error("Graph 403"); } });
  await assert.rejects(runWnw(d), /次回もう一度送ります/);
  assert.equal(saved.length, 0);
});

test("一覧がすべて新しいと判定されたら、送らずに作り直す(HPの形式変更の疑い)", async () => {
  const items = ["n1", "n2", "n3", "n4", "n5"].map((id) => item(id));
  const { d, sent, saved } = deps({ items, seen: ["1", "2"] });
  assert.deepEqual(await runWnw(d), { kind: "reset", items: 5 });
  assert.equal(sent.length, 0);
  assert.deepEqual(saved, [["n1", "n2", "n3", "n4", "n5"]]);
});

// ---------------------------------------------------------------- Table Storage(通信の形)

const T = { endpoint: "https://acct.table.core.windows.net", table: "WnwWatcher" };
const token = async () => "tkn";

function fakeFetch(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return responses.shift()!;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("登録者の一覧:続きのページも読み、アドレスの形でないものは捨てる", async () => {
  const { fn, calls } = fakeFetch([
    new Response(JSON.stringify({ value: [{ RowKey: "A@midac.jp" }, { RowKey: "bad" }] }), { headers: { "x-ms-continuation-NextPartitionKey": "pk", "x-ms-continuation-NextRowKey": "rk" } }),
    new Response(JSON.stringify({ value: [{ RowKey: "b@midac.jp" }] })),
  ]);
  assert.deepEqual(await listSubscribers(T, token, fn), [{ email: "a@midac.jp" }, { email: "b@midac.jp" }]);
  assert.match(calls[0].url, /WnwWatcher\(\)\?\$filter=PartitionKey%20eq%20'subscriber'/);
  assert.match(calls[1].url, /NextPartitionKey=pk&NextRowKey=rk$/);
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer tkn");
});

test("状態:なければ null、保存は JSON で", async () => {
  const { fn, calls } = fakeFetch([new Response("", { status: 404 }), new Response(JSON.stringify({ SeenIds: '["x","y"]' })), new Response(null, { status: 204 })]);
  assert.equal(await getState(T, token, fn), null);
  assert.deepEqual((await getState(T, token, fn))?.seenIds, ["x", "y"]);
  await saveState(T, ["x"], new Date("2026-11-17T00:00:00Z"), token, fn);
  assert.equal(calls[2].init.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { PartitionKey: "state", RowKey: "news", SeenIds: '["x"]', UpdatedAt: "2026-11-17T00:00:00.000Z" });
});
