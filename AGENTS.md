# AGENTS.md - GAS Artifact Hub AIエージェント開発ガイドライン

このドキュメントは、本プロジェクト（**GAS Artifact Hub**）で作業を行うすべてのAIエージェント（Antigravity, Claude, Gemini, GPT等）が従うべき最優先ルール、アーキテクチャ規律、および開発運用基準を定義します。

---

## 1. 最優先ルール (Mandatory Core Rules)

1. **言語と呼称**:
   - ユーザーが指定した言語・呼称を優先すること。
2. **サブエージェント・レビューの徹底**:
   - **ユーザーの担当指定・開始条件・再委譲禁止を、この一般的なレビュー規定より優先すること**。許可されていない担当やレビューを自動起動してはならない。
   - 重要な設計変更、機能追加、リファクタリング、UI刷新は、ユーザーが許可した範囲で独立した読み取り専用の担当レビューを受けること。
   - 指摘が残る変更を完了としない。レビューを開始できない場合は「実装検査済み・担当レビュー待ち」と未解決事項を報告し、ユーザー指定の確認手順へ戻す。進捗・制約の報告を止めない。
   - **担当内レビューと、ユーザーが依頼する正式な最終レビューを区別すること**。担当内の承認を最終公開・本番受入の承認に流用しない。
## 2. プロジェクト構造とファイル責務

```
gas-artifact-hub/
├── docs/                  # ドキュメント群
│   ├── spec/              # 詳細仕様書 (Overview, Security, Storage, UI/UX)
│   ├── adr/               # 設計判断記録 (ADR-001〜ADR-005)
│   └── agent/             # エージェント運用ガイド (Workflow, Prompt Templates)
├── poc/                   # 技術検証コード (PoC。概念検証であり本番の代替試験ではない)
│   └── 03-fixed-url-version/  # 2階層キャッシュ・固定URLの独立シミュレータ
├── src/                   # GAS 本番ソースコード
│   ├── appsscript.json    # GASマニフェスト (USER_DEPLOYING, DOMAIN)
│   ├── Constants.gs       # 定数定義 (シート名、ロール、キャッシュ設定)
│   ├── Setup.gs           # 5シート・Driveフォルダ自動生成
│   ├── Main.gs            # doGetルーティング、RPCエンドポイント
│   ├── Store.gs           # 排他制御、2階層キャッシュ、ACL認可
│   ├── DriveStore.gs      # Drive専用フォルダ、UTF-8ストリーム管理
│   ├── Scanner.gs         # 改行・空白耐性のある静的検査スキャナー（補助警告。安全性の保証ではない）
│   ├── Audit.gs           # 変更系操作の追記型監査ログ（アプリ側で改ざん不可を強制するものではない）
│   ├── Shell.html         # ゼロトラスト実行ビューア (srcdoc注入)
│   ├── ShellCss.html      # ビューア用CSSスタイル
│   ├── ShellJs.html       # ビューア用クライアントJavaScript
│   ├── Upload.html        # ポータル＆投稿画面
│   ├── UploadCss.html     # ポータル用CSSスタイル
│   └── UploadJs.html      # ポータル用クライアントJavaScript
├── tools/                 # 検証・テストツール群
│   ├── syntax-check.js    # GAS .gs 構文静的チェッカー
│   ├── scanner-rules.js   # スキャナールール定義モジュール
│   └── *.test.js          # オフライン単体ユニットテスト群
├── AGENTS.md              # 本ファイル (エージェント規律)
├── package.json           # テスト・静的解析スクリプト
└── README.md              # リポジトリ概要
```

---

## 3. アーキテクチャとセキュリティの鉄則

### 3.1 ゼロトラスト隔離（`null` origin）
- 投稿されたHTMLは必ず親フレーム（`Shell.html`）から `iframe.srcdoc = rawHtml` として注入すること。
- `sandbox` 属性には **絶対に `allow-same-origin` を含めないこと**。
- `sandbox="allow-scripts allow-downloads allow-forms allow-popups allow-modals"` を遵守すること。

### 3.2 Stored XSS（蓄積型XSS）対策
- HTMLソースコードを親フレームで表示する際、**絶対に `innerHTML` を使ってはならない**。必ず `element.textContent = rawHtml;` を代入すること。
- ユーザー名やタイトルをDOMに挿入する際は、エスケープ関数を通すか `textContent` / `innerText` を用いること。

### 3.3 2階層ストレージと100KBキャッシュ上限
- `CacheService` は **1エントリ最大100KB** の制限がある。
- 実体HTMLは **90KB以下のみキャッシュ** し、90KB超はGoogle DriveからUTF-8直読みすること。

### 3.4 静的解析スキャナーの改行耐性
- `Scanner.gs` は、外部URL属性を単方向のタグ属性トークナイザで走査し、他のルールは改行・空白を考慮した正規表現で検査する。双方を変更する場合は回帰試験で確認すること。

---

## 4. 開発・検証・テストコマンド

作業を行った際は、必ず以下のコマンドを実行して構文エラーやテスト破綻がないことを検証すること：

```powershell
# 1. すべての .gs ファイルの構文静的チェック
npm run check

# 2. オフライン自動ユニットテストの実行（件数は増減するため npm test の出力で都度確認する）
npm test

# 3. 公開対象ファイルの検査（禁止ファイル・既知の資格情報形式）
npm run check:public

# 4. 本番HTMLを用いるローカル検証用プレビュー（RPCはスタブ）
npm run preview:test
```

テストはGASの各サービス（Sheets/Drive/認証）を実際には呼び出さない代替ランタイム上で行うオフライン検証であり、実GAS環境での受入試験の代わりにはならない。詳細は[テストガイド](docs/testing.md)を参照する。

---

## 5. UI/UX トーン＆マナー（Enterprise Hybrid）

UIを生成・変更する際は、以下のデザインシステムを厳格に守ること：
- **絵文字（⚡, 🚀, ✨, 🧮 等）をUIアイコンとして使用しない**。必ずクリーンなインラインSVGを使用すること。
- **派手なネオングローや紫・シアンのグラデーションを使用しない**。スレートグレー（`#f8fafc` / `#1e293b`）とコーポレートブルー（`#2563eb`）を基調とすること。
- **ツールのUIを隠さない**。ビューア画面のヘッダーは高さ44px程度の固定スリムヘッダーとし、iframeコンテナと明確に上下分割すること。
- **キーボードショートカット対応**: 検索窓フォーカス（`⌘K` / `Ctrl+K`）、モーダル閉じ（`Escape`）を実装すること。
