# Yurumeet の website を公開する

`site/` は Yurumeet の紹介ページです。アプリ本体の UI source は `src/` にあり、
Yurumeet の Worker build に同梱されます。site には build 手順がありません。

公開は、この repository の deploy entrypoint が持つ `yurumeet-site` surface から
行います。

```sh
bun run deploy -- yurumeet-site --environment=integration
bun run deploy -- yurumeet-site --environment=production
```

`integration` は今の作業ツリーをそのまま受け取ります (main 以外でも、未コミットでも
かまいません)。`production` は clean な main が、fetch し直した `origin/main` と
同じ commit であることを求めます。どちらの環境でも `bun run check:site` を 1 回だけ
実行し、`site/index.html` の SHA-256 を記録します。

upload のあとに、公開されたバイト列を読み直します。deployment ごとの immutable な
URL は常に、`production` ではさらに `https://yurumeet.com` も GET して、upload した
home page と同じバイト列が返ることを求めます。失敗したときは Wrangler に到達する
前 (`PRE_UPLOAD_FAILURE`) か、upload が始まったあと (`POST_UPLOAD_INDETERMINATE`)
かを必ず表示します。自動で retry も rollback もしません。

生の `wrangler pages deploy` に置き換えないでください。どのバイト列が出たのかを
記録せず、upload の失敗と readback の失敗を区別できないため、deploy が負う義務を
何も果たせません。共通の義務は sibling の `takos-control` にある
`engineering.policy.json` → `deploy` が正本 (正とする情報) です。

利用者が自分の infrastructure に複製を置くことはできます。ただしそれは利用者自身の
credential・承認・復旧方針のもとで行う deployment であり、公式の release では
ありません。

## 公開先

Pages project は `yurumeet-website`、custom domain は `yurumeet.com` と
`www.yurumeet.com` です。

```text
CNAME  yurumeet.com (@) -> yurumeet-website.pages.dev
CNAME  www.yurumeet.com -> yurumeet-website.pages.dev
```

domain と DNS の変更は operator が所有する作成作業であり、release 手順では
ありません。

## この site に置かないもの

この site は製品紹介だけを扱います。アプリの UI source は `src/`、runtime API の
配線は同一 origin の Worker packaging・discovery metadata・OpenTofu Output が
持ちます。

中央でホストするアプリの subdomain runtime をここから配信しません。Yurumeet は
利用者の Takosumi install・Cloudflare deployment・self-host runtime で動く
ソフトウェアです。self-host する場合は `bun run build:takos-worker` で Worker を
build し、選んだ origin から UI と API を配信します。
