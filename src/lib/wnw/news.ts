/**
 * What'sNew ウォッチャー:会社HP(www.midac.jp)の新着情報一覧を読む(読むだけ)。
 * 市民開発基盤(Midac-Holdings/citizen-dev-platform)の api/src/lib/midacNews.js と同じ読み取り方。
 * HPの形式が変わったときは両方を直す。
 */

export const NEWS_URL = "https://www.midac.jp/news/";
export const MAX_ITEMS = 50;
const MAX_BYTES = 2 * 1024 * 1024;

export interface NewsItem {
  id: string;
  date: string; // YYYY-MM-DD
  category: string;
  title: string;
  url: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** 新着情報一覧の HTML(ul.u-listNews > li)から、日付・種類・タイトル・リンクを取り出す */
export function parseNews(html: string, base = NEWS_URL): NewsItem[] {
  const start = html.indexOf('class="u-listNews"');
  if (start < 0) return [];
  const end = html.indexOf("</ul>", start);
  const list = html.slice(start, end < 0 ? undefined : end);
  const origin = new URL(base).origin;
  const items: NewsItem[] = [];
  for (const [, li] of list.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
    const day = li.match(/class="day"[^>]*>([\s\S]*?)<\/span>/);
    const href = li.match(/<a\s[^>]*href="([^"]+)"/);
    const title = li.match(/class="u-linktxt"[^>]*>([\s\S]*?)<\/span>/);
    if (!day || !href || !title) continue;
    const d = text(day[1]).match(/^(\d{4})[./](\d{1,2})[./](\d{1,2})$/);
    if (!d) continue;
    let url: URL;
    try {
      url = new URL(href[1], base);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue; // 会社HP内のリンクだけ
    const category = li.match(/class="icon"[^>]*>([\s\S]*?)<\/span>/);
    items.push({
      id: url.pathname.replace(/^\/news\//, "").replace(/\.html$/, ""),
      date: `${d[1]}-${d[2].padStart(2, "0")}-${d[3].padStart(2, "0")}`,
      category: category ? text(category[1]) : "",
      title: text(title[1]),
      url: url.href,
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

export async function fetchNews(fetchFn: typeof fetch = fetch, timeoutMs = 15000): Promise<NewsItem[]> {
  const res = await fetchFn(NEWS_URL, {
    headers: { "User-Agent": "MidacCitizenAppPlatform/1.0 (What'sNew watcher)" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`会社HPがエラーを返しました(HTTP ${res.status})`);
  const items = parseNews((await res.text()).slice(0, MAX_BYTES));
  if (items.length === 0) throw new Error("会社HPの新着情報を読み取れませんでした(ページの形式が変わった可能性があります)");
  return items;
}
