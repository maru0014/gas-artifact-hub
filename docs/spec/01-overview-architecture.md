# システムアーキテクチャ仕様書 (System Overview & Architecture)

## 1. プロジェクト概要

**GAS Artifact Hub** は、社内メンバーが生成AI（Claude, ChatGPT, Gemini, Antigravity等）で作成した「単一HTML Webアプリケーション」を、Google Workspace環境内で安全・迅速に共有・管理・実行するためのオープンソース・ハブプラットフォームです。

### 1.1 解決する課題
- **社内で共有する場所の提供**: 社員が外部ホスティングへ業務用アーティファクトを無断公開する必要を減らす。外部公開や投稿コードの情報送信そのものを防止する仕組みではない。
- **既存のWorkspace基盤を利用**: 本番はGoogle Apps Script (GAS)、Google スプレッドシート、Google Driveで構成する。専用サーバーの構築は不要だが、Workspaceライセンスと、権限管理・バックアップ・監査・障害対応などの運用は必要。[運用手順](../operations.md)を参照。
- **サンドボックス内で実行**: 投稿HTMLを親画面と異なるオリジンで実行し、親DOMや認証情報への直接アクセスを制限する。外部通信、フィッシング、資源消費などの限界は[セキュリティモデル](02-security-model.md)を参照。

---

## 2. システム構成図

```mermaid
graph TB
    subgraph "クライアント（ブラウザ）"
        Browser[ユーザーのブラウザ]
        subgraph "GAS 親フレーム (Artifact Hub Shell)"
            Header[44px スリム固定ヘッダー]
            Inspector[Source コードインスペクター]
            Consent[初回同意モーダル]
        end
        subgraph "ゼロトラスト サンドボックス"
            IFrame[iframe sandbox (null origin)]
            ToolApp[AI生成 単一HTMLツール]
        end
    end

    subgraph "Google Apps Script 実行基盤"
        MainGS[Main.gs (doGet / RPC Dispatcher)]
        StoreGS[Store.gs (排他制御・ACL・2階層キャッシュ)]
        DriveStoreGS[DriveStore.gs (UTF-8実体管理・フォルダ制御)]
        ScannerGS[Scanner.gs (改行対応 複数行静的検査スキャナー)]
        AuditGS[Audit.gs (変更系 監査ログ追記)]
    end

    subgraph "Google Workspace データ層"
        SS[(Google スプレッドシート: 5シート)]
        Drive[(Google Drive 専用フォルダ)]
        Cache[(CacheService)]
        Lock[(LockService)]
    end

    Browser -->|HTTPS GET ?a=xxx| MainGS
    MainGS -->|HTML出力| Browser
    Browser -->|google.script.run (RPC)| MainGS
    MainGS --> StoreGS
    MainGS --> ScannerGS
    StoreGS --> Lock
    StoreGS --> Cache
    StoreGS --> SS
    StoreGS --> DriveStoreGS
    DriveStoreGS --> Drive
    StoreGS --> AuditGS
    AuditGS --> SS

    Header -.->|srcdoc注入| IFrame
    IFrame --> ToolApp
```

---

## 3. コンポーネント構成と役割

| レイヤー | ファイル | 役割・責務 |
| :--- | :--- | :--- |
| **マニフェスト** | [`src/appsscript.json`](../../src/appsscript.json) | `executeAs: USER_DEPLOYING`, `access: DOMAIN` の定義。 |
| **定数定義** | [`src/Constants.gs`](../../src/Constants.gs) | 5シート名、ロール（`editor`, `viewer`）、公開範囲（`all`, `list`, `private`）、キャッシュ設定。 |
| **ルーティング/RPC** | [`src/Main.gs`](../../src/Main.gs) | `doGet` サニタイズルーティング、クライアントRPCインターフェース、サイズ検証。 |
| **データアクセス** | [`src/Store.gs`](../../src/Store.gs) | `LockService` 排他制御、2階層キャッシュ、ACL認可判定、スプレッドシートCRUD。 |
| **ストレージ** | [`src/DriveStore.gs`](../../src/DriveStore.gs) | Drive専用フォルダ生成・取得、UTF-8ストリーム保存・読込、ロールバック機構。 |
| **セキュリティ検査** | [`src/Scanner.gs`](../../src/Scanner.gs) | 改行耐性を持つ静的解析スキャナー（5大脅威カテゴリ、補助警告であり安全性の保証ではない）。 |
| **監査ログ** | [`src/Audit.gs`](../../src/Audit.gs) | 変更系操作（作成・更新・切替・削除・権限変更）の追記型ログ記録（アプリ側の改ざん防止機構はなし）。 |
| **初期セットアップ** | [`src/Setup.gs`](../../src/Setup.gs) | 5シート自動生成、ヘッダー保護、Driveフォルダ自動構成。 |
| **ポータルUI** | [`src/Upload.html`](../../src/Upload.html) | Enterprise Hybrid UI（サイドバー・台帳切替・全画面D&D・ACL設定）。 |
| **ビューアUI** | [`src/Shell.html`](../../src/Shell.html) | 44pxスリム固定ヘッダー、ゼロトラスト `srcdoc` 注入、Source確認、バージョン管理。 |

---

## 4. データフロー

### 4.1 アーティファクトの登録・新版投稿フロー
1. ユーザーがポータル画面に単一HTMLファイルをドラッグ＆ドロップ（またはファイル選択）。
2. クライアント側でHTMLファイルとタイトル等を確認する。新規IDはサーバーで生成し、新版は対象の既存IDを指定する。
3. クライアントが `google.script.run.apiUploadArtifact(req)` または `apiUploadVersion(artifactId, htmlContent)` を呼び出す。全RPCで本人識別・許可ドメイン・稼働状態と入力を検証する。
4. Store内部の `withScriptLock_()` によりスクリプトロックを取得し、設定・既存アーティファクトの編集権限を再確認する。
5. `Scanner.scan(html)` により静的検査を実行し、検出されたリスク項目と警告JSONを生成する。
6. 実体HTMLをGoogle Driveの専用フォルダへUTF-8保存（ファイル名: `{artifact_id}_v{version_num}.html`）。メタデータ・版・必要なACLと監査ログを書き込み、flushする。失敗時は補償を試み、補償失敗時は `ROLLBACK_FAILED` を返す。
7. 閲覧時は、HTML実体が90KB以下の場合のみ `CacheService` を利用する。90KB超は毎回Driveから直読みする。認可情報はキャッシュせず、Sheets正本を読み直す。

### 4.2 アーティファクトの実行・表示フロー
1. ユーザーが固定URL（`?a={artifactId}` または `?a={artifactId}&v={versionId}`）にアクセス。
2. `Main.gs` の `doGet` がパラメータをサニタイズ（英数ハイフン厳格判定）。
3. `doGet` はデータを埋め込まず親画面を返す。ブラウザが `apiGetArtifact(artifactId, versionId)` を呼び、サーバーは本人識別と認可後にHTMLを取得する。権限がなければRPCのエラーを画面に表示する。
4. 警告あり版で未同意なら実行前に同意を求める。警告なし版、またはその利用者・版で同意済みの場合は、親画面から `iframe.srcdoc` へHTMLを注入する。警告なしは安全の保証ではない。
