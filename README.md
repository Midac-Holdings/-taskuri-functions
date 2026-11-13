# タスクリ(共通基盤)

Outlookの受信メールを読み、本人が今日やるべきタスクを自社のAOAIで抜き出して、SharePointリストに書き込みます。
市民開発者はこのリストを使ってPower Appsで画面を作ります。

```
タイマー(15分おき)
  └ 設定リストを読む → 実行時刻(JST)を過ぎたユーザーだけ処理
      └ Graphで前回実行以降の受信メールを取得
          └ To/CC/BCCの立場をコードで確定
              └ AOAIで判定(自分がやるべきか・タスク抽出)
                  └ タスクリストに書き込み → 設定リストの LastRunAt を更新
```

## ファイル構成

| ファイル | 役割 |
|---|---|
| `src/functions/taskuriTimer.ts` | 15分おきのタイマー。各ユーザーの実行時刻を見て処理 |
| `src/functions/taskuriRunNow.ts` | 手動実行API(`POST /api/taskuri/run?user=...`) |
| `src/lib/recipient.ts` | 宛先の立場の判定(To単独 / To複数 / CC / BCC・グループ) |
| `src/lib/prompt.ts` | AOAIへのプロンプトと出力スキーマ(Structured Outputs) |
| `src/lib/aoai.ts` | AOAI呼び出し(マネージドID) |
| `src/lib/graph.ts` | メール取得、SharePointリストの読み書き |
| `src/lib/lists.ts` | リストの列定義と変換 |
| `src/lib/processUser.ts` | 1ユーザー分の処理(重複チェック、失敗時の再試行) |
| `src/lib/replies.ts` | 受信後に本人が返信済みかの判定(送信済みフォルダを参照) |
| `src/lib/sharepointRest.ts` | タスクごとに本人だけが見られる権限を付ける |
| `src/trial/run.ts`, `report.ts` | 検証モード(直近N日のメールからHTMLレポートを作る) |

## To / CC の判断の仕組み

宛先上の立場はコードで確定させ、AIには「本人はCC、Toは佐藤さん1名」のように事実として渡します。
AIはその立場と本文から判断します。

- **To(自分だけ)**:依頼・質問・期限があればタスクにする
- **To(複数宛て)**:本人が名指しされていれば個別依頼、「皆さん」なら同報の依頼としてタスクにする。他の人が名指しされていればタスクにしない
- **CC**:原則は参考共有でタスクにしない。本文で本人が呼ばれている、CCにも確認を求めている、本人の承認が必要、のどれかならタスクにする
- **BCC・グループ経由**:一斉配信として扱い、全員への明確な依頼だけタスクにする

名指しを見分けるため、設定リストの `NameAliases`(呼ばれ方)に「山田さん、山田部長」などを登録します。
判定結果は `Interpretation` 列、理由は `Reason` 列に残るので、判定が正しかったかを後から確認できます。

## SharePointリストの定義

> 列は必ず**英語の内部名で作成してから**、表示名を日本語に変更してください。
> 作成時の名前が内部名として固定され、コードは内部名で読み書きします。

### タスクリスト `TaskuriTasks`

| 内部名 | 表示名 | 種類 | 備考 |
|---|---|---|---|
| Title | タスク名 | 1行テキスト | 既定の列 |
| Detail | 詳細 | 複数行テキスト(プレーン) | |
| ActionType | 種類 | 選択肢 | 返信 / 対応 / 確認 / 承認 / 提出 / 参加 / その他 |
| DueDate | 期限 | 日付のみ | |
| Priority | 優先度 | 選択肢 | 高 / 中 / 低 |
| Status | 状態 | 選択肢 | 未着手 / 完了 / 対象外(既定:未着手) |
| AssigneeEmail | 担当者メール | 1行テキスト | **インデックスを作成** |
| RecipientRole | 宛先 | 1行テキスト | To(自分だけ) など |
| Interpretation | AI判定 | 1行テキスト | 自分への個別依頼 など |
| Reason | 判定理由 | 複数行テキスト(プレーン) | |
| SourceMessageId | 元メールID | 1行テキスト | **インデックスを作成**(重複防止) |
| MailSubject | 件名 | 1行テキスト | |
| MailFrom | 差出人 | 1行テキスト | |
| MailReceivedAt | 受信日時 | 日付と時刻 | |
| MailWebLink | メールを開く | 複数行テキスト(プレーン) | OutlookのURL(255文字を超えるため複数行) |

### 設定リスト `TaskuriSettings`(1ユーザー1行)

| 内部名 | 表示名 | 種類 | 備考 |
|---|---|---|---|
| Title | メールアドレス | 1行テキスト | 対象ユーザー |
| DisplayName | 表示名 | 1行テキスト | |
| Enabled | 有効 | はい/いいえ | 既定:はい |
| RunTime | 実行時刻 | 1行テキスト | 既定:07:30。**市民開発のGUIから変更する項目** |
| WeekdaysOnly | 平日のみ | はい/いいえ | 既定:はい |
| NameAliases | 呼ばれ方 | 複数行テキスト | 「山田さん、山田部長」など |
| MailAliases | 別アドレス | 複数行テキスト | 本人の別のメールアドレス |
| ExcludeSenders | 除外する送信者 | 複数行テキスト | 1行1件、部分一致(例:`noreply@`) |
| LastRunAt | 前回実行 | 日付と時刻 | 基盤が更新する。手で触らない |

