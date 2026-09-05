# データ＆ストレージ仕様書 (Data Models & Storage Strategy)

## 1. 永続化ストレージの概要

GAS Artifact Hub は、外部データベースを一切使用せず、Google Workspace 標準機能である **Google スプレッドシート** と **Google Drive** を組み合わせてデータを永続化します。

---

## 2. スプレッドシート スキーマ定義

本システムは単一のスプレッドシート内に5つのシートを持ち、システム設定・メタデータ・履歴・権限・監査ログを管理します（[`src/Setup.gs`](../../src/Setup.gs) により自動生成）。

### 2.1 `system_config` シート（システム全体設定）

| カラム名 | 型 | 説明・初期値 |
| :--- | :--- | :--- |
| `key` | 文字列 | 設定キー名 (`SYSTEM_ENABLED`, `STORAGE_FOLDER_ID`, `ALLOWED_DOMAIN`, `MAX_HTML_SIZE_KB`)。主キー。 |
| `value` | 文字列 | 設定値（例: `true`, フォルダID, ドメイン名, `1024`）。 |
| `description` | 文字列 | 設定項目の説明。 |

### 2.2 `artifacts` シート（アーティファクト基本台帳）

| カラム名 | 型 | 説明・制約 |
| :--- | :--- | :--- |
| `artifact_id` | 文字列 | `Utilities.getUuid()` によるUUID（例: `550e8400-e29b-41d4-a716-446655440000`）。主キー。 |
| `title` | 文字列 | ツールの表示名（`Constants.LIMITS.MAX_TITLE_LENGTH` = 100文字まで）。 |
| `description` | 文字列 | ツールの説明・用途（`Constants.LIMITS.MAX_DESC_LENGTH` = 200文字まで）。 |
| `created_by` | 文字列 | 作成者メールアドレス（小文字正規化済み）。 |
| `custodian` | 文字列 | 管理責任者メールアドレス（退職時等の引き継ぎ用）。 |
| `current_version_id` | 文字列 | 公開中バージョンID（`versions.version_id` と同じくUUID）。 |
| `visibility` | 文字列 | 公開範囲: `all` (組織全体), `list` (限定公開), `private` (自分のみ)。 |
| `status` | 文字列 | ステータス: `active` (正常稼働), `disabled` (緊急停止), `deleted` (論理削除)。 |
| `created_at` | 日時 | ISO 8601 形式の作成日時。 |
| `updated_at` | 日時 | ISO 8601 形式の最終更新日時。 |
| `deleted_at` | 日時 | 削除日時（未削除時は空文字）。 |

### 2.3 `versions` シート（バージョン履歴と実体ポインタ）

| カラム名 | 型 | 説明・制約 |
| :--- | :--- | :--- |
| `version_id` | 文字列 | `Utilities.getUuid()` によるUUID（主キー）。 |
| `artifact_id` | 文字列 | 紐づくアーティファクトID。 |
| `version_num` | 数値 | 連番バージョン番号（例: `1`, `2` 等の整数値）。 |
| `drive_file_id` | 文字列 | Google Drive上に保存された実体HTMLのファイルID。 |
| `sha256` | 文字列 | 実体HTMLのSHA-256ハッシュ値（改ざん検知・同一性検証用）。 |
| `file_size` | 数値 | HTML実体のUTF-8バイトサイズ。 |
| `warnings_json` | JSON文字列 | `Scanner.gs` による静的セキュリティ検査結果JSON。 |
| `created_by` | 文字列 | 投稿者メールアドレス。 |
| `created_at` | 日時 | ISO 8601 形式の投稿日時。 |

### 2.4 `acl` シート（限定公開時のアクセス権限一覧）

| カラム名 | 型 | 説明・制約 |
| :--- | :--- | :--- |
| `artifact_id` | 文字列 | 紐づくアーティファクトID。 |
| `email` | 文字列 | 権限を付与された個々のユーザーのメールアドレス（小文字正規化済み）。Googleグループの自動展開・メンバー解決は未対応。 |
| `role` | 文字列 | `editor` (新版投稿可能), `viewer` (閲覧・実行のみ)。 |
| `granted_by` | 文字列 | 権限付与者のメールアドレス。 |
| `granted_at` | 日時 | ISO 8601 形式の付与日時。 |

### 2.5 `audit_log` シート（追記型の変更操作ログ）

`Audit.gs` は変更系操作を1行ずつ追記するだけで、ハッシュチェーン等によるアプリ側の改ざん防止機構は実装していない。Sheetsのシート保護・編集履歴・アクセス権限設定は運用者側の責任で行うこと。

