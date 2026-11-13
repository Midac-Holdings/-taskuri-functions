/**
 * 検証モードの結果を、1つのHTMLファイル(外部読み込みなし)にする。
 * 中身は本人のメール由来なので、社外に共有しないこと。
 */
import { ExtractedTask, MailJudgement } from "../lib/prompt";
import { ROLE_LABEL, RecipientRole } from "../lib/recipient";
import { ReplyInfo } from "../lib/replies";

export interface TrialMail {
  subject: string;
  from: string;
  receivedAt: string;
  role: RecipientRole;
  reply: ReplyInfo | null;
  judgement: MailJudgement | null;
  error?: string;
}

export interface TrialReport {
  user: string;
  generatedAt: string;
  todayJst: string;
  days: number;
  sinceIso: string;
  inboxCount: number;
  excludedCount: number;
  truncated: boolean;
  mails: TrialMail[];
}

export interface TaskRow extends ExtractedTask {
  mail: TrialMail;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const PRIORITY_ORDER: Record<string, number> = { 高: 0, 中: 1, 低: 2 };

export function taskRows(mails: TrialMail[]): TaskRow[] {
  const rows: TaskRow[] = [];
  for (const m of mails) {
    if (!m.judgement?.actionRequired) continue;
    for (const t of m.judgement.tasks) rows.push({ ...t, mail: m });
  }
  return rows.sort((a, b) => {
    const da = a.dueDate ?? "9999-12-31";
    const db = b.dueDate ?? "9999-12-31";
    if (da !== db) return da < db ? -1 : 1;
    return (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9);
  });
}

/** 画面(張りぼて)の「今日やる」と同じ条件:期限が今日以前、または期限なしで優先度が高・中 */
export function isToday(t: ExtractedTask, todayJst: string): boolean {
  return t.dueDate !== null ? t.dueDate <= todayJst : t.priority !== "低";
}

const fmtDate = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

function dueText(due: string | null, today: string): string {
  if (!due) return "期限なし";
  const [, m, d] = due.split("-").map(Number);
  if (due < today) return `<span class="over">${m}/${d}(期限切れ)</span>`;
  if (due === today) return `<b>今日</b>`;
  return `${m}/${d}`;
}

function taskTable(rows: TaskRow[], today: string): string {
  if (!rows.length) return `<p class="empty">該当なし</p>`;
  const body = rows
    .map(
      (t) => `<tr>
<td><span class="pri p${esc(t.priority)}">${esc(t.priority)}</span></td>
<td><b>${esc(t.title)}</b><div class="sub">${esc(t.detail)}</div></td>
<td>${esc(t.actionType)}</td>
<td class="nowrap">${dueText(t.dueDate, today)}</td>
<td>${esc(ROLE_LABEL[t.mail.role])}<div class="sub">${esc(t.mail.judgement?.interpretation ?? "")}${t.mail.reply ? " / 返信済み" : ""}</div></td>
<td class="sub">${esc(t.mail.judgement?.reason ?? "")}</td>
<td class="sub">${esc(t.mail.from)}<br>「${esc(t.mail.subject)}」<br>${fmtDate(t.mail.receivedAt)}</td>
</tr>`,
    )
    .join("\n");
  return `<table><tr><th>優先</th><th>タスク</th><th>種類</th><th>期限</th><th>立場・判定</th><th>AIの理由</th><th>元メール</th></tr>${body}</table>`;
}

function noActionList(mails: TrialMail[]): string {
  const groups = new Map<string, TrialMail[]>();
  for (const m of mails) {
    if (!m.judgement || m.judgement.actionRequired) continue;
    const key = m.judgement.interpretation;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(
      ([k, list]) => `<details><summary>${esc(k)}(${list.length}通)</summary><table>
<tr><th>受信</th><th>立場</th><th>差出人・件名</th><th>AIの理由</th></tr>
${list
  .map(
    (m) =>
      `<tr><td class="nowrap">${fmtDate(m.receivedAt)}</td><td>${esc(ROLE_LABEL[m.role])}${m.reply ? "<div class=\"sub\">返信済み</div>" : ""}</td><td>${esc(m.from)}<div class="sub">「${esc(m.subject)}」</div></td><td class="sub">${esc(m.judgement?.reason ?? "")}</td></tr>`,
  )
  .join("\n")}
</table></details>`,
    )
    .join("\n");
}

export function renderReport(r: TrialReport): string {
  const rows = taskRows(r.mails);
  const today = rows.filter((t) => isToday(t, r.todayJst));
  const later = rows.filter((t) => !isToday(t, r.todayJst));
  const judged = r.mails.filter((m) => m.judgement);
  const errors = r.mails.filter((m) => m.error);
  const withTasks = judged.filter((m) => m.judgement?.actionRequired).length;
  const replied = judged.filter((m) => m.judgement?.interpretation === "対応済み").length;

  const stat = (label: string, n: number | string) => `<div class="stat"><b>${n}</b><span>${esc(label)}</span></div>`;

  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>タスクリ 検証レポート</title>
<style>
body{margin:0;font-family:"Hiragino Sans","Noto Sans JP",Meiryo,system-ui,sans-serif;background:#f4f4fb;color:#1f2133;line-height:1.55}
header{background:#4b4bc8;color:#fff;padding:20px 24px}h1{margin:0;font-size:1.5rem}header p{margin:4px 0 0;opacity:.9}
main{max-width:1280px;margin:0 auto;padding:16px 24px 48px}
.warn{background:#fff4d6;color:#7a4b00;padding:10px 14px;border-radius:10px;font-weight:700}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}.stat{background:#fff;border-radius:12px;padding:10px 16px;min-width:120px}
.stat b{display:block;font-size:1.6rem}.stat span{color:#5d6075;font-size:.85rem}
h2{margin:28px 0 8px;font-size:1.2rem}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;font-size:.9rem}
th{background:#1f2340;color:#f6f5fb;text-align:left;padding:8px;font-weight:700}td{padding:8px;border-bottom:1px solid #e4e5f2;vertical-align:top}
.sub{color:#5d6075;font-size:.82rem}.nowrap{white-space:nowrap}.over{color:#c0392b;font-weight:700}
.pri{display:inline-block;padding:1px 10px;border-radius:999px;font-weight:700}.p高{background:#fde2e1;color:#a12622}.p中{background:#fff0d4;color:#8a5300}.p低{background:#e3f3e8;color:#1e6b3a}
details{margin:8px 0}summary{cursor:pointer;font-weight:700;padding:6px 0}.empty{color:#5d6075}
</style></head><body>
<header><h1>📋 タスクリ 検証レポート</h1>
<p>${esc(r.user)}　直近${r.days}日(${fmtDate(r.sinceIso)}〜)の受信メール　作成 ${fmtDate(r.generatedAt)}</p></header>
<main>
<p class="warn">本人のメールから作った資料です。社外に共有しないでください。</p>
${r.truncated ? `<p class="warn">取得の上限に達したため、古い方から一部だけ判定しています(--max で上限を変えられます)。</p>` : ""}
<div class="stats">
${stat("受信メール", r.inboxCount)}${stat("除外(自分・除外送信者)", r.excludedCount)}${stat("AIが判定", judged.length)}
${stat("タスクありのメール", withTasks)}${stat("タスク", rows.length)}${stat("返信で対応済み", replied)}${errors.length ? stat("エラー", errors.length) : ""}
</div>
<h2>今日やる(期限が今日以前・期限なしで優先度 高/中)— ${today.length}件</h2>
${taskTable(today, r.todayJst)}
<h2>期限が先のもの・優先度 低 — ${later.length}件</h2>
${taskTable(later, r.todayJst)}
<h2>タスクにしなかったメール(見逃しがないか確認用)</h2>
${noActionList(r.mails)}
${errors.length ? `<h2>エラー</h2><table><tr><th>受信</th><th>件名</th><th>内容</th></tr>${errors.map((m) => `<tr><td class="nowrap">${fmtDate(m.receivedAt)}</td><td>${esc(m.subject)}</td><td class="sub">${esc(m.error ?? "")}</td></tr>`).join("")}</table>` : ""}
</main></body></html>`;
}
