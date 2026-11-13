/**
 * 受信者としての立場をコード側で確定させる(AIに推測させない)。
 * AIはこの事実と本文を合わせて「自分がやるべきか」を判断する。
 */
export interface GraphAddress {
  emailAddress?: { address?: string; name?: string };
}

export type RecipientRole = "to_single" | "to_multi" | "cc" | "other";

export const ROLE_LABEL: Record<RecipientRole, string> = {
  to_single: "To(自分だけ)",
  to_multi: "To(複数宛て)",
  cc: "CC",
  other: "BCC・グループ経由",
};

export interface RecipientInfo {
  role: RecipientRole;
  toCount: number;
  ccCount: number;
  toNames: string[];
  ccNames: string[];
}

const norm = (s: string | undefined) => (s ?? "").trim().toLowerCase();

function names(list: GraphAddress[]): string[] {
  return list.map((a) => a.emailAddress?.name || a.emailAddress?.address || "").filter(Boolean);
}

/**
 * @param userAddresses 本人のアドレス(エイリアス含む)
 */
export function determineRole(
  userAddresses: string[],
  to: GraphAddress[] = [],
  cc: GraphAddress[] = [],
): RecipientInfo {
  const mine = new Set(userAddresses.map(norm).filter(Boolean));
  const inTo = to.some((a) => mine.has(norm(a.emailAddress?.address)));
  const inCc = cc.some((a) => mine.has(norm(a.emailAddress?.address)));

  let role: RecipientRole;
  if (inTo) role = to.length === 1 ? "to_single" : "to_multi";
  else if (inCc) role = "cc";
  else role = "other"; // BCC、配布リスト、M365グループ経由など

  return { role, toCount: to.length, ccCount: cc.length, toNames: names(to), ccNames: names(cc) };
}

/** 除外送信者(部分一致、大文字小文字は無視) */
export function isExcludedSender(from: GraphAddress | undefined, patterns: string[]): boolean {
  const addr = norm(from?.emailAddress?.address);
  const name = norm(from?.emailAddress?.name);
  return patterns.map(norm).filter(Boolean).some((p) => addr.includes(p) || name.includes(p));
}
