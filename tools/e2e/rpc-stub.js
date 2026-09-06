/** UIのRPC境界だけを置換するfixture。本番srcには含めない。 */
(() => {
  const scenario = window.__GAS_TEST__ || {};
  const clone = value => JSON.parse(JSON.stringify(value));
  const config = {
    userEmail: 'owner@example.com',
    maxHtmlSizeKb: 1024,
    systemEnabled: true,
    allowedDomain: 'example.com',
    ...scenario.config
  };
  const artifacts = scenario.artifacts || [
    { artifactId: 'demo-artifact', title: '売上ダッシュボード', description: '月次の売上とCSVを確認', createdBy: 'owner@example.com', visibility: 'all', updatedAt: '2026-09-01T00:00:00.000Z', isEditor: true },
    { artifactId: 'text-helper', title: '議事録整形', description: '文書・要約の作業補助', createdBy: 'colleague@example.com', visibility: 'list', updatedAt: '2026-09-02T00:00:00.000Z', isEditor: false },
    { artifactId: 'personal-counter', title: '作業カウンター', description: '回数を数える', createdBy: 'owner@example.com', visibility: 'private', updatedAt: '2026-09-03T00:00:00.000Z', isEditor: true }
  ];
  let acls = scenario.acls || [{ email: 'owner@example.com', role: 'editor' }, { email: 'colleague@example.com', role: 'viewer' }];
  let publishedVersionId = 'version-2';
  const rawHtml = scenario.rawHtml || '<!doctype html><html lang="ja"><meta charset="utf-8"><body><h1 id="artifact-ready">検証用アーティファクト</h1><button id="counter" type="button">0</button><script>document.getElementById("counter").onclick = function () { this.textContent = Number(this.textContent) + 1; }; let parentBlocked = false; try { void parent.document.title; } catch (error) { parentBlocked = error.name === "SecurityError"; } document.body.dataset.origin = self.origin; document.body.dataset.parentBlocked = String(parentBlocked); parent.postMessage({ kind: "artifact-executed", origin: self.origin, parentBlocked: parentBlocked }, "*");<\/script><img src="data:," onerror="window.__sourceExecuted = true"></body></html>';
  const warnings = scenario.warnings || [{ category: 'NETWORK', rule: 'NETWORK_FETCH', line: 1, snippet: 'fetch("https://example.invalid")', message: '検証用の外部通信警告' }];
  const calls = [];
  const state = { ...scenario, config, calls };
  window.__GAS_TEST__ = state;

  function result(method, args) {
    if (scenario.fail?.[method]) return { ok: false, error: scenario.fail[method] };
    switch (method) {
      case 'apiGetInitialData': return { ok: true, data: { config, artifacts } };
      case 'apiBootstrap': return { ok: true, data: config };
      case 'apiListArtifacts': return { ok: true, data: artifacts };
      case 'apiGetAcl': return { ok: true, data: { acls } };
      case 'apiGetArtifact': {
        const artifact = artifacts.find(item => item.artifactId === args[0]);
        if (!artifact) return { ok: false, error: 'アーティファクトが見つかりません' };
        const versionId = args[1] || publishedVersionId;
        return { ok: true, data: {
          artifact: { ...artifact, custodian: 'owner@example.com', currentVersionId: publishedVersionId },
          currentVersion: { versionId, versionNum: versionId === 'version-1' ? 1 : 2, warnings, fileSize: rawHtml.length, sha256: 'fixture-hash' },
          versions: [{ versionId: 'version-2', versionNum: 2, createdAt: '2026-09-02T00:00:00.000Z', changeNote: '集計カードを更新' }, { versionId: 'version-1', versionNum: 1, createdAt: '2026-09-01T00:00:00.000Z', changeNote: '' }],
          acls, isEditor: scenario.isEditor ?? true, rawHtml, config, maxHtmlSizeKb: config.maxHtmlSizeKb
        } };
      }
      case 'apiUploadArtifact': return { ok: true, data: { artifactId: 'created-artifact', versionId: 'version-new' } };
      case 'apiUploadVersion': return { ok: true, data: { artifactId: args[0], versionId: 'version-new' } };
      case 'apiSaveArtifactSettings': {
        const artifact = artifacts.find(item => item.artifactId === args[0]);
        if (!artifact) return { ok: false, error: 'アーティファクトが見つかりません' };
        artifact.title = args[1]; artifact.description = args[2]; artifact.visibility = args[3];
        acls = args[4];
        return { ok: true, data: { artifactId: args[0] } };
      }
      case 'apiSwitchVersion': publishedVersionId = args[1]; return { ok: true, data: {} };
      case 'apiDeleteArtifact': return { ok: true, data: {} };
      default: throw new Error(`RPC fixture未対応: ${method}`);
    }
  }

  function runner(success, failure) {
    return new Proxy({}, {
      get(target, key) {
        if (key === 'withSuccessHandler') return callback => runner(callback, failure);
        if (key === 'withFailureHandler') return callback => runner(success, callback);
        if (typeof key !== 'string' || !key.startsWith('api')) throw new Error(`不明なRPC操作: ${String(key)}`);
        return (...args) => {
          calls.push({ method: key, args: clone(args) });
          setTimeout(() => {
            let response;
            try {
              if (scenario.transportFail?.[key]) throw new Error(scenario.transportFail[key]);
              response = clone(result(key, args));
            } catch (error) {
              if (failure) failure(error);
              else setTimeout(() => { throw error; });
              return;
            }
            if (success) success(response);
          }, scenario.delays?.[key] ?? 40);
        };
      }
    });
  }
  window.google = { script: { get run() { return runner(); } } };
})();
