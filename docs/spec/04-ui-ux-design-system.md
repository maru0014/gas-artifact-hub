# UI/UX デザインシステム仕様書 (Enterprise Hybrid Design System)

## 1. デザイン理念 (Design Philosophy)

**「どの企業・組織の内製ポータルとして導入されても自然に馴染む、プロフェッショナルで清潔感のあるインターフェース」**

### 1.1 排除された要素（非Gemini / 非AIプロトタイプ）
- 派手なネオングロー（サイバー風の紫・シアン発光）。
- カジュアルな絵文字（⚡, 🚀, ✨, 🧮, 📊 等）のUIアイコン利用。
- 画面領域を圧迫する巨大な常設ドロップゾーン。
- ツール画面に覆いかぶさるフローティングコントロールバー。

### 1.2 採用された要素（エンタープライズ・スタンダード）
- スレートグレーと信頼感のあるコーポレートブルーによる清潔感。
- ビジネス標準のライトモード（デフォルト）＋ 目の負担を軽減するダークモード切替。
- 一貫した線幅（`1.75px`）を持つクリーンなインライン SVG ラインアイコン。
- 高い情報密度と探索性を両立する **「左サイドバー ＋ ⌘K検索 ＋ 社内台帳テーブル切替」**。
- ツールの作業領域を100%確保する **44px スリム固定ヘッダー**。

---

## 2. カラートークン (Color Tokens)

```css
/* ライトテーマ（デフォルト） */
:root[data-theme="light"] {
  --bg: #f8fafc;                /* 画面背景（Slate 50） */
  --surface: #ffffff;           /* カード・パネル背景（純白） */
  --surface-sub: #f1f5f9;       /* ヘッダー・ホバー・枠内背景（Slate 100） */
  --border: #e2e8f0;            /* 通常境界線（Slate 200） */
  --border-strong: #cbd5e1;     /* 強調境界線（Slate 300） */
  --text: #0f172a;              /* 主テキスト（Slate 900） */
  --text-muted: #475569;        /* 補足テキスト（Slate 600） */
  --text-sub: #64748b;          /* メタ情報テキスト（Slate 500） */
  --primary: #1e293b;           /* プライマリアクション（Slate 800） */
  --accent: #2563eb;            /* コーポレートブルー（Blue 600） */
  --accent-subtle: #eff6ff;     /* ブルー背景（Blue 50） */

  /* セキュリティステータスタグ */
  --badge-safe-bg: #f0fdf4;
  --badge-safe-text: #15803d;
  --badge-safe-border: #bbf7d0;
  --badge-warn-bg: #fffbeb;
  --badge-warn-text: #b45309;
  --badge-warn-border: #fde68a;
}

/* ダークテーマ */
:root[data-theme="dark"] {
  --bg: #0b0f19;
  --surface: #111827;
  --surface-sub: #1f2937;
  --border: #1f2937;
  --border-strong: #374151;
  --text: #f9fafb;
  --text-muted: #9ca3af;
  --text-sub: #6b7280;
  --primary: #f9fafb;
  --accent: #3b82f6;
  --accent-subtle: rgba(59, 130, 246, 0.1);
  --badge-safe-bg: rgba(16, 185, 129, 0.1);
  --badge-safe-text: #34d399;
  --badge-safe-border: rgba(16, 185, 129, 0.25);
  --badge-warn-bg: rgba(245, 158, 11, 0.1);
  --badge-warn-text: #fbbf24;
  --badge-warn-border: rgba(245, 158, 11, 0.25);
}
```

---

## 3. タイポグラフィ (Typography)

- **UI基本フォント**: `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`
  - 視認性が高く、日本語フォントとも自然に調和。
  - レターパディング: `letter-spacing: -0.01em` で引き締まったプロフェッショナルな印象。
- **等幅コードフォント**: `JetBrains Mono, Menlo, monospace`
  - アーティファクトID、バージョン番号、キーボードショートカット（`⌘K`）、ソースコード表示に適用。

