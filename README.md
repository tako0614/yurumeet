# Yurumeet

English: [README.en.md](README.en.md)

Yurumeet は、LINE のようにトーク中心で使える、yurucommu family のメッセージングアプリです。
自分のサーバーで動かして、同じ yurucommu アカウントをトーク主体の UI で使えます。
`yurume` は server discovery・push 登録・build script で使う短い client id です。

Yurumeet は yurucommu product set の中の、差し替え可能なトーク中心 UI です。
`@takosjp/yurucommu-core` が提供するアカウント・actor・DM・コミュニティ・メディア・通知・
ActivityPub identity のエンジンをそのまま組み込んでいます。

## できること

- 同じ yurucommu アカウントとサーバー API を、トーク中心の UI で使えます
- DM・コミュニティチャット・タイムライン・ストーリー・通知・検索・プロフィールにアクセスできます
- 1 つの fullstack Worker が API と UI を同一 origin で提供します
- Cloudflareへ直接デプロイするか、plain OpenTofu moduleとしてTakosumiからインストールできます

## 始め方 (開発)

```sh
bun run dev
bun run dev:mock
```

Vite がクライアントを `http://localhost:5174` で配信し、`/api` と `/.well-known` を
`http://localhost:8787` に proxy します。

`bun run dev:mock` は、Yurumeet と in-memory の yurucommu 互換 mock API を一緒に起動します。
mock は Yurucommu と同じ `/api/auth/me` / `/api/auth/login` のパスワード認証の形を使い、
トークの連絡先・コミュニティチャット・タイムライン・ストーリー・通知・検索・プロフィールの
データを UI 開発用に返します。8787 が使用中の場合、script が自動的に次の空きポートを mock API に
割り当て、Vite の proxy 先も更新します。

型チェックは `bun run check`、lint は `bun run lint` を使います（内部で同じ `tsc --noEmit`
を実行します）。

`bun run check` は format・型・テスト・portable build と artifact smoke を通す
repo の完全な検証入口です。追加のブラウザ検証には、インストール済みの Chrome と
`bun run check` が生成した Worker を使います。
artifact・browser smoke は Miniflare を Node で動かすため、`bun run check` にも Node.js
24.21.0 を使います。CI も同じバージョンを使います。Bun は install・型チェック・テスト・build
に使います。

```sh
bun run smoke:release-browser -- dist/takos-worker.js
```

Chrome の場所は `BROWSER_SMOKE_CHROME` で指定できます。ブラウザは自動取得せず、
未インストール時は失敗します。CI は完全な `check` の後でこの検証も必須実行します。
使い捨てのローカル HTTP と native bindings 上で、実際のフォームによる認証失敗・再入力・
ログイン後の永続 session と、合成した通信相手への実画面からの DM・画像/動画添付・
サーバー到達前の中断からの再送を確認し、DB・ObjectBucket の保存内容と照合します。
保存後に応答だけ失う場合も確認し、画面は送達未確定と再送による重複の可能性を説明します。
現行 Core/API はこの場合の重複防止を保証しません。「表示を消す」はローカルの未確定表示を
消す操作で、保存済みメッセージの削除ではありません。
送信前のテキスト下書きは接続先・アカウント・会話ごとに保存します。保存や読み取りに
失敗した入力は同じ画面の会話切替では保持し、警告と保存の再試行・入力の選択を表示します。
保存済みの内容が変わっていた場合は上書きせず、明示的に読み込めます。未保存の入力は
再読込・終了で失われる場合があり、端末をまたぐ配送や複数タブ間の原子的な更新は保証しません。
著者を特定できない旧形式の下書きは削除せず、自動では読み込みません。
通信相手の fixture は初回ログインの確認後に追加します。公開環境の TLS、OIDC、
他サーバーとの通信、更新・復旧の証拠は別途必要です。

artifact smoke は、同じ現行 Worker の native D1/KV/R2 を閉じて複製し、
全ファイルの path・size・SHA を照合してから復元先を開きます。元の cookie、
schema/data、投稿・media bytes、Core の KV origin pin と元 snapshot の不変性を
検証します。使い捨ての fixture に対する同一 artifact の復元であり、公開旧版からの
更新、実環境の backup・Secret 保全・OIDC 復旧は別の証拠が必要です。

## 仕組み

### Runtime API

同梱の fullstack Worker は、既定で API と UI を同じ origin から配信します。Yurumeet は
トーク中心の UI を通じて、同じ yurucommu のアカウントと API を開きます。開発ビルドでは、
次の優先順で API の origin を上書きできます。

