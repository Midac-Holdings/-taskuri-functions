import { DefaultAzureCredential, TokenCredential } from "@azure/identity";

/** Graph / SharePoint / AOAI で共通に使う資格情報(本番はマネージドID) */
export const credential = new DefaultAzureCredential();

export async function tokenFor(scope: string, cred: TokenCredential = credential): Promise<string> {
  const t = await cred.getToken(scope);
  if (!t) throw new Error(`トークンを取得できませんでした: ${scope}`);
  return t.token;
}

// ---------------------------------------------------------------- Graph 用の資格情報

/**
 * Graph だけ別の資格情報に差し替えられるようにする。
 * 検証モードでは、本人がデバイスコードでログインした委任トークン(/me のメールだけ読める)を使う。
 */
let graphCredential: TokenCredential = credential;
let graphScope = "https://graph.microsoft.com/.default";

export function useGraphCredential(cred: TokenCredential, scope: string): void {
  graphCredential = cred;
  graphScope = scope;
}

export const graphToken = () => tokenFor(graphScope, graphCredential);