実行時刻は15分単位で判定されます(7:40と設定した場合は7:45ごろに実行されます)。


## 検証モード(まず自分の30日分で試す)

Azure へのデプロイ、Exchange・SharePoint の権限設定をする前に、本人のアカウントで直近N日の受信メールを読み、
本番と同じ判定ロジックでタスク一覧を HTML レポートにします。SharePoint には何も書き込みません。

### 1回だけの準備:検証用のアプリ登録
1. Entra ID → アプリの登録 → 新規登録(名前:`Taskuri-Trial`、シングルテナント、リダイレクトURIなし)
2. 「認証」→「パブリック クライアント フローを許可する」を **はい**
3. 「API のアクセス許可」→ Microsoft Graph → **委任** → `Mail.Read` と `User.Read` を追加(必要なら管理者の同意)
4. 概要画面の「アプリケーション (クライアント) ID」を控える

委任権限なので、読めるのは**ログインした本人のメールだけ**です。

### 実行
```bash
npm install
az login                      # AOAI への接続に使う(Cognitive Services OpenAI User が必要)
export AZURE_TENANT_ID=<テナントID>
export TRIAL_CLIENT_ID=<Taskuri-Trial のクライアントID>
export AOAI_ENDPOINT=https://<your-aoai>.openai.azure.com/
export AOAI_DEPLOYMENT=<デプロイ名>
npm run trial -- --days 30 --aliases "山田さん,山田部長" --exclude "noreply@,newsletter"
```
表示されるコードを https://microsoft.com/devicelogin に入力してログインすると、判定が始まります。
終わると `taskuri-report.html`(と `.json`)ができます。

| オプション | 既定 | 内容 |
|---|---|---|
| `--days` | 30 | 何日前からの受信メールを読むか(1〜90) |
| `--max` | 1000 | 読む通数の上限 |
| `--aliases` | なし | 本文で呼ばれる名前(CCでの名指しの判定に使う) |
| `--exclude` | なし | 除外する送信者(部分一致) |
| `--out` | taskuri-report.html | 出力先 |

- 送信済みフォルダも読み、**受信後に本人が返信済みか**を判定材料にします(返信の冒頭から、完了か作業が残るかをAIが判断)。
- レポートは本人のメールから作るので、社外に共有しないでください(`.gitignore` で除外済み)。
- 1通ごとにAOAIを1回呼びます。目安として1,000通で数十分、モデル次第で数百円〜です。

## Azure 側の設定

### 1. Function App(AzureChat の App Service プラン `midac19-app-yhggrda5qr5ae` に同居)
- ホスティング:既存の App Service プラン(専用プラン)を選ぶ。プランと同じリージョン・OS(Linux)で作る
- ランタイム:Node.js 22 以上(Azure SDK の新しい版が Node 22 を前提にしている)、プログラミングモデル v4
- **Always On をオン**にする(専用プランでは、オフだとタイマーが止まる)
- ストレージアカウント(`AzureWebJobsStorage`)は別途必要
- **システム割り当てマネージドID** をオンにする
- SWA(Standard)の「API」→「リンクされたバックエンド」でこの Function App をリンクする(`/api` が転送される)
- アプリ設定に `local.settings.sample.json` の値を登録する(`AZURE_CLIENT_*` は不要)

### 2. AOAI
- AOAIリソースのアクセス制御(IAM)で、Function AppのマネージドIDに **Cognitive Services OpenAI User** を割り当てる
- デプロイは Structured Outputs(`json_schema`)に対応したモデルにする(gpt-4o 2024-08-06 以降、gpt-4.1 系など)
- o系やGPT-5系では `temperature` を指定できないので、`AOAI_TEMPERATURE` は空のままにする

### 3. Graph と SharePoint の権限(マネージドIDにアプリ権限を付与)
マネージドIDはポータルから API 権限を追加できないため、PowerShell で付与します。
アイテム単位の権限設定は SharePoint REST API で行うので、**Graph と SharePoint の両方**に `Sites.Selected` を付けます。

```powershell
Connect-MgGraph -Scopes "AppRoleAssignment.ReadWrite.All","Application.Read.All"
$mi = Get-MgServicePrincipal -Filter "displayName eq '<Function App名>'"
foreach ($apiAppId in @(
    "00000003-0000-0000-c000-000000000000",   # Microsoft Graph
    "00000003-0000-0ff1-ce00-000000000000")) { # Office 365 SharePoint Online
  $api  = Get-MgServicePrincipal -Filter "appId eq '$apiAppId'"
  $role = $api.AppRoles | Where-Object { $_.Value -eq "Sites.Selected" }
  New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $mi.Id -PrincipalId $mi.Id -ResourceId $api.Id -AppRoleId $role.Id
}
```

