/**
 * アイテム単位の権限設定。Graph v1.0 ではリストアイテムの権限を変えられないため、
 * ここだけ SharePoint REST API を使う。
 *
 * 動作:
 *   1. アイテムの権限の継承を切る(既存の権限はコピーしない)
 *   2. 本人に「投稿(Contribute)」を付与 → 本人だけが見られ、状態を「完了」に変えられる
 *   3. (任意)サイトの所有者グループに「フルコントロール」を付与 → 管理者が保守できる
 *
 * 注意: SharePoint REST のアプリ専用アクセスは、クライアントシークレットのトークンを受け付けない。
 *       本番はマネージドID、ローカルでは証明書認証のアプリ登録を使うこと。
 */
import { config } from "../config";
import { graphFetch } from "./graph";
import { tokenFor } from "./identity";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SharePoint の権限レベル(RoleType) */
export const ROLE_TYPE = { contribute: 3, fullControl: 5 } as const;

export const claimsFor = (email: string) => `i:0#.f|membership|${email.trim().toLowerCase()}`;

export const itemPath = (listId: string, itemId: string) =>
  `/_api/web/lists(guid'${listId.replace(/[{}]/g, "")}')/items(${Number(itemId)})`;

export const breakInheritancePath = (listId: string, itemId: string) =>
  `${itemPath(listId, itemId)}/breakroleinheritance(copyRoleAssignments=false,clearSubscopes=true)`;

export const addRolePath = (listId: string, itemId: string, principalId: number, roleDefId: number) =>
  `${itemPath(listId, itemId)}/roleassignments/addroleassignment(principalid=${principalId},roledefid=${roleDefId})`;

// ---------------------------------------------------------------- 接続

let webUrlCache: string | undefined;

/** Graph のサイトIDから SharePoint のサイトURLを求める */
async function webUrl(): Promise<string> {
  if (!webUrlCache) {
    const site = await graphFetch<{ webUrl: string }>(`/sites/${encodeURIComponent(config.siteId)}?$select=webUrl`);
    webUrlCache = site.webUrl.replace(/\/$/, "");
  }
  return webUrlCache;
}

async function spFetch<T>(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<T> {
  const base = await webUrl();
  const origin = new URL(base).origin;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(base + path, {
      method,
      headers: {
        Authorization: `Bearer ${await tokenFor(`${origin}/.default`)}`,
        Accept: "application/json;odata=nometadata",
        "Content-Type": "application/json;odata=nometadata",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if ((res.status === 429 || res.status === 503) && attempt < 4) {
      await sleep((Number(res.headers.get("Retry-After")) || 2 ** attempt) * 1000);
      continue;
    }
    if (!res.ok) {
      throw new Error(`SharePoint ${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

// ---------------------------------------------------------------- キャッシュ付きの参照

const principalCache = new Map<string, number>();
const roleDefCache = new Map<number, number>();
let ownerGroupCache: number | null | undefined;

/** ユーザーをサイトに登録(未登録なら)して、サイト内のIDを返す */
export async function ensureUserId(email: string): Promise<number> {
  const key = email.trim().toLowerCase();
  const hit = principalCache.get(key);
  if (hit !== undefined) return hit;
  const u = await spFetch<{ Id: number }>("/_api/web/ensureuser", "POST", { logonName: claimsFor(key) });
  principalCache.set(key, u.Id);
  return u.Id;
}

async function roleDefId(roleType: number): Promise<number> {
  const hit = roleDefCache.get(roleType);
  if (hit !== undefined) return hit;
  const r = await spFetch<{ Id: number }>(`/_api/web/roledefinitions/getbytype(${roleType})`);
  roleDefCache.set(roleType, r.Id);
  return r.Id;
}

async function ownerGroupId(): Promise<number | null> {
  if (ownerGroupCache === undefined) {
    try {
      const g = await spFetch<{ Id: number }>("/_api/web/associatedownergroup?$select=Id");
      ownerGroupCache = g?.Id ?? null;
    } catch {
      ownerGroupCache = null;
    }
  }
  return ownerGroupCache;
}

// ---------------------------------------------------------------- 公開関数

export async function hasUniquePermissions(listId: string, itemId: string): Promise<boolean> {
  const r = await spFetch<{ HasUniqueRoleAssignments: boolean }>(
    `${itemPath(listId, itemId)}?$select=HasUniqueRoleAssignments`,
  );
  return r.HasUniqueRoleAssignments === true;
}

/** アイテムを「本人(+所有者グループ)だけ」に制限する */
export async function restrictItemToUser(listId: string, itemId: string, userEmail: string): Promise<void> {
  // 先に参照を解決しておく(継承を切った後に失敗して、誰も見られないアイテムが残るのを防ぐ)
  const userId = await ensureUserId(userEmail);
  const contribute = await roleDefId(ROLE_TYPE.contribute);
  const owners = config.grantOwners ? await ownerGroupId() : null;
  const fullControl = owners !== null ? await roleDefId(ROLE_TYPE.fullControl) : null;

  await spFetch(breakInheritancePath(listId, itemId), "POST");
  await spFetch(addRolePath(listId, itemId, userId, contribute), "POST");
  if (owners !== null && fullControl !== null) {
    await spFetch(addRolePath(listId, itemId, owners, fullControl), "POST");
  }
}
