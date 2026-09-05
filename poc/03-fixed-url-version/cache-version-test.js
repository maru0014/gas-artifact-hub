/**
 * PoC 3: Fixed URL + Version 解決 & キャッシュ整合性テスト
 */

const test = require('node:test');
const assert = require('node:assert');

// CacheService のモック実装 (100KB制限つき)
class MockCacheService {
  constructor() {
    this.store = new Map();
  }
  get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return item.value;
  }
  put(key, value, ttlSec) {
    if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 100 * 1024) {
      throw new Error('Cache value size exceeds 100KB limit!');
    }
    this.store.set(key, {
      value: String(value),
      expiresAt: Date.now() + (ttlSec * 1000)
    });
  }
  remove(key) {
    this.store.delete(key);
  }
}

// 2階層キャッシュ解決リゾルバのシミュレーション
class VersionResolver {
  constructor(cacheService, driveStorage) {
    this.cache = cacheService;
    this.drive = driveStorage; // Map: fileId -> htmlContent
    this.artifacts = new Map(); // artifactId -> metadata
    this.versions = new Map();  // versionId -> versionData
  }

  resolveArtifact(artifactId) {
    const cacheKey = `meta_${artifactId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { source: 'cache', data: JSON.parse(cached) };
    }

    const artifact = this.artifacts.get(artifactId);
    if (!artifact) return null;

    const currentVersion = this.versions.get(artifact.current_version_id);
    const resolved = {
      artifact,
      currentVersion
    };

    // メタデータキャッシュ格納 (常に格納)
    this.cache.put(cacheKey, JSON.stringify(resolved), 600);
    return { source: 'db', data: resolved };
  }

  getHtmlContent(driveFileId, fileSize) {
    const cacheKey = `html_${driveFileId}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { source: 'cache', html: cached };
    }

    const rawHtml = this.drive.get(driveFileId);
    if (!rawHtml) return null;

    // 90KB以下のみCacheServiceに格納 (安全マージン)
    if (fileSize <= 90 * 1024) {
      this.cache.put(cacheKey, rawHtml, 600);
    }
    return { source: 'drive', html: rawHtml };
  }

  switchVersion(artifactId, newVersionId) {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) throw new Error('Artifact not found');
    artifact.current_version_id = newVersionId;

    // キャッシュパージ
    this.cache.remove(`meta_${artifactId}`);
  }
}

test('固定URL解決: 1回目はDB解決、2回目はキャッシュ解決される', () => {
  const cache = new MockCacheService();
  const drive = new Map();
  const resolver = new VersionResolver(cache, drive);

  resolver.artifacts.set('art-1', { artifact_id: 'art-1', current_version_id: 'v-1' });
  resolver.versions.set('v-1', { version_id: 'v-1', version_num: 1, drive_file_id: 'f-1' });

  const first = resolver.resolveArtifact('art-1');
  assert.strictEqual(first.source, 'db');
  assert.strictEqual(first.data.currentVersion.version_id, 'v-1');

  const second = resolver.resolveArtifact('art-1');
  assert.strictEqual(second.source, 'cache');
  assert.strictEqual(second.data.currentVersion.version_id, 'v-1');
});

test('バージョン切り替え: キャッシュが即時パージされ新バージョンが返る', () => {
  const cache = new MockCacheService();
  const drive = new Map();
  const resolver = new VersionResolver(cache, drive);

  resolver.artifacts.set('art-1', { artifact_id: 'art-1', current_version_id: 'v-1' });
  resolver.versions.set('v-1', { version_id: 'v-1', version_num: 1, drive_file_id: 'f-1' });
  resolver.versions.set('v-2', { version_id: 'v-2', version_num: 2, drive_file_id: 'f-2' });

  // キャッシュに載せる
  resolver.resolveArtifact('art-1');

  // バージョン切替
  resolver.switchVersion('art-1', 'v-2');

  // 切替直後の取得
  const afterSwitch = resolver.resolveArtifact('art-1');
  assert.strictEqual(afterSwitch.source, 'db');
  assert.strictEqual(afterSwitch.data.currentVersion.version_id, 'v-2');
});

test('HTMLキャッシュ: 90KB以下はキャッシュされ、90KB超はDrive直読みで例外を起こさない', () => {
  const cache = new MockCacheService();
  const drive = new Map();
  const resolver = new VersionResolver(cache, drive);

  // 小さいHTML (50KB)
  const smallHtml = 'a'.repeat(50 * 1024);
  drive.set('f-small', smallHtml);

  const resSmall1 = resolver.getHtmlContent('f-small', 50 * 1024);
  assert.strictEqual(resSmall1.source, 'drive');
  const resSmall2 = resolver.getHtmlContent('f-small', 50 * 1024);
  assert.strictEqual(resSmall2.source, 'cache');

  // 巨大なHTML (300KB)
  const largeHtml = 'b'.repeat(300 * 1024);
  drive.set('f-large', largeHtml);

  // キャッシュ格納されず常にDrive直読みになるが、CacheService上限エラーで死なない
  const resLarge1 = resolver.getHtmlContent('f-large', 300 * 1024);
  assert.strictEqual(resLarge1.source, 'drive');
  const resLarge2 = resolver.getHtmlContent('f-large', 300 * 1024);
  assert.strictEqual(resLarge2.source, 'drive');
});