1. `?server=https://your-yurucommu.example`
2. `VITE_YURUME_SERVER_URL` at build time
3. `localStorage["yurumeet.serverOrigin"]`
4. same-origin fallback

この上書きは、ローカルでの UI 作業と特殊な self-host 構成のための経路です。通常のパッケージングでは
Yurumeet と yurucommu 互換 API は一緒に動かします。

クライアントが別 origin で動く場合、サーバー側の CORS / CSRF 設定で Yurumeet の origin を
許可する必要があります。例:

```text
CSRF_ALLOWED_ORIGINS=https://talk.your-yurucommu.example
```

### UI のベース

トーク画面は `Myoko1110/TakosUI` の `talk.html` と `stylesheet.css` をベースにしています。
`p-talk` / `c-talk-*` の DOM 構造、吹き出しのしっぽの asset、クリップボタン、78px のサイドバー、
モバイルのスライド挙動は、このベースからずらさないでください。

コピーした TakosUI の静的 asset の置き場所:

- `src/assets/takosui/` — Yurumeet アプリ用
- `site/assets/takosui/` — product website の mock 用

Yurumeet のブランドロゴは `public/yurumeet-logo.png` を配信用の正本 (正とする情報) とし、
アプリbundle用の `src/assets/yurumeet-logo.png` と product website用の
`site/assets/yurumeet-logo.png` を同一内容に保ちます。`bun run check` は3つの
PNGが一致することも検証します。

## ビルドとデプロイ

```sh
bun run build
bun run build:takos-worker
```

production のクライアントビルドは `dist/` に出力されます。`bun run build:takos-worker` は
その asset を core backend と一緒に `dist/takos-worker.js` に埋め込みます。

Yurumeet は direct Cloudflare module と portable Takoform Capsule
の両方を所有します。ただし公開状態は同じではありません。Cloudflare
self-host は現在利用でき、Takosumi 管理付き導入は実環境の作成・rollback・destroy
証跡がそろうまで公開導線を閉じています。

### Cloudflare への self-host

これは利用者またはその operator が所有する deployment であり、私たちが運営する
公式 release target ではありません。`wrangler.jsonc` と root OpenTofu module が
direct Cloudflare path を定義しますが、credential、承認、migration、rollback は
利用者側の runbook と authority で管理してください。

root OpenTofu module で Worker を公開するときは、機密入力
`session_hash_salt` が必須です。値をそのまま `YURUCOMMU_SESSION_HASH_SALT`
Secret に渡し、汎用 `env` の同名キーは拒否します。新規環境では安全な場所で
`openssl rand -hex 32` などにより生成し、既存環境の更新では現在の値を保持して
ください。salt を変えると session の照合が変わり、再ログインが必要になり得ます。
Takosumi の direct install へ渡す sealed 入力経路は未検証で、通常の入力欄に秘密値を
書いて代用しません。Wrangler を使う self-host でも同名の Worker Secret が必要です。

Worker は未設定・空白だけの salt と公開された開発用 fallback を、Core の処理前に
拒否します。受け入れた値は正規化しません。code-only の公開入口は
`YURUMEET_WRANGLER_CONFIG` で選んだ実環境の strict JSON config の root
`secrets.required` に `YURUCOMMU_SESSION_HASH_SALT` が一つ含まれることを、
gate・D1 確認・公開の前に要求します。同名の plaintext `vars` は拒否します。
公開入口は実配信 Version の必須 Secret metadata を確認し、全 binding をその Version ID
から明示的に継承します。metadata は秘密の実値・エントロピー・custody を証明しません。

repo の `wrangler.jsonc` は開発用の template のため、全環境共通の必須 Secret 一覧を
追加しません。Wrangler は一覧を定義するとローカルの秘密入力もその一覧だけに限定します。
公開用 config の一覧には、salt と暗号化キーに加え、選択した認証方式の Secret 名を
明示してください。password を使う場合は `AUTH_PASSWORD_HASH`、OIDC-only の場合は
その方式で必要な名前を含め、password を必須にしません。秘密値は config に書きません。
初めて salt を追加する既存環境では、credential owner の別途レビュー済み手順で
Secret を設定し、その環境の password または OIDC による再認証を確認してください。
暗号化キー・既存データを保持し、新しい salt は更新と code rollback でも保持します。
旧 session を変換・削除して再認証を回避しません。ローカル検証と公開環境の保持確認は別です。

