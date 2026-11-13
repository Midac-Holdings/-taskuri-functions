/**
 * 検証モード:本人のアカウントでログインし、直近N日の受信メールからタスク一覧(HTML)を作る。
 * Azure へのデプロイ、Exchange・SharePoint の権限設定は不要。SharePoint には書き込まない。
 *
 *   npm run trial -- --days 30 --aliases "山田さん,山田部長" --exclude "noreply@,newsletter"
 *
 * 必要な環境変数:
 *   AZURE_TENANT_ID   テナントID
 *   TRIAL_CLIENT_ID   検証用アプリ登録のクライアントID(パブリッククライアント、委任の Mail.Read と User.Read)
 *   AOAI_ENDPOINT / AOAI_DEPLOYMENT(AOAI_API_VERSION は任意)
 *   AOAI へは DefaultAzureCredential(az login 済みのアカウント)で接続する
 */
import { writeFileSync } from "node:fs";
import { DeviceCodeCredential } from "@azure/identity";
import { config } from "../config";
import { judgeMail } from "../lib/aoai";
import { graphFetch, listInboxMessagesSince, listSentSince, MailMessage } from "../lib/graph";
import { useGraphCredential } from "../lib/identity";
import { determineRole, isExcludedSender } from "../lib/recipient";
import { buildReplyIndex, findReplyAfter } from "../lib/replies";
import { toJst } from "../lib/time";
import { renderReport, TrialMail, TrialReport } from "./report";

export interface TrialArgs {
  days: number;
  max: number;
  out: string;
  aliases: string[];
  exclude: string[];
}

const list = (v: string | undefined) => (v ?? "").split(/[,、]/).map((x) => x.trim()).filter(Boolean);

export function parseArgs(argv: string[]): TrialArgs {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const days = Number(get("days") ?? 30);
  const max = Number(get("max") ?? 1000);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("--days は 1〜90 で指定してください");
  if (!Number.isInteger(max) || max < 1 || max > 5000) throw new Error("--max は 1〜5000 で指定してください");
  return {
    days,
    max,
    out: get("out") ?? "taskuri-report.html",
    aliases: list(get("aliases")),
    exclude: list(get("exclude")),
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が未設定です`);
  return v;
}

const addr = (m: MailMessage) =>
  m.from?.emailAddress?.name
    ? `${m.from.emailAddress.name} <${m.from.emailAddress.address ?? ""}>`
    : m.from?.emailAddress?.address ?? "(不明)";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tenantId = required("AZURE_TENANT_ID");
  const clientId = required("TRIAL_CLIENT_ID");
  void config.aoaiEndpoint; // 未設定なら最初に止める
  void config.aoaiDeployment;

  useGraphCredential(
    new DeviceCodeCredential({ tenantId, clientId, userPromptCallback: (info) => console.log(`\n${info.message}\n`) }),
    "https://graph.microsoft.com/.default",
  );

  const me = await graphFetch<{ displayName?: string; mail?: string; userPrincipalName: string }>(
    "/me?$select=displayName,mail,userPrincipalName",
  );
  const myAddresses = [me.mail, me.userPrincipalName].filter((x): x is string => !!x);
  const userName = me.displayName ?? me.userPrincipalName;
  console.log(`ログイン: ${userName}`);

  const now = new Date();
  const sinceIso = new Date(now.getTime() - args.days * 86400_000).toISOString();
  console.log(`直近${args.days}日の受信メールを取得しています…`);
  const inbox = await listInboxMessagesSince("me", sinceIso, args.max);
  const sent = await listSentSince("me", sinceIso, args.max * 2);
  const replyIndex = buildReplyIndex(sent);
  console.log(`受信 ${inbox.length}通 / 送信 ${sent.length}通 を取得しました`);

  const isMine = (m: MailMessage) =>
    myAddresses.some((a) => a.toLowerCase() === (m.from?.emailAddress?.address ?? "").toLowerCase());
  const targets = inbox.filter((m) => !isMine(m) && !isExcludedSender(m.from, args.exclude));
  const todayJst = toJst(now).date;

  const results: TrialMail[] = new Array(targets.length);
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const i = next++;
      const m = targets[i];
      const recipient = determineRole(myAddresses, m.toRecipients, m.ccRecipients);
      const reply = findReplyAfter(replyIndex, m.conversationId, m.receivedDateTime);
      const base: TrialMail = {
        subject: m.subject ?? "(件名なし)",
        from: addr(m),
        receivedAt: m.receivedDateTime,
        role: recipient.role,
        reply,
        judgement: null,
      };
      try {
        base.judgement = await judgeMail({
          userName,
          nameAliases: args.aliases,
          todayJst,
          recipient,
          from: base.from,
          subject: base.subject,
          receivedAt: m.receivedDateTime,
          importance: m.importance,
          body: m.uniqueBody?.content ?? m.bodyPreview ?? "",
          reply,
        });
      } catch (e) {
        base.error = e instanceof Error ? e.message.slice(0, 300) : String(e);
      }
      results[i] = base;
      done++;
      if (done % 10 === 0 || done === targets.length) console.log(`判定中… ${done}/${targets.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.aiConcurrency, targets.length) }, worker));

  const report: TrialReport = {
    user: userName,
    generatedAt: now.toISOString(),
    todayJst,
    days: args.days,
    sinceIso,
    inboxCount: inbox.length,
    excludedCount: inbox.length - targets.length,
    truncated: inbox.length >= args.max,
    mails: results,
  };
  writeFileSync(args.out, renderReport(report), "utf8");
  writeFileSync(args.out.replace(/\.html?$/i, "") + ".json", JSON.stringify(report, null, 2), "utf8");
  const tasks = results.reduce((n, m) => n + (m.judgement?.actionRequired ? m.judgement.tasks.length : 0), 0);
  console.log(`\n完了: タスク ${tasks}件 → ${args.out}(同じ名前の .json も出力)`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