| カラム名 | 型 | 説明・制約 |
| :--- | :--- | :--- |
| `timestamp` | 日時 | 発生日時（ISO 8601）。 |
| `user` | 文字列 | 実行者メールアドレス。 |
| `action` | 文字列 | `CREATE_ARTIFACT`, `UPLOAD_VERSION`, `SWITCH_VERSION`, `UPDATE_METADATA`, `UPDATE_ACL`, `DELETE_ARTIFACT`。 |
| `artifact_id` | 文字列 | 対象アーティファクトID。 |
| `version_id` | 文字列 | 対象バージョンID（該当する場合）。 |
| `details` | JSON文字列 | 変更前後の差分やパラメータJSON。 |

---

## 3. Google Drive 実体ストレージ仕様 (`DriveStore.gs`)

### 3.1 専用フォルダの分離管理
- 実体HTMLファイルは、スプレッドシートとは独立した専用フォルダ（デフォルト名: `GAS-Artifact-Hub-Storage`）に格納されます。
- 専用フォルダは初回セットアップの `setupSystem_()` が作成し、フォルダIDを `system_config` シートに保存します。通常の読取り・書込み経路でフォルダを新規作成することはありません。

### 3.2 ファイル命名規則
```
{artifact_id}_v{version_num}.html
例: 550e8400-e29b-41d4-a716-446655440000_v1.html
```
（`version_num` はバージョン番号の整数値であり、`version_id` そのものはファイル名に使われない。[`src/DriveStore.gs`](../../src/DriveStore.gs) 参照。）

### 3.3 UTF-8 ストリーム読み書きとロールバック
- **エンコーディング**: 日本語や多言語文字化けを防ぐため、常に `Utilities.newBlob(html, "text/html", name).getDataAsString("UTF-8")` で読み書きを実施。
- **保存補償**: Drive先行保存後にスプレッドシート処理が失敗した場合、先行作成したDriveファイルを `file.setTrashed(true)` でゴミ箱へ移す補償を試行します。補償が確認できた場合だけ整合状態へ戻ります。補償に失敗した場合は `ROLLBACK_FAILED` を返し、Driveファイルを保持したまま手動復旧の対象として扱います。

---

## 4. 2階層ストレージと高速キャッシュ戦略

### 4.1 キャッシュ容量制限と90KB閾値
Google Apps Script の `CacheService` は、**1エントリあたり最大100KB** という厳格な制約が存在します。
100KBを超える文字列をキャッシュに格納しようとすると例外エラーが発生するため、以下の2階層ルールを適用しています：

```mermaid
graph TD
    A[HTMLペイロード取得要求] --> B{サイズは90KB以下?}
    B -->|Yes (<= 90KB)| C[CacheService に格納/参照 (TTL 10分)]
    B -->|No (> 90KB)| D[Google Drive から直読み (UTF-8)]
    C --> E[クライアントへ高速返却]
    D --> E
```

1. **第1層: CacheService (サイズ <= 90KB)**
   - HTML実体を `CacheService.getScriptCache()` に保存（キー: `html_{version_id}_{sha256}`。[`src/Store.gs`](../../src/Store.gs) の `cachedHtml_()` 参照）。
   - TTL: **10分（600秒）**（`Constants.CACHE.TTL_SEC`）。
   - キャッシュに書き込めなくても（GASのCacheService障害・容量超過など）例外で処理を止めず、Driveからの直読みへ安全にフォールバックする。
2. **第2層: Google Drive UTF-8 直読み (サイズ > 90KB)**
   - 90KBを超えるファイルはキャッシュに格納せず、`DriveApp.getFileById()` から直接ストリーム読込。
   - 最大1MB（`Constants.LIMITS.DEFAULT_MAX_HTML_SIZE_KB`）は受入上限です。90KB超はDrive直読みになるため、1MBでの配信性能・安定性は実環境で未測定であり保証しません。

### 4.2 認可メタデータはキャッシュしない
- `status` / `visibility` / `acl` / `current_version_id` などアクセス可否に関わる情報は、`Store.getArtifactForView()` が `withScriptLock_()` の内側で毎回Sheetsから直接読み直す（[`src/Store.gs`](../../src/Store.gs)）。これらをキャッシュしないのは、緊急停止（`disabled`）やACL剥奪を次回アクセスで即時反映させ、キャッシュのTTL分だけ古い権限で閲覧され続ける事態を避けるため。
- `Constants.CACHE.PREFIX_META`（`meta_`）という定数は残っているが、現在どこからも参照されない未使用の定数であり、認可情報をキャッシュする実装は存在しない。キャッシュされるのはHTML実体（4.1節）だけである。
