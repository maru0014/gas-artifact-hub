# ADR-006: 外部リンクの別タブ閲覧互換性のための `allow-popups-to-escape-sandbox` の採用

## ステータス
承認済み (Accepted)

## コンテキスト
GAS Artifact Hub のプレビュー画面（`Shell.html` 内の `iframe#artifact-sandbox`）に配置された外部リンクを別タブ（`target="_blank"` や `window.open`）で開いた際、遷移先のサイトが **Cross-Origin-Opener-Policy (COOP)**（例: `same-origin` 等）を返している場合に、ブラウザによって `ERR_BLOCKED_BY_RESPONSE` と判定されページが表示されない問題が発生した。

### 技術的原因
HTML Living Standard（ナビゲーション仕様）において、`allow-popups` のみでは新しく開かれたポップアップに対しても親 iframe の sandbox 制約（サンドボックスフラグセット）が自動的に継承される。この sandbox 制約が適用されたコンテキストへのナビゲーション時に、レスポンスヘッダーの COOP が `unsafe-none` 以外である場合、ブラウザ仕様に基づきナビゲーションがネットワークエラー（`ERR_BLOCKED_BY_RESPONSE`）として強制終了される。

## 検討した選択肢
- **案A: 現行維持（`allow-popups` のみ）**
  - 利点: 別タブに対しても sandbox 制約を強制し続けられる。
  - 欠点: 近年急速に普及した COOP を設定するモダンなホスティング環境（Cloudflare Pages、Vercel、GitHub Pages 等）や外部 Web サービスへのリンクがことごとくブロックされ、ツールのドキュメント参照や外部連携が実用不能になる。
- **案B: 親フレーム側でリンククリックを傍受し、親フレームから開く**
  - 欠点: `null` origin で動作する iframe 内の動的スクリプト（`window.open` 等）を完全に捕捉・検証することは難しく、親フレーム側で安全な URL 検証やメッセージ通信の複雑な仕組みを設ける必要があり、親フレームの攻撃対象面（Attack Surface）を不要に広げてしまう。
- **案C: iframe の `sandbox` 属性に `allow-popups-to-escape-sandbox` を追加する（採用）**
  - 利点: ブラウザ標準機能により、ポップアップへの sandbox 継承を解除して通常のトップレベルブラウジングコンテキストとして開く。COOP 衝突が解消される。親フレームの隔離（`null` origin、`allow-same-origin` 排除）はそのまま維持される。

## 決定事項
**案C（`allow-popups-to-escape-sandbox` の追加）を採用する。**
- `sandbox="allow-scripts allow-downloads allow-forms allow-popups allow-modals allow-popups-to-escape-sandbox"` を指定。
- **`allow-same-origin` は引き続き厳格に排除する**。

## 影響とトレードオフ
- **メリット**:
  - COOP が設定された外部サイトや社内ツールへのリンクが正常に別タブで表示可能になる。
  - 親フレーム（`Shell.html`）から見た iframe は引き続き `origin = "null"`（opaque origin）であり、`allow-same-origin` を付与しないため、親フレームの DOM や Google Workspace 認証セッションへの直接アクセスはブラウザの同一オリジンポリシーにより確実に遮断される。
- **デメリット・残存リスク（設計判断としての緩和受容）**:
  - 開かれた別タブは親 iframe の sandbox 制約を継承せず、遷移先自身のオリジンで通常の Web ページとして実行される。そのため、悪意ある HTML から開かれたページにおけるフィッシングや不審なダウンロードなどのリスクは、ブラウザ標準の保護機能（ポップアップブロッカー、Safe Browsing 等）に委ねられる。
  - 「Hub 本体のゼロトラスト隔離を最優先防衛線とし、外部リンクは通常の Web 閲覧として許可する」という製品方針のもとで本リスクを受容する。
