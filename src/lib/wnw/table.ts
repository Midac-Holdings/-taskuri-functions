/**
 * What'sNew ウォッチャー:Azure Table Storage(テーブル WnwWatcher)の読み書き。マネージドIDで接続する。
 *   PartitionKey "subscriber" … メール受け取りの登録者(RowKey=メールアドレス)。登録・解除は市民開発基盤の画面から
 *   PartitionKey "state"      … RowKey "news" に、通知済みの記事IDの一覧(SeenIds、JSON)
 */
import { tokenFor } from "../identity";

const VERSION = "2020-12-06";
const STATE_PK = "state";
const STATE_RK = "news";
export const MAX_SEEN = 500;

export interface TableTarget {
  endpoint: string; // https://<アカウント>.table.core.windows.net
  table: string;
}

export interface Subscriber {
  email: string;
}

export interface NewsState {
  seenIds: string[];
  updatedAt?: string;
}

type TokenFn = () => Promise<string>;
const storageToken: TokenFn = () => tokenFor("https://storage.azure.com/.default");

async function tableFetch(url: string, init: RequestInit, token: TokenFn, fetchFn: typeof fetch): Promise<Response> {
  return fetchFn(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${await token()}`,
      Accept: "application/json;odata=nometadata",
      "x-ms-version": VERSION,
      "x-ms-date": new Date().toUTCString(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function fail(res: Response, what: string): Promise<never> {
  const body = await res.text().catch(() => "");
  throw new Error(`Table Storage ${what} -> ${res.status}: ${body.slice(0, 300)}`);
}

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** 登録者の一覧(メールアドレスの形のものだけ)。1000件を超えたら続きのページも読む */
export async function listSubscribers(t: TableTarget, token: TokenFn = storageToken, fetchFn: typeof fetch = fetch): Promise<Subscriber[]> {
  const out: Subscriber[] = [];
  const filter = encodeURIComponent("PartitionKey eq 'subscriber'");
  let next = "";
  for (let page = 0; page < 100; page++) {
    const res = await tableFetch(`${t.endpoint}/${t.table}()?$filter=${filter}&$select=RowKey${next}`, { method: "GET" }, token, fetchFn);
    if (res.status === 404) return out; // テーブル未作成
    if (!res.ok) await fail(res, "登録者の読み込み");
    const data = (await res.json()) as { value?: { RowKey?: string }[] };
    for (const e of data.value ?? []) {
      const email = String(e.RowKey ?? "").toLowerCase();
      if (EMAIL.test(email)) out.push({ email });
    }
    const pk = res.headers.get("x-ms-continuation-NextPartitionKey");
    const rk = res.headers.get("x-ms-continuation-NextRowKey");
    if (!pk) break;
    next = `&NextPartitionKey=${encodeURIComponent(pk)}${rk ? `&NextRowKey=${encodeURIComponent(rk)}` : ""}`;
  }
  return out;
}

const stateUrl = (t: TableTarget) => `${t.endpoint}/${t.table}(PartitionKey='${STATE_PK}',RowKey='${STATE_RK}')`;

/** 通知済みの記事ID。まだ一度も動いていなければ null */
export async function getState(t: TableTarget, token: TokenFn = storageToken, fetchFn: typeof fetch = fetch): Promise<NewsState | null> {
  const res = await tableFetch(stateUrl(t), { method: "GET" }, token, fetchFn);
  if (res.status === 404) return null;
  if (!res.ok) await fail(res, "状態の読み込み");
  const e = (await res.json()) as { SeenIds?: string; UpdatedAt?: string };
  let seenIds: string[] = [];
  try {
    const v = JSON.parse(e.SeenIds ?? "[]");
    if (Array.isArray(v)) seenIds = v.filter((x): x is string => typeof x === "string");
  } catch {
    seenIds = [];
  }
  return { seenIds, updatedAt: e.UpdatedAt };
}

export async function saveState(t: TableTarget, seenIds: string[], now = new Date(), token: TokenFn = storageToken, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await tableFetch(
    stateUrl(t),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ PartitionKey: STATE_PK, RowKey: STATE_RK, SeenIds: JSON.stringify(seenIds.slice(0, MAX_SEEN)), UpdatedAt: now.toISOString() }),
    },
    token,
    fetchFn,
  );
  if (!res.ok) await fail(res, "状態の保存");
}

/** テーブルがなければ作る(初回のみ。既にあれば 409 で何もしない) */
export async function ensureTable(t: TableTarget, token: TokenFn = storageToken, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await tableFetch(
    `${t.endpoint}/Tables`,
    { method: "POST", headers: { "Content-Type": "application/json", Prefer: "return-no-content" }, body: JSON.stringify({ TableName: t.table }) },
    token,
    fetchFn,
  );
  if (res.ok || res.status === 409) return;
  await fail(res, "テーブルの作成");
}