repo の `bun run deploy -- yurumeet-worker` は maintainer の既存 Worker 更新入口です。
公開用 strict JSON config は root `name: "yurumeet"` と小文字32桁の hex `account_id`
を明示します。任意の名前で self-host する利用者の deploy は、その利用者の runbook に
従います。この入口は parent の `CLOUDFLARE_ENV` と非標準 API endpoint を拒否し、
全 Wrangler 呼び出しに空の `scripts/worker-publish-empty.env.example` を渡します。
repo の `.env` / `.env.local` から公開対象や認証を暗黙に選ばず、認証は operator が
親プロセスへ渡す設定または既存の Wrangler 認証を使います。空ファイルへの追記は拒否します。

更新前の実配信 Deployment ID と全 version/percentage を捕捉します。Secret の実値は
metadata から比較できないため、一つの Version が100%配信されている場合だけ更新でき、
split 配信は gate・公開前に拒否します。config の binding 名、明示した DB/KV/R2 の
識別子・jurisdiction、Queue producer・変数・runtime 設定が実配信 metadata と違う場合も
拒否します。任意の KV/R2 識別子を省略した場合は実配信 Version を正本とします。
未配信の新しい Version を継承元にしません。

Wrangler は `auth token --json` で既存認証を読むためだけに使い、その出力を保存・表示
しません。code は固定 Cloudflare API の Version upload と Deployment promotion で
差し替え、Secret・resource・Queue consumer・Cron・route・settings を書き換えません。
全 binding は `version_id` を固定した strict inheritance です。正確な Version のコードを
再取得して成果物 SHA256 と比較し、non-code closure と設定も公開前後・smoke後に再確認します。
content read の Version query は固定 Wrangler source に基づき、live API の確認とは別です。

結果と失敗診断には元の全配信割合を戻す、credential を含まない手動 Deployment API request
を残します。Wrangler の rollback command は設定も変更し得るため使いません。応答を失った
write は不確定として扱い、自動再試行・rollback はしません。再確認は原子的な条件付き更新
ではないため、operator は同じ対象の更新を直列に実行してください。実環境の Secret 保全・
復旧・公開後の利用者経路は source/mock 検証とは別です。

root `main.tf` の機密入力 `auth_password_hash` は、正規の PBKDF2 hash または
bootstrap token を `AUTH_PASSWORD_HASH` Secret に渡します。非空値は OpenTofu が
受け取った文字列のまま渡し、空値・HCL または Core が空白だけと判定する値は省略します。
省略する場合は、完全な OIDC 設定が必要です。PBKDF2 hash の端に空白がある値は
plan で拒否します。hash が bootstrap token として扱われるのを防ぐため、
正規の空白なし hash を明示してください。

以前の adapter は端の空白を除いていました。既存の bootstrap 設定に端の空白が
ある場合、この変更を Apply すると資格情報が変わります。現在の資格情報を保持するなら、
以前の adapter が渡した空白なしの値を機密入力へ明示し、公開・ログ出力せずに確認して
ください。OpenTofu の文字列は NFC 正規化されるため、合成形式に依存する任意の
Unicode token の元バイト列保持は保証しません。新規 bootstrap token には安全に生成した
ASCII 値を使い、既存値がこの文字列経路で変わる場合は credential owner の手順で
対応してください。

Worker compatibility date / flags の正本も `wrangler.jsonc` です。root の
`main.tf` がこのファイルを `jsondecode` するため、JSONC 拡張のコメントや trailing
comma は追加せず、strict JSON として維持します。D1 の migration 記録は core と同じ
`yurucommu_migrations` を共有し、retention は毎時走ります。`deploy/takoform/` は
compatibility を宣言しません。どの runtime で動かすかは host の決定であり、portable
module が宣言するのは Worker が export する handler だけです。

### 公式に publish する 3 つの surface

この repository が公式に publish するものは 3 つで、入口は deploy entrypoint 1 つ
です。共通 rule は sibling `takos-control` の `engineering.policy.json` → `deploy`
が正本です。

```sh
bun run deploy -- yurumeet-worker
bun run deploy -- yurumeet-worker-release [--dry-run|--execute]
bun run deploy -- yurumeet-site --environment=integration|production
```

`bun run deploy -- --contract` は副作用なしで、各 surface が何を publish し、
どの義務をどう果たすかを JSON で答えます。

`yurumeet-worker-release` だけが、利用者が pin する identity を作ります。tag は
`package.json` の version から 1 つだけ導き、既存の tag や Release があれば作成前に
安全側に停止します。`package.json`・root module の tag 既定値・追記のみの
`release.lock.json`・`.well-known/takosumi.json`・`deploy/takoform/` の source build
が同じ release を指していないときも、publish を始める前に止めます。この整合は
`bun run check` でも毎回検査します。

