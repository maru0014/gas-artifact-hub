# セキュリティモデル仕様書 (Security Architecture & Threat Model)

## 1. セキュリティの基本原則（ゼロトラスト・サンドボックス）

GAS Artifact Hub は、社内ユーザーが投稿した任意のHTML/JavaScriptを実行するため、**「投稿されたコードは常に敵対的（Hostile）である可能性がある」** というゼロトラスト原則に基づいて設計されています。

---

## 2. ブラウザ隔離アーキテクチャ

### 2.1 `iframe.srcdoc` と `null` origin 隔離
- **仕組み**:
  親画面（Artifact Shell）から `iframe.srcdoc = htmlPayload` としてHTMLを直接流し込みます。
- **セキュリティ境界**:
  `srcdoc` 自体は同一オリジン扱いを妨げません。`null`（opaque）origin になるのは、`sandbox` 属性を付与し、かつその属性値に `allow-same-origin` を含めない場合です。本システムは次節の `sandbox` 属性（`allow-same-origin` なし）によって opaque origin を強制しており、`srcdoc` はそのための注入手段にすぎません。
- **防御効果**:
  1. **Google Workspace 認証情報の保護**:
     親フレームが持つGoogleアカウントのCookie、OAuthトークン、SessionStorageにiframe内スクリプトから一切アクセスできません（SOP: Same-Origin Policyにより完全遮断）。
  2. **親ウィンドウのDOM改ざん防止**:
     `window.parent` や `window.top` のDOM、スクリプト実行コンテキストに対する読み取り・操作をブラウザがブロックします。

### 2.2 `sandbox` 属性の厳格な最小権限化
```html
<iframe
  id="sandboxFrame"
  class="sandbox-iframe"
  sandbox="allow-scripts allow-downloads allow-forms allow-popups allow-modals allow-popups-to-escape-sandbox">
</iframe>
```

| ディレクティブ | 付与の有無 | 理由・セキュリティ影響 |
| :--- | :---: | :--- |
| `allow-scripts` | **付与** | 単一HTMLツール内のUI・計算ロジック実行に必須。 |
| `allow-forms` | **付与** | フォーム入力、検索・計算ボタンの送信処理に必須。 |
| `allow-downloads` | **付与** | CSV出力、画像保存などのデータエクスポートに必須。 |
| `allow-popups` | **付与** | 別タブでのヘルプ参照、Google Driveリンクの起動に必要。 |
| `allow-popups-to-escape-sandbox` | **付与** | 外部リンクを別タブ（`target="_blank"` 等）で開いた際の COOP（Cross-Origin-Opener-Policy）衝突による `ERR_BLOCKED_BY_RESPONSE` を回避するために付与。別タブは親の sandbox を継承せず独立したトップレベルコンテキスト（通常の Web 閲覧モデル）で開かれる。親フレームの opaque origin 隔離には影響を与えない（詳細は [ADR-006](../adr/ADR-006-allow-popups-to-escape-sandbox.md) 参照）。 |
| `allow-modals` | **付与** | `alert()`, `confirm()` 等のダイアログ表示に必要。 |
| `allow-same-origin` | 🚨 **厳格に排除** | **絶対に付与してはならない**。付与すると親フレームと同一オリジンになり、親のDOMやGoogle認証情報へ不正アクセス可能になるため。 |
| `allow-top-navigation` | 🚨 **厳格に排除** | 親ウィンドウのURLを悪意あるフィッシングサイトへ強制リダイレクトさせる攻撃を防ぐため。 |

---

## 3. 静的解析スキャナー仕様 (`Scanner.gs`)

### 3.1 検査の目的と位置づけ
静的解析スキャナーは、**完全な安全性を保証するガードレールではなく、透明性（Source確認）と初回同意（Consent）を促すための補助判定** として機能します。
- スキャン結果は `versions` シートの `warnings_json` 列にJSON形式で永続化。
- リスク未検出時は警告件数0件。
- 検出項目がある場合は、ビューアのセキュリティバッジや初回同意ダイアログで利用者に明示。

### 3.2 タグ属性トークナイザと正規表現ルール
R1対応後の実装では、外部URL属性（`TAG_EXTERNAL_URL_ATTR`）を、HTMLを左から右へ一度だけたどる単方向のタグ属性トークナイザで検査します。引用符を考慮してタグ境界と実属性を判定し、属性値の中にある `src=` 等を属性として誤認しないようにしています。未閉鎖タグは入力末尾までを同じタグ区間として扱い、同じ残り文字列を繰り返し探索しません。

`fetch`、`XMLHttpRequest`、CSS、ポップアップ、ストレージ、動的実行など他のルールは、HTML全文に対する正規表現で検査し、改行・空白を許容する箇所では `\s*` 等を用います。行番号は検知位置から逆算して警告表示用に付与します。どちらも補助的な静的検査であり、安全性や性能を保証するものではありません。

