# ADR-002: `iframe.srcdoc`（null origin）によるゼロトラスト隔離の採用

## ステータス
承認済み (Accepted)

## コンテキスト
ユーザーが投稿した任意の単一HTMLをブラウザ上で実行する際、以下の重大な課題・リスクが存在した：
1. **Google Workspace 認証情報の漏洩リスク**:
   親フレーム（GAS Webアプリ）と同じオリジンでスクリプトが動くと、`document.cookie` やOAuthトークンをツール内スクリプトから盗み出される危険がある。
2. **ブラウザのサードパーティCookie規制（CHIPS / Partitioned Cookies）**:
   別ドメインや別URLのGASを `iframe.src="https://script.google.com/..."` で埋め込もうとすると、Chrome等の主要ブラウザが認証Cookieを拒否し、Googleログイン画面が表示されたり接続エラーになる。
3. **`X-Frame-Options` による拒否**:
   Google Driveや外部URLのHTMLは `X-Frame-Options: SAMEORIGIN` や `DENY` により `iframe` 埋め込みがブロックされる。

## 検討した選択肢
- **案A: サブドメインを別取得して配信する（独立Webサーバー）**
  - セキュリティ境界は作れるが、外部サーバーやDNS設定が必要となり「GAS単一完結」の要件を満たせない。
- **案B: `iframe.src="https://script.google.com/..."` によるネスト呼出し**
  - サードパーティCookie規制および `X-Frame-Options` で安定描画ができない。
- **案C: 親フレーム（Shell）から `iframe.srcdoc` への文字列注入 ＋ `sandbox` 制限（採用）**
  - 親フレームがサーバーからHTML実体を取得し、JavaScriptで `iframe.srcdoc = rawHtml` として直接注入する。

## 決定事項
**案C（`iframe.srcdoc` 注入 ＋ 厳格な `sandbox` 属性）を採用する。**
- `sandbox="allow-scripts allow-downloads allow-forms allow-popups allow-modals allow-popups-to-escape-sandbox"` を指定（※外部リンクの別タブ閲覧時のCOOP互換性のため ADR-006 にて `allow-popups-to-escape-sandbox` を追加）。
- **`allow-same-origin` は絶対に付与しない**。

## 影響とトレードオフ
- **メリット**:
  - `sandbox` 属性に `allow-same-origin` を含めないことで、描画されたドキュメントはブラウザによって **`origin = "null"`（opaque origin）** として扱われる（`srcdoc` 自体が原因ではなく、`allow-same-origin` を含めない `sandbox` 指定が原因）。これにより親フレームやGoogleアカウントの認証情報への読み書きがブラウザのオリジン分離によりブロックされる。
  - `iframe.src` での別オリジン埋め込みと異なり、Cookie送信や `X-Frame-Options` 制約を経由しないため、サードパーティCookie規制に起因する接続エラーは発生しない。
- **デメリット・留意点**:
  - `null` origin であるため、ツール内スクリプトが同一オリジンのLocalStorageにデータを永続化しようとするとブラウザによって制限される場合がある（※ツールの性質上、セッション単位の利用や独自ダウンロード機能でカバー）。
  - サンドボックス隔離は既知のブラウザ実装に依存する防御であり、ブラウザの脆弱性や設定ミスまで保証するものではない。他の防御層（静的検査・同意フロー）と併用する前提である。
