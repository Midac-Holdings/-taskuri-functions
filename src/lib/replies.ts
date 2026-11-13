/**
 * 「受信後に本人がすでに返信したか」の判定。
 * 送信済みフォルダのメールを会話(conversationId)ごとにまとめ、受信日時より後の送信を探す。
 */
import { SentMessage } from "./graph";

export interface ReplyInfo {
  /** 受信後の最新の返信日時 */
  sentAt: string;
  /** 返信の冒頭(Graph の bodyPreview、最大255文字) */
  preview: string;
}

export type ReplyIndex = Map<string, SentMessage[]>;

export function buildReplyIndex(sent: SentMessage[]): ReplyIndex {
  const index: ReplyIndex = new Map();
  for (const m of sent) {
    if (!m.conversationId) continue;
    const list = index.get(m.conversationId) ?? [];
    list.push(m);
    index.set(m.conversationId, list);
  }
  for (const list of index.values()) list.sort((a, b) => a.sentDateTime.localeCompare(b.sentDateTime));
  return index;
}

/** 受信日時より後に、同じ会話で本人が送った最新のメール */
export function findReplyAfter(index: ReplyIndex, conversationId: string | undefined, receivedIso: string): ReplyInfo | null {
  if (!conversationId) return null;
  const list = index.get(conversationId);
  if (!list) return null;
  const received = Date.parse(receivedIso);
  const after = list.filter((m) => Date.parse(m.sentDateTime) > received);
  const last = after[after.length - 1];
  return last ? { sentAt: last.sentDateTime, preview: (last.bodyPreview ?? "").trim() } : null;
}
