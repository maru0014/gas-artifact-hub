# PoC 3: Fixed URL + Version 解決とキャッシュ整合性（概念検証）

## 重要: 独立シミュレータであり、本番 `src/Store.gs` の代替テストではない

`cache-version-test.js` は `MockCacheService` と `VersionResolver` という、このPoC専用の独立した簡易実装をテストしている。**`src/Store.gs` を一切importせず、本番コードの挙動は検証しない。**

さらに、この `VersionResolver` はメタデータを `meta_{artifactId}` キーで `CacheService` にキャッシュする設計になっているが、**現在の本番実装（`src/Store.gs` の `getArtifactForView()`）は認可に関わるメタデータ（`status`/`visibility`/`acl`/`current_version_id`）をキャッシュせず、常にSheetsを都度参照する**（緊急停止やACL変更を次回アクセスで即時反映させるため）。つまりこのPoCの「メタデータキャッシュとパージ」という設計は、本番では採用されていない過去の検討案である。詳細は[データ＆ストレージ仕様書 4.2節](../../docs/spec/03-data-and-storage.md)と[ADR-003の改訂履歴](../../docs/adr/ADR-003-two-tier-storage-and-caching.md)を参照。

このPoCが今も有効に示しているのは、**HTML実体の90KB閾値によるキャッシュ/直読み分岐**（本番の `cachedHtml_()` と設計思想が一致する部分）のみである。

## 目的（概念検証としての範囲）
固定URL（`?a={artifactId}`）において、90KB以下のHTML実体はキャッシュから、90KB超はDriveから配信するという2階層方針が、簡易なモック実装上で矛盾なく動作することを確認する。

## このPoCのシミュレータが表現するルーティング（本番とは異なる部分を含む）

```text
GET /exec?a={artifactId}
       │
       ▼
1. [このPoC独自。本番では未採用] CacheService チェック (key: meta_{artifactId})
   ├─ HIT  : メタデータ解決完了 (Spreadsheetアクセス 0回)
   └─ MISS : Spreadsheet の artifacts / versions から読み出し & キャッシュ格納 (TTL: 600秒)
       │
       ▼
2. [本番の src/Store.gs と設計思想が一致] HTML実体の取得 (drive_file_id, file_size)
   ├─ file_size <= 90KB:
   │    CacheService (key: html_{version_id}_{sha256})
   │    ├─ HIT  : キャッシュからHTML即時返却 (Driveアクセス 0回)
   │    └─ MISS : Driveから取得 & キャッシュ格納 (TTL: 600秒)
   └─ file_size > 90KB:
        CacheService をスキップし、Drive から UTF-8 ストリーム直読み

3. [本番の実際の挙動] バージョン切り替え API (apiSwitchVersion) 実行時:
   Spreadsheet の current_version_id を更新 (LockService保護)。
   メタデータキャッシュを持たないため remove すべきキャッシュも無く、
   次回GETアクセスは常にSheetsを読み直すため新バージョンが配信される。
```

## 単体テスト
`node poc/03-fixed-url-version/cache-version-test.js` で検証可能。ただし上記の通り、これは独立シミュレータのテストであり、`npm test` に含まれる他のテスト（`tools/*.test.js`）のように本番の `src/Store.gs` をロードして検証するものではない。