`yurumeet-worker` は公開前に、`YURUMEET_WRANGLER_CONFIG` の実現済み strict JSON
config と実配信 Version の DB が一致することを確認し、その Version の実 DB ID の
metadata を既存認証による read-only REST query で読み取ります。
Core 4.1.11 の追加 migration `0030` が必要とする media deletion table の column・
primary key・due index を検査し、不足・不整合・読取拒否・不正な応答なら公開を止めます。
schema 全体や migration 台帳を検証するものではなく、schema 適用や権限追加は行いません。
`CLOUDFLARE_ENV` による環境選択は未対応として拒否し、検査後に config の内容が
変わった場合も公開を止めます。
root の direct Cloudflare module の Apply はこの検査の対象外で、別途レビュー済みの
schema 適用証拠が必要です。portable module は schema 適用後に Worker を更新します。

どの surface も、raw な Worker deploy や migration へ fallback しません。永続 store
(D1 DB / KV / R2 MEDIA) を変更しません。site の公開手順は
[`site/DEPLOY.md`](site/DEPLOY.md) にあります。

### Takosumi 管理付き導入（公開検証前）

管理付き導入の正本は `deploy/takoform/` の portable resource graph です。公開リンクはまだ提供せず、
この module を含む固定リリースと host conformance の証跡がそろってから有効化します。

`.well-known/takosumi.json` は `takosumi.com/v2.4` で、この repository が持つ 2 つの module —
root の direct Cloudflare module と `deploy/takoform/` — を両方 declare します。宣言することと
提供することは別の行為です。宣言があっても、証跡がそろうまで公開 CTA は閉じたままにします。

`deploy/takoform` の install は installer に何も secret を尋ねません。host が
`ENCRYPTION_KEY` を生成し、Accounts OIDC の issuer / client / owner subject / redirect URI を
runtime binding として渡します。manifest が持つのは slot の名前だけで、値は持ちません。

```json
{
  "url": "https://github.com/tako0614/yurumeet.git",
  "ref": "<verified-release-tag>",
  "path": "deploy/takoform"
}
```

この経路では Takosumi が Plan・Apply・StateVersion・Output・Audit を管理します。
root `main.tf` は direct Cloudflare module であり、管理付き導入の CTA から選びません。

両 module が公開する runtime URL は、通常の OpenTofu Output である `launch_url` と
`api_url` です。root module の残りの Output は、Cloudflare provider が作成した
resource の運用値です。Takosumi 側では service-side InstallConfig が `launch_url` を
launcher Interface へ明示的に mapping し、D1 migration も同じ InstallConfig の
lifecycle action が実行します。`takosumi_release` / `app_deployment` /
`service_exports` / `service_bindings` のような予約 Output を、runtime 宣言や
lifecycle authority として使いません。

Yurumeet は中央でホストされるアプリではなく、自分で動かすソフトウェアです。
`https://yurumeet.com` は `site` にある製品紹介・ランディングサイトにすぎず、
インストールされた実行環境ではありません。

## ブラウザ通知

ブラウザ通知は設定画面から明示的に有効化します。ページを開いただけでは通知権限を要求しません。
通知には DM やコミュニティメッセージの本文を載せず、service worker は通知を受けたあと Yurumeet を開きます。

OpenTofu で Worker を作る場合は、次の 3 変数を設定します。

- `notification_push_gateway_url` — 状態を持たない push gateway の公開 HTTPS notify endpoint
- `notification_push_gateway_token` — Worker だけが gateway 呼び出しに使う secret bearer
- `notification_push_web_push_public_key` — gateway の公開 VAPID key（秘密値ではありません）

gateway URL と公開 VAPID key は必ず一緒に設定します。対応する VAPID private key は gateway 側だけに置き、
Yurumeet の DB・browser・OpenTofu Output には保存しません。ローカルの UI 開発で runtime API がまだない場合だけ、
`VITE_YURUME_NOTIFICATION_PUSH_GATEWAY_URL` と `VITE_YURUME_WEB_PUSH_PUBLIC_KEY` を build-time fallback
として利用できます。

## 開発者向けの注意

型付きの共有 API は `@takosjp/yurucommu-api`、サーバーエンジンは
`@takosjp/yurucommu-core/server` を通じて読み込みます。未公開の `yurucommu-core` の
source path を import してはいけません。
