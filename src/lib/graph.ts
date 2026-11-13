import { config } from "../config";
import { graphToken } from "./identity";
import { GraphAddress } from "./recipient";

const GRAPH = "https://graph.microsoft.com/v1.0";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const accessToken = graphToken;

/** Graph呼び出し。429/5xx は Retry-After に従って最大4回リトライ。 */
export async function graphFetch<T>(
  pathOrUrl: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const url = pathOrUrl.startsWith("https://") ? pathOrUrl : GRAPH + pathOrUrl;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = Number(res.headers.get("Retry-After")) || 2 ** attempt;
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Graph ${init.method ?? "GET"} ${url} -> ${res.status}: ${text.slice(0, 500)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

interface Page<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

// ---------------------------------------------------------------- メール

export interface MailMessage {
  id: string;
  internetMessageId?: string;
  subject?: string;
  receivedDateTime: string;
  importance?: string;
  webLink?: string;
  from?: GraphAddress;
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
  uniqueBody?: { content?: string };
  bodyPreview?: string;
  conversationId?: string;
}

const MAIL_FIELDS = [
  "id", "internetMessageId", "subject", "receivedDateTime", "importance", "webLink",
  "from", "toRecipients", "ccRecipients", "uniqueBody", "bodyPreview", "conversationId",
].join(",");

/** "me" なら委任トークンの本人(/me)、それ以外は /users/{アドレス} */
export const mailboxPath = (user: string) =>
  user === "me" ? "/me" : `/users/${encodeURIComponent(user)}`;

async function listFolderSince<T>(user: string, folder: string, dateField: string, sinceIso: string, select: string, max: number, preferText: boolean): Promise<T[]> {
  const filter = encodeURIComponent(`${dateField} gt ${sinceIso}`);
  let url: string | undefined =
    `${mailboxPath(user)}/mailFolders/${folder}/messages` +
    `?$filter=${filter}&$orderby=${dateField}%20asc&$top=50&$select=${select}`;
  const out: T[] = [];
  while (url && out.length < max) {
    const page: Page<T> = await graphFetch<Page<T>>(url, {
      headers: preferText ? { Prefer: 'outlook.body-content-type="text"' } : {},
    });
    out.push(...page.value);
    url = page["@odata.nextLink"];
  }
  return out.slice(0, max);
}

/**
 * 受信トレイから sinceIso 以降のメールを古い順に取得。
 * uniqueBody は引用部分を除いた本文なので、返信スレッドでもトークンを節約できる。
 */
export function listInboxMessagesSince(user: string, sinceIso: string, max: number): Promise<MailMessage[]> {
  return listFolderSince<MailMessage>(user, "inbox", "receivedDateTime", sinceIso, MAIL_FIELDS, max, true);
}

export interface SentMessage {
  conversationId?: string;
  sentDateTime: string;
  bodyPreview?: string;
}

/** 送信済みフォルダから sinceIso 以降に送ったメール(返信済みの判定用) */
export function listSentSince(user: string, sinceIso: string, max: number): Promise<SentMessage[]> {
  return listFolderSince<SentMessage>(user, "sentitems", "sentDateTime", sinceIso, "conversationId,sentDateTime,bodyPreview", max, false);
}

// ---------------------------------------------------------------- SharePoint リスト

export interface ListItem<F> {
  id: string;
  fields: F;
}

const listPath = (listId: string) =>
  `/sites/${encodeURIComponent(config.siteId)}/lists/${encodeURIComponent(listId)}`;

/** 列にインデックスを付けていない小さなリストでも絞り込めるよう Prefer ヘッダーを付ける */
const NON_INDEXED = { Prefer: "HonorNonIndexedQueriesWarningMayFailRandomly" };

export async function getListItems<F>(listId: string, filter?: string): Promise<ListItem<F>[]> {
  let url: string | undefined =
    `${listPath(listId)}/items?$expand=fields&$top=200` +
    (filter ? `&$filter=${encodeURIComponent(filter)}` : "");
  const out: ListItem<F>[] = [];
  while (url) {
    const page: Page<ListItem<F>> = await graphFetch<Page<ListItem<F>>>(url, { headers: NON_INDEXED });
    out.push(...page.value);
    url = page["@odata.nextLink"];
  }
  return out;
}

export async function createListItem(listId: string, fields: Record<string, unknown>): Promise<string> {
  const res = await graphFetch<{ id: string }>(`${listPath(listId)}/items`, { method: "POST", body: { fields } });
  return res.id;
}

export async function updateListItemFields(listId: string, itemId: string, fields: Record<string, unknown>): Promise<void> {
  await graphFetch(`${listPath(listId)}/items/${encodeURIComponent(itemId)}/fields`, { method: "PATCH", body: fields });
}

export async function deleteListItem(listId: string, itemId: string): Promise<void> {
  await graphFetch(`${listPath(listId)}/items/${encodeURIComponent(itemId)}`, { method: "DELETE" });
}

/** OData 文字列リテラルのエスケープ */
export const odataString = (s: string) => `'${s.replace(/'/g, "''")}'`;
