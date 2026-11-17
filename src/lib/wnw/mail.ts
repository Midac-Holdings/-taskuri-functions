/**
 * What'sNew ウォッチャー:新着のお知らせメールの文面。
 */
import { NewsItem, NEWS_URL } from "./news";

export const MAX_ITEMS_IN_MAIL = 10;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const jpDate = (d: string) => {
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[2])}月${Number(m[3])}日` : d;
};

export interface NewsMail {
  subject: string;
  html: string;
}

export function buildNewsMail(items: NewsItem[], appUrl?: string): NewsMail {
  const shown = items.slice(0, MAX_ITEMS_IN_MAIL);
  const subject =
    items.length === 1
      ? `【会社HP 新着】${items[0].title}`
      : `【会社HP 新着】${shown[0].title} ほか${items.length - 1}件`;
  const rows = shown
    .map(
      (i) =>
        `<li style="margin:0 0 12px">` +
        `<span style="color:#5a6876;font-size:13px">${esc(jpDate(i.date))}${i.category ? `・${esc(i.category)}` : ""}</span><br>` +
        `<a href="${esc(i.url)}" style="color:#0f6fb8;font-weight:bold">${esc(i.title)}</a></li>`,
    )
    .join("");
  const more = items.length > shown.length ? `<p>ほかに ${items.length - shown.length} 件あります。</p>` : "";
  const footer = appUrl
    ? `<a href="${esc(appUrl)}">What'sNew ウォッチャー</a>の「メールの受け取りをやめる」で配信を止められます。`
    : `What'sNew ウォッチャーの「メールの受け取りをやめる」で配信を止められます。`;
  const html =
    `<div style="font-family:'Hiragino Sans','Meiryo',sans-serif;font-size:15px;line-height:1.6;color:#1b2733">` +
    `<p>会社HPに新しい記事が載りました。</p>` +
    `<ul style="padding-left:20px">${rows}</ul>${more}` +
    `<p><a href="${esc(NEWS_URL)}">新着情報の一覧を開く</a></p>` +
    `<hr style="border:0;border-top:1px solid #e1e8ef">` +
    `<p style="color:#5a6876;font-size:12px">このメールは What'sNew ウォッチャーに登録した方にお送りしています(送信専用)。${footer}</p>` +
    `</div>`;
  return { subject, html };
}
