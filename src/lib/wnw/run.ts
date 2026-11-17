/**
 * What'sNew ウォッチャー:会社HPの新着を確認し、新しい記事があれば登録者にメールする(1回分)。
 *
 *   会社HPを読む → 通知済みの記事IDと比べる → 新しい記事があれば登録者ごとにメール → 通知済みに追加
 *
 * - 初回(状態がない)は、今ある記事をすべて通知済みにするだけで、メールは送らない(50件まとめて届くのを防ぐ)。
 * - 一覧の記事がすべて「新しい」と判定されたときは、HPの形式やIDの付け方が変わった可能性が高いので、
 *   メールは送らずに通知済みを作り直す(誤って大量に送らないため)。
 * - 全員への送信に失敗したら通知済みを更新しない(次回もう一度送る)。一部だけ失敗したときはログに残して進める。
 */
import { NewsItem } from "./news";
import { buildNewsMail } from "./mail";
import { MAX_SEEN, NewsState, Subscriber } from "./table";

export interface WnwDeps {
  fetchNews: () => Promise<NewsItem[]>;
  getState: () => Promise<NewsState | null>;
  saveState: (seenIds: string[]) => Promise<void>;
  listSubscribers: () => Promise<Subscriber[]>;
  sendMail: (to: string, subject: string, html: string) => Promise<void>;
  appUrl?: string;
  log: (m: string) => void;
}

export type WnwResult =
  | { kind: "initialized"; items: number }
  | { kind: "reset"; items: number }
  | { kind: "no-news" }
  | { kind: "notified"; newItems: number; sent: number; failed: number };

export async function runWnw(d: WnwDeps): Promise<WnwResult> {
  const items = await d.fetchNews();
  const state = await d.getState();
  const ids = items.map((i) => i.id);

  if (!state) {
    await d.saveState(ids);
    d.log(`What'sNew: 初回のため ${ids.length} 件を通知済みにしました(メールは送りません)`);
    return { kind: "initialized", items: ids.length };
  }

  const seen = new Set(state.seenIds);
  const fresh = items.filter((i) => !seen.has(i.id));
  if (fresh.length === 0) return { kind: "no-news" };

  if (fresh.length === items.length && items.length > 3) {
    await d.saveState(ids);
    d.log(`[注意] What'sNew: 一覧の ${items.length} 件がすべて新しいと判定されました。HPの形式が変わった可能性があるため、メールは送らずに通知済みを作り直しました`);
    return { kind: "reset", items: items.length };
  }

  const subs = await d.listSubscribers();
  const mail = buildNewsMail(fresh, d.appUrl);
  let sent = 0;
  let failed = 0;
  for (const s of subs) {
    try {
      await d.sendMail(s.email, mail.subject, mail.html);
      sent++;
    } catch (e) {
      failed++;
      d.log(`[エラー] What'sNew: ${s.email} への送信に失敗しました: ${(e as Error).message}`);
    }
  }
  if (subs.length > 0 && sent === 0) {
    throw new Error(`What'sNew: 全員(${subs.length}名)への送信に失敗したため、次回もう一度送ります`);
  }

  await d.saveState([...new Set([...ids, ...state.seenIds])].slice(0, MAX_SEEN));
  d.log(`What'sNew: 新着 ${fresh.length} 件を ${sent} 名に送信しました${failed ? `(失敗 ${failed} 名)` : ""}`);
  return { kind: "notified", newItems: fresh.length, sent, failed };
}
