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

Yurumeet のブランドロゴは `public/yurumeet-logo.png` を配信用の正本とし、
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

distribution artifact を公開するときは、この repository の entrypoint を使います
(まだ存在しないので、作るのが次の作業です)。共通 rule は sibling `takos-control` の
`engineering.policy.json` → `deploy` が正本です。

```sh
bun run deploy
```

`prepare` は read-only です。adapter が未登録なら fail closed のままにし、
raw Worker deploy や migration へ fallback しません。

Worker compatibility date / flags の正本も `wrangler.jsonc` です。root module が
このファイルを `jsondecode` するため、JSONC 拡張のコメントや trailing comma は追加せず、
strict JSON として維持します。D1 migration ledger は core と同じ `yurucommu_migrations`、
retention schedule は毎時です。`deploy/takoform/` は compatibility を宣言しません。
どの runtime で動かすかは host の決定であり、portable module が宣言するのは
Worker が export する handler だけです。

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

両 module が公開する runtime URL は、通常の OpenTofu Output である `launch_url` と `api_url`
です。`takosumi_release` / `app_deployment` / `service_exports` / `service_bindings`
のような予約 Output を runtime 宣言や lifecycle authority として使いません。

`outputs.tf` が公開するruntime URLは、通常のOpenTofu Outputである `launch_url` と `api_url` です。
そのほかのOutputはCloudflare providerが作成したresourceの運用値です。Takosumi上のlauncher Interfaceは
service-side InstallConfigが `launch_url` を明示mappingし、D1 migrationも同じInstallConfigのlifecycle actionが
実行します。`takosumi_release` / `app_deployment` / `service_exports` / `service_bindings` のような
予約Outputをmoduleのruntime宣言やlifecycle authorityとして使いません。

Yurumeet は中央でホストされるアプリではなく、自分で動かすソフトウェアです。
`https://yurumeet.com` は `site` にある製品紹介・ランディングサイトにすぎず、
インストールされた実行環境ではありません。

ランディングサイトの deploy 手順は [`site/DEPLOY.md`](site/DEPLOY.md) にあります。

## ブラウザ通知

ブラウザ通知は設定画面から明示的に有効化します。ページを開いただけでは通知権限を要求しません。
通知には DM やコミュニティメッセージの本文を載せず、service worker は通知を受けたあと Yurumeet を開きます。

OpenTofu で Worker を作る場合は、次の 3 変数を設定します。

- `notification_push_gateway_url` — stateless push gateway の公開 HTTPS notify endpoint
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