### 4. SharePoint:タスクリのデータ用サイトだけにフルコントロールを付与
アイテムの権限を変えるには「フルコントロール」が必要です(書き込み権限では足りません)。
付与するのはタスクリのデータ用サイトだけなので、他のサイトには一切アクセスできません。

```http
POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
{ "roles": ["fullcontrol"],
  "grantedToIdentities": [{ "application": { "id": "<マネージドIDのアプリID>", "displayName": "Taskuri" } }] }
```
サイトIDは `GET https://graph.microsoft.com/v1.0/sites/{tenant}.sharepoint.com:/sites/{サイト名}` で、リストIDは `GET .../sites/{site-id}/lists` で確認します。

### 5. メールの読み取り:対象者だけに絞る(Exchange の RBAC for Applications)
Entra で `Mail.Read` を付与すると全社員のメールが読める状態になります。
代わりに Exchange 側で、パイロットユーザーのグループだけに範囲を絞って付与します。

```powershell
Connect-ExchangeOnline
New-ServicePrincipal -AppId <マネージドIDのアプリID> -ObjectId <マネージドIDのオブジェクトID> -DisplayName "Taskuri"
New-ManagementScope -Name "Taskuri-Pilot" -RecipientRestrictionFilter "MemberOfGroup -eq '<パイロットグループの DistinguishedName>'"
New-ManagementRoleAssignment -App <マネージドIDのアプリID> -Role "Application Mail.Read" -CustomResourceScope "Taskuri-Pilot"
# 確認(対象外のユーザーで InScope=False になること)
Test-ServicePrincipalAuthorization -Identity <マネージドIDのアプリID> -Resource <ユーザーのアドレス>
```

> Entra 側で `Mail.Read` を付与しないでください。付与すると、Exchangeでの絞り込みとは関係なく全員分が読めてしまいます。

## 誰が何を見られるか(ステップ2)

| 層 | 仕組み | 結果 |
|---|---|---|
| ポータル | 市民開発ポータル(SharePointのコミュニケーションサイト)のクイックリンクで、対象グループにだけアイコンを表示 | タスクリの利用者にだけアイコンが見える |
| アプリ | Power Appsのアプリを `Taskuri-Users` グループにだけ共有 | 他の人は開けない |
| データ用サイト | タスクリ専用サイトのメンバーを `Taskuri-Users` だけにする | 他の人はリストにたどり着けない |
| タスク1件ずつ | 基盤が作成直後に継承を切り、本人に「投稿」を付与 | **自分のタスクは自分だけが見られる** |
| 設定の行 | 基盤が新しい行を見つけたら同じく本人だけに制限 | 自分の実行時刻だけ変えられる |

- グループは Entra ID の**メールが有効なセキュリティグループ**を1つ作り(例:`Taskuri-Users`)、
  サイトのメンバー、アプリの共有先、Exchange の読み取り範囲(手順5)のすべてにこのグループを使います。
- ポータルのクイックリンクの「対象ユーザー」は**表示の出し分けだけ**で、権限ではありません。
  実際に守っているのは、上の表のアプリ・サイト・アイテムの権限です。
- タスクの権限設定に失敗した場合は、他の人に見える状態で残らないよう、基盤がそのタスクを削除します。
- 設定リストに管理者が行を追加すると、次のタイマー実行(15分以内)で本人だけの権限になります。
  それまでの間は、データ用サイトのメンバー(`Taskuri-Users`)からその行が見えます。
- `TASKURI_GRANT_OWNERS=true`(既定)のとき、サイトの所有者グループにも各アイテムのフルコントロールを付けます。
  所有者はすべてのタスクを見られるので、所有者は管理者だけにしてください。
- 設定リストの `Title`(メールアドレス)列は、GUIで編集できないようにしてください。
- 1つのリストで個別の権限を持てるアイテム数には上限があります(推奨は数千件、上限は5万件)。
  完了済みの古いタスクを定期的に削除する処理を、次のステップで追加します。

## ローカルでの実行とテスト

```bash
npm install
npm test            # ロジックのテスト(Azureへの接続なし)
cp local.settings.sample.json local.settings.json   # 値を埋める
npm start           # Azure Functions Core Tools が必要
curl -X POST "http://localhost:7071/api/taskuri/run?user=you@example.com"
```

ローカルではマネージドIDが使えないため、テスト用のアプリ登録を使います。
SharePoint REST API はクライアントシークレットのトークンを受け付けないので、**証明書認証**にしてください
(`AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_CERTIFICATE_PATH` を設定すると `DefaultAzureCredential` が自動で使います)。

## 画面(GUI)
画面は市民開発基盤 `Midac-Holdings/citizen-dev-platform` の `apps/ai/taskuri/` にあります(今はサンプルデータで動く張りぼて)。
タスクの項目はこのリスト定義と同じなので、本番化では画面側の `src/tasks.ts` の読み込み・保存を、この基盤のAPIに差し替えます。

## まだ決めていないこと(次のステップ)
- 市民開発ポータルの置き場所(既存の備品アプリと同じポータルにアイコンを追加するか)
- リストの作成方法(手作業か、スクリプトで自動作成か)
- 完了済みタスクの保存期間(個別権限の件数上限への対策)
- 祝日の扱い(今は土日だけ除外)