---

## 4. アイコン規律 (Iconography)

すべてのUIアイコンは、絵文字を排除し、**インライン SVG（Feather / Lucide スタイル）** に統一します。

```html
<!-- 基本SVGアイコンの構造 -->
<svg class="icon" viewBox="0 0 24 24">
  <!-- パス定義 -->
</svg>
```

```css
.icon {
  width: 16px;
  height: 16px;
  stroke-width: 1.75;
  stroke: currentColor;
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
  vertical-align: middle;
  flex-shrink: 0;
}
.icon-lg { width: 20px; height: 20px; }
.icon-xl { width: 28px; height: 28px; }
```

---

## 5. 主要レイアウト ＆ コンポーネント仕様

### 5.1 ポータル画面（Enterprise Hybrid Layout）
1. **左サイドバー (幅 240px 固定)**:
   - ブランド表示、ナビゲーション（すべてのツール、お気に入り、自分が作成）。
   - カテゴリ一覧（データ・分析、文書・要約、開発・ユーティリティ）とアイテム件数バッジ。
   - 下部にユーザープロファイルと「ライト/ダークテーマ切替ボタン」。
2. **上部バー (高さ 56px)**:
   - リアルタイム検索バー（`⌘K` / `Ctrl+K` 対応）。
   - 「アーティファクトを共有」CTAボタン。
3. **メイン領域ツールバー**:
   - セクションタイトル、絞り込み件数バッジ。
   - **「グリッド / リスト（台帳テーブル）切替セグメントコントロール」**。
4. **表示モード**:
   - **グリッド表示**: 概要が直感的に把握できるモダンカード形式。
   - **リスト表示**: セキュリティ診断・バージョン・作成者・更新日を一望できる社内台帳テーブル形式。
5. **全画面ドラッグ＆ドロップ（Overlay）**:
   - 画面のどこかにHTMLファイルをドラッグした瞬間に半透明のドロップゾーンがオーバーレイ出現。
6. **スライドオーバー Drawer**:
   - 右側から展開し、静的セキュリティスキャン結果カード、タイトル・説明入力、公開範囲（全社/限定/自分のみ）カード選択を提供。

### 5.2 実行ビューア（Artifact Shell v2）
1. **スリム固定ヘッダー (高さ 44px 固定)**:
   - 画面最上部に固定され、ツールのUI要素（タブやボタン）と絶対に被らない安全な配置。
   - ハブ一覧へ戻るリンク、ツール名、バージョン切り替えドロップダウン。
   - セキュリティ保護状態バッジ（クリックで同意仕様確認）。
   - ソースコード確認モーダル起動ボタン、共有リンクコピーボタン、自作ツール用の「新版を投稿」ボタン。
2. **サンドボックスコンテナ**:
   - 高さ `calc(100vh - 44px)`、幅 `100%`。
   - `iframe.srcdoc` でツールを100%全画面隔離実行。

---

## 6. アクセシビリティ (WAI-ARIA) ＆ キーボード操作

| 要素 | キーボード操作 / 属性 | 説明 |
| :--- | :--- | :--- |
| **グローバル検索** | `⌘K` または `Ctrl+K` | 検索窓に即座にフォーカスし、既存入力を全選択。 |
| **モーダル / Drawer** | `Escape` キー | 開いているモーダル・Drawer・ドロップダウンをスムーズに閉じる。 |
| **ダイアログ要素** | `role="dialog"` `aria-modal="true"` | スクリーンリーダーに対しモーダルダイアログであることを明示。 |
| **ボタンアクセシビリティ** | `aria-label` の徹底 | アイコン単体ボタン（閉じるボタン、ソースボタン等）に代替テキストを付与。 |
| **フォームラベル** | `<label for="...">` と `<input id="...">` | すべての入力要素を1対1で漏れなくバインド。 |
