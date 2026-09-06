# アーティファクト作成ガイドラインと AI 用プロンプト

本ドキュメントは、GAS Artifact Hub に投稿する単一 HTML アプリケーション（アーティファクト）を作成する開発者、および生成 AI（ChatGPT, Claude, Gemini 等）を用いてアーティファクトを自動生成するための指示テンプレートを定めます。

---

## 1. アーティファクトの基本原則

GAS Artifact Hub は、ゼロトラスト隔離環境（`null` origin）の iframe 内で HTML を実行します。安全かつ快適に動作させるため、以下の原則を遵守してください。

| 原則 | 要件と理由 |
| --- | --- |
| **単一ファイル（Self-contained）** | HTML、CSS（`<style>`）、JavaScript（`<script>`）をすべて 1 つの `.html` ファイルにまとめてください。外部ファイルの相対リンクは読み込めません。 |
| **UTF-8 エンコーディング** | 文字化けを防ぐため、必ず `<meta charset="UTF-8">` を指定し UTF-8 で保存してください。 |
| **外部通信の開示と最小化** | 外部 API との通信（`fetch`, `XMLHttpRequest`）を行う場合は、アーティファクトの説明欄や画面上で通信先と利用目的を明示してください。外部ライブラリも極力インラインまたは著名CDNに留めてください。 |
| **機密情報のハードコード禁止** | API キー、パスワード、OAuth トークン、個人情報をコード内に直接書き込まないでください。閲覧者は「ソース表示」やブラウザ開発者ツールから全文を確認できます。 |
| **ユーザー操作起点でのダウンロード** | ファイル出力（CSV、テキスト等）を行う際は、必ず「ボタンクリック」等のユーザーイベントを同期的な起点として Blob URL（`URL.createObjectURL`）を生成・ダウンロードさせてください。 |
| **ビューポート・レスポンシブ** | `<meta name="viewport" content="width=device-width, initial-scale=1.0">` を指定し、PC・モバイル双方で崩れないレスポンシブデザインにしてください。 |

---

## 2. サンドボックス隔離（`null` Origin）の制約と対策

アーティファクトは `sandbox="allow-scripts allow-downloads allow-forms allow-popups allow-modals"` かつ `allow-same-origin` なしの隔離環境で実行されます。そのため、以下のブラウザ機能には制約があります：

### ① 親フレームや GAS API へのアクセス不可
- `window.parent`、`window.top`、`document.cookie` へのアクセスは、ブラウザの同一オリジンポリシー（`SecurityError`）によって遮断されます。
- 親フレームの DOM を操作したり、`google.script.run` などの GAS 内部 API を呼び出すことはできません。

### ② ストレージの非永続性
- `localStorage` や `sessionStorage`、`indexedDB` は、ブラウザの設定やセキュリティ制約によってアクセス拒否（例外発生）となるか、ページ再読込時にリセットされます。
- アプリの状態は JavaScript のメモリ変数で保持するか、必要に応じてファイルダウンロード（エクスポート）・ファイル読込（インポート）で永続化してください。

### ③ 自動ダウンロードの遮断
- ページ読み込み完了時やタイマー（`setTimeout`）から自動的に実行されるダウンロード処理は、ブラウザのサンドボックス制限によりブロックされます。
- 必ず利用者が「保存」ボタンをクリックしたイベントハンドラ内で `a.click()` を呼び出してください。

---

## 3. 生成 AI 用プロンプトテンプレート（Prompt Template）

生成 AI（ChatGPT, Claude, Gemini 等）にアーティファクトの作成を依頼する際は、以下の枠内のプロンプトをそのままコピー＆ペーストして指示を出してください。

```text
あなたは Google Workspace 向けの安全な社内 Web ツール（アーティファクト）を作成する熟練のフロントエンドエンジニアです。
以下の仕様と制約を厳格に遵守し、完成した単一の HTML ファイルを出力してください。

【作成するツール】
[ここに作成したいツールの要件や機能を記載してください。例: 社内アンケートの集計・グラフ表示ツール]

【必須技術制約】
1. 完全な単一ファイル:
   - HTML、CSS (<style>)、JavaScript (<script>) をすべて 1 つの HTML ファイルにインラインで記述してください。
   - すべてのスタイルを 1 つの <style> タグに、すべてのスクリプトを 1 つの <script> タグにまとめて記述してください。
   - 外部 CSS や外部 JS ライブラリの読み込みは行わず、標準の Web API と Vanilla JS / CSS で自己完結させてください。
2. ゼロトラスト・サンドボックス対応:
   - この HTML は sandbox="allow-scripts allow-downloads allow-forms allow-popups allow-modals" (allow-same-origin なし、null origin) で実行されます。
   - window.parent, window.top, document.cookie, google.script.run へのアクセスは一切行わないでください。
   - localStorage / sessionStorage に依存せず、メモリ内の状態管理、またはファイル入出力 (File API) で完結させてください。
3. 外部通信とシークレット:
   - 外部ネットワーク通信 (fetch / XHR / WebSocket) は行わないでください (外部通信ゼロ)。
   - API キーやトークンなどの秘密情報をコード内に埋め込まないでください。
4. ファイルダウンロード機能の実装 (必要な場合):
   - ファイルを出力する場合は、必ずユーザーの明示的なボタンクリック操作を起点として、Blob URL (URL.createObjectURL) と <a download> を用いて同期的に実行してください。
5. UI/UX・アクセシビリティ:
   - <meta charset="UTF-8"> とレスポンシブな <meta name="viewport"> を指定してください。
   - クリーンで洗練されたモダンなデザイン (スレートグレー基調、適切な余白、ボタンのホバー効果、ダークモード配慮) にしてください。
   - キーボード操作 (Tab, Enter) やスクリーンリーダー (適切な ARIA 属性) に配慮してください。
   - 絵文字を UI アイコンとして乱用せず、クリーンなテキストやインライン SVG を使用してください。

出力はコードブロック (```html ... ```) のみとしてください。
```

---

## 4. サンプルアーティファクト一覧

本リポジトリの `examples/` フォルダに、上記のガイドラインに適合した実用的なサンプルが用意されています。

1. **[Hello Counter](../examples/hello-counter.html)**
   - 最小構成のインタラクティブカウンター。
   - インライン CSS/JS、キーボード操作対応、アクセシビリティ（`aria-live`）、外部通信ゼロ。
2. **[CSV Analyzer](../examples/csv-analyzer.html)**
   - ファイルドラッグ＆ドロップによる CSV 解析ツール。
   - クライアントサイド全文検索・フィルタリング、統計情報表示。
   - ユーザー操作起点での安全な Blob CSV ダウンロード実装、外部通信ゼロ。
3. **[Markdown Previewer](../examples/markdown-previewer.html)**
   - 左右 2 ペインのリアルタイム Markdown プレビューエディタ。
   - 外部ライブラリを使わない安全なインライン Markdown 変換器（XSS エスケープ徹底）。
   - クリップボードコピーおよび Markdown ファイル保存機能、外部通信ゼロ。
4. **[CSV Matcher](../examples/csv-matcher.html)**
   - 2 つの CSV ファイル（基準 A vs 比較 B）をキー列で突合・差分検出する高機能照合ツール。
   - Enterprise Hybrid デザイン準拠、UTF-8 / Shift-JIS 対応、ワンクリック・サンプルデータ読み込み。
   - 完全一致・差異あり・片方のみの分類とセル単位の差分ハイライト、Excel 対応 UTF-8 BOM 付き CSV ダウンロード、外部通信ゼロ。

