# テストの範囲と実行方法

開発環境は Node.js 22 以上を使います。利用者のブラウザと GAS 本番環境に Node.js や Playwright は不要です。

```sh
npm ci
npm run check
npm test
npm run check:public
npx playwright install chromium
npm run test:e2e
```

`npm run check` は `src/` の本番 `.gs` と、GAS include を展開した本番 HTML 内のインライン JavaScript を `vm.Script` で構文検査します。閉じていない script タグ、外部 script、未対応の script type、展開できない GAS scriptlet は成功扱いにしません。GAS サービスは起動しません。

`npm test` は GAS サービスを置き換える最小ランタイムで、本番の `.gs` と HTML のロジックを検査します。Sheets・Drive・本人認証の実サービス接続は行いません。

`npm run check:public` は、Git の追跡済みファイルと ignore されていない新規ファイルを対象に、公開不要ファイル名と既知の資格情報形式を検出します。値は出力しません。ローカルの `.clasp.json` が存在するだけでは失敗しません。この検査は Git 履歴、未知の秘密形式、文書の公開可否まで保証するものではありません。

## ローカル E2E

`npm run test:e2e` は `tools/e2e/server.js` を `127.0.0.1:4173` だけで起動します。サーバーは実際の `src/Upload.html`、`src/Shell.html`、各 include HTML を `tools/html-template.js` で展開します。本番 UI のコピーは使用しません。

GAS RPC の境界だけは `tools/e2e/rpc-stub.js` が `google.script.run` として置換します。スタブは遅延、業務エラー、通信エラー、ACL、投稿データをシナリオごとに独立して再現します。外部ネットワークは Playwright のルーティングで遮断し、認証済みブラウザプロファイルや実データは使いません。

現在の E2E は、初期遅延、検索、375px 幅、ブラウザストレージ拒否、ファイル読込競合、更新ドロワーの D&D、ACL取得・保存失敗、同意前後の sandbox、親 DOM へのアクセス拒否、文字列としてのソース表示、固定 URL を確認します。スクリーンショットと trace は `test-results/` に出力され、Git には含めません。

## 実環境で別途確認すること

ローカル試験は以下を検証しません。導入先 Workspace の一般利用者アカウントで [受入試験](acceptance.md) を実施してください。

- GAS の本人認証、組織ドメイン判定、OAuth 同意
- Sheets と Drive の実データ保存、権限、クォータ、障害時の挙動
- GAS Web アプリの二重 iframe と組織ポリシー下でのブラウザ挙動
- 実際の `/exec` URL、デプロイ更新、導入先ネットワーク制限
