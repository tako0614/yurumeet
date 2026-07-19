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

Yurumeetには対等な2つの導入方法があります。

### Cloudflareへ直接デプロイ

[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/tako0614/yurumeet)
を使うか、CloudflareへログインしたCLIからデプロイできます。

```sh
bunx wrangler d1 create yurumeet-db
bunx wrangler queues create yurumeet-delivery
bunx wrangler queues create yurumeet-delivery-dlq
bunx wrangler secret put ENCRYPTION_KEY
bunx wrangler secret put AUTH_PASSWORD_HASH
bun run deploy
```

`wrangler.jsonc`が直接デプロイの正本です。`bun run deploy`はfullstack Workerをビルドし、
共有coreのD1 migrationを適用してから`wrangler deploy`を実行します。CloudflareのDeployボタンでは
D1・KV・R2・Queuesもセットアップされます。

### Takosumiでインストール

この repo は、通常の plain OpenTofu module として Takosumi からインストールできます。

```json
{
  "url": "https://github.com/tako0614/yurumeet.git",
  "ref": "main",
  "path": "."
}
```

OpenTofuはTakosumiがPlan・Apply・StateVersion・Output・Auditを管理する経路で使います。
Cloudflareへ直接デプロイするだけならOpenTofuは必要ありません。

`outputs.tf` が公開するruntime URLは、通常のOpenTofu Outputである `launch_url` と `api_url` です。
そのほかのOutputはCloudflare providerが作成したresourceの運用値です。Takosumi上のlauncher Interfaceは
service-side InstallConfigが `launch_url` を明示mappingし、D1 migrationも同じInstallConfigのlifecycle actionが
実行します。`takosumi_release` / `app_deployment` / `service_exports` / `service_bindings` のような
予約Outputをmoduleのruntime宣言やlifecycle authorityとして使いません。

[`install-options.json`](install-options.json) は、現在実行可能な Cloudflare OpenTofu module を選ぶための任意の
`CapsuleSourceOptions` 表示ドキュメントです。Takosumi 専用 manifest ではなく、通常の Git URL + module path での
直接インストールには不要です。この文書は、それを含む次の通常の安定版タグから利用できます。別クラウドの選択肢は、
対応する実在 module を出荷したときだけ追加します。

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