#### ① 5大脅威カテゴリ（ルール名は実コードと同期させること。以下は概要のみで、詳細は必ず `src/Scanner.gs` / `tools/scanner-rules.js` を参照する）
| カテゴリ | 検出対象・脅威シナリオ | 主な検知ルール（`src/Scanner.gs` のルール名） |
| :--- | :--- | :--- |
| **`NETWORK`** | 外部サーバーへのデータ持ち出し・通信 | `NETWORK_FETCH`, `NETWORK_XHR`, `NETWORK_SENDBEACON`, `NETWORK_EVENTSOURCE`, `NETWORK_WEBSOCKET`, `NETWORK_WORKER`, `NETWORK_WEBRTC` |
| **`EXTERNAL_TAG`** | 外部CDNや未承認ドメインからのスクリプト/スタイル読み込み | `TAG_BASE`, `TAG_META_REFRESH`, `TAG_EXTERNAL_URL_ATTR`（改行耐性付き属性スキャン）, `CSS_IMPORT_EXTERNAL`, `CSS_URL_EXTERNAL` |
| **`POPUP`** | 新規ウィンドウ展開・強制遷移によるフィッシングリスク | `POPUP_WINDOW_OPEN`, `POPUP_TARGET_BLANK`, `NAV_LOCATION_ASSIGN` |
| **`STORAGE`** | ブラウザ内ストレージへのアクセス | `STORAGE_LOCAL`, `STORAGE_SESSION`, `STORAGE_INDEXEDDB`（`document.cookie` を検知する専用ルールは無い） |
| **`DYNAMIC_EVAL`** | 動的文字列からのコード生成 | `EVAL_EXEC`, `NEW_FUNCTION`, `DYNAMIC_IMPORT`（文字列を渡す `setTimeout` / `setInterval` を検知する専用ルールは無い） |

このカテゴリ・ルール名の対応表は実コードと乖離しやすいため、変更時は `tools/scanner.test.js`（`Scanner.gs` と `tools/scanner-rules.js` の定義一致を検証するテスト）が通ることで整合性を確認すること。ここに疑似コードの正規表現例は掲載しない（掲載すると実装更新時に必ず乖離するため）。実際のパターンは `src/Scanner.gs` を直接参照する。

---

## 4. Stored XSS（蓄積型XSS）防止アーキテクチャ

### 4.1 ソースコード表示の安全化
親フレーム（`Shell.html`）内でツールのHTMLソースコードを表示する際、**動的ユーザー入力の反映において `innerHTML` は絶対に使用せず、DOM の `textContent` への代入を徹底** しています。
```javascript
// 安全な実装 (ShellJs.html)
var sourceArea = document.getElementById('sourceCodeArea');
sourceArea.textContent = htmlPayload; // ブラウザがHTMLタグをテキストノードとして無害化描画
```

### 4.2 タイトル・説明文・ユーザー名の安全なエスケープ
スプレッドシートから読み出したメタデータ（タイトル、説明、作成者メールアドレス）を親画面のHTMLに挿入する際は、GAS標準の `HtmlService` によるサーバーサニタイズと、クライアント側での `escapeHtml_()` または `textContent` 設定を徹底。

---

## 5. 認可モデルと排他制御

### 5.1 ロール体系と公開範囲（Visibility）
- **公開範囲 (`visibility`)**:
  - `all`: 企業ドメイン内の全員が閲覧可能。すべてのRPCは利用者メールの取得を必須とし、取得できない場合は拒否する（匿名閲覧・代替識別へのフォールバックはない）。
  - `list`: `acl` シートで明示的に許可されたユーザーのみ閲覧可能。`acl` は個々のメールアドレス単位で判定し、Googleグループの自動展開はしない。
  - `private`: `custodian`（管理責任者）のみ閲覧・編集可能。`created_by` は作成時点では `custodian` と同一値になるが、監査上の記録であり、`custodian` が引き継がれた後は `created_by` に個別の閲覧権限を与えない。
- **ロール (`role`)**:
  - `editor`: 新バージョンのアップロード、メタデータ編集が可能。
  - `viewer`: 閲覧・実行のみ可能。

### 5.2 メールアドレス小文字正規化
Google Workspaceのメールアドレスは大文字小文字を区別しませんが、JavaScriptの文字列比較（`===`）ですり抜けや不一致が発生するのを防ぐため、すべてのメールアドレスは **`String(email).trim().toLowerCase()`** で正規化して照合します。

### 5.3 スクリプトロックによる同時書き込み競合（Race Condition）防止
複数ユーザーの変更系処理は `LockService.getScriptLock()` で排他制御します（ロック待機上限30秒）。SheetsとDriveをまたぐ厳密なトランザクションではありません。書込み失敗時には既存値への補償を試み、復元とflushを確認できた場合だけ新規Driveファイルを削除します。補償自体が失敗した場合は `ROLLBACK_FAILED` を返し、復旧に必要なDriveファイルを保持します。管理者は[運用手順](../operations.md)に従って台帳・実体・監査を確認してください。更新競合の規則は最終保存優先であり、画面を開いた時点の版を基準にした楽観ロックではありません。

---

## 6. 同意バイパス防止（Consent Bypass Mitigation）

### 6.1 バージョン分離同意キー
警告あり版の実行同意は、利用者メール・アーティファクトID・バージョンIDを組み合わせたキーで管理します。実装は `ShellJs.html` の `getConsentKey_()` です。
```javascript
// getConsentKey_() が構成するキーの形式
var consentKey = 'consent_' + userEmail + '_' + artifactId + '_' + currentVersionId;
```
警告がある新版は旧版の同意を流用せず、その利用者が新版に未同意なら再確認します。警告なし版は同意モーダルを挟まず実行します。スキャナーは任意の悪意ある処理を完全には検出できないため、悪意ある新版のすべてに再同意を保証するものではありません。ストレージへの同意記録が保存できなければ、次回の警告あり版アクセスでも同意を求めます。
