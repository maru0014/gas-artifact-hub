const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('./helpers/gas-runtime');

function setLegacyAclMembers(f, count) {
  f.state.tables.acl.splice(1, f.state.tables.acl.length - 1,
    ['artifact', 'owner@example.com', 'editor', 'owner@example.com', '2026'],
    ...Array.from({ length: count }, (_, index) => [
      'artifact', `member${String(index).padStart(3, '0')}@example.com`,
      index % 2 ? 'viewer' : 'editor', 'owner@example.com', '2026'
    ]));
  f.state.maxRows.acl = f.state.tables.acl.length;
}

function activeFileCount(f) {
  return [...f.state.files.values()].filter(file => !file.trashed).length;
}

test('認可は管理責任者と現在のACLに従い、元作成者・無記名・停止済みを拒否する', () => {
  const { Store } = createRuntime();
  const artifact = { status: 'active', visibility: 'list', created_by: 'former@example.com', custodian: 'owner@example.com' };
  const acls = [{ email: 'editor@example.com', role: 'editor' }, { email: 'viewer@example.com', role: 'viewer' }];
  assert.equal(Store.canEdit(artifact, 'former@example.com', acls), false);
  assert.equal(Store.canView(artifact, 'former@example.com', acls), false);
  assert.equal(Store.canEdit(artifact, ' OWNER@example.com ', acls), true);
  assert.equal(Store.canEdit(artifact, 'editor@example.com', acls), true);
  assert.equal(Store.canView(artifact, 'viewer@example.com', acls), true);
  assert.equal(Store.canEdit(artifact, 'viewer@example.com', acls), false);
  assert.equal(Store.canView({ ...artifact, visibility: 'all' }, '', []), false);
  assert.equal(Store.canEdit({ ...artifact, status: 'disabled' }, 'owner@example.com', acls), false);
});

test('privateは管理責任者のみ閲覧・編集でき、残っているACLは無効', () => {
  const { Store } = createRuntime();
  const artifact = { status: 'active', visibility: 'private', custodian: 'owner@example.com' };
  const acls = [{ email: 'editor@example.com', role: 'editor' }];
  assert.equal(Store.canView(artifact, 'editor@example.com', acls), false);
  assert.equal(Store.canEdit(artifact, 'editor@example.com', acls), false);
  assert.equal(Store.canView(artifact, 'owner@example.com', acls), true);
});

test('キャッシュを温めてもSheetの停止・ACL失効を次の閲覧で反映する', () => {
  const f = createRuntime(); f.seed();
  f.Store.getArtifactForView('viewer@example.com', 'artifact');
  f.state.tables.acl.pop();
  assert.equal(f.Store.getArtifactForView('viewer@example.com', 'artifact').error, 'FORBIDDEN');
  f.state.tables.artifacts[1][7] = 'disabled';
  assert.equal(f.Store.getArtifactForView('owner@example.com', 'artifact').error, 'NOT_FOUND');
});

test('キャッシュ障害が閲覧・新版保存を失敗させない', () => {
  const f = createRuntime({ failCache: true }); f.seed();
  assert.equal(f.Store.getArtifactForView('owner@example.com', 'artifact').rawHtml, '<h1>existing</h1>');
  const result = f.Store.uploadVersion('owner@example.com', 'artifact', '<h1>new</h1>');
  assert.equal(f.state.tables.artifacts[1][5], result.versionId);
  assert.equal([...f.state.files.values()].filter(file => !file.trashed).length, 2);
});

test('タイトル・説明の先頭 = は式にせず、アポストロフィも往復で保存する', () => {
  const f = createRuntime();
  const result = f.Store.createArtifact('owner@example.com', '=1+1', "'quote", 'all', '<h1>test</h1>', []);
  assert.equal(f.state.tables.artifacts[1][1], '=1+1');
  assert.equal(f.state.tables.artifacts[1][2], "'quote");
  f.Store.updateMetadata('owner@example.com', result.artifactId, '=1+1', '=1+1', 'all');
  assert.equal(f.state.tables.artifacts[1][2], '=1+1');
});

test('250件の警告を含む通常サイズHTMLも保存でき、省略を明示する', () => {
  const f = createRuntime();
  const html = Array.from({ length: 250 }, (_, i) => `<img src="https://example.com/${i}.png">`).join('\n');
  const result = f.Store.createArtifact('owner@example.com', 'Warnings', '', 'all', html, []);
  const saved = f.state.tables.versions[1][6];
  assert.ok(saved.length < 50000);
  const payload = f.Store.getArtifactForView('owner@example.com', result.artifactId);
  assert.ok(payload.currentVersion.warnings.some(warning => warning.rule === 'SCAN_TRUNCATED'));
});

test('大量履歴のメタ情報はCache上限に影響せず、viewerにはACLを返さない', () => {
  const f = createRuntime(); f.seed();
  for (let i = 0; i < 4; i++) f.state.tables.versions.push(['v' + i, 'artifact', i + 2, 'file-1', 'sha', 20, JSON.stringify([{ snippet: 'a'.repeat(30000) }]), 'owner@example.com', '2026']);
  const payload = f.Store.getArtifactForView('viewer@example.com', 'artifact');
  assert.equal(payload.rawHtml, '<h1>existing</h1>');
  assert.equal(payload.acls.length, 0);
  assert.equal(payload.maxHtmlSizeKb, 1024);
  assert.ok([...f.state.cache.keys()].every(key => key.startsWith('html_')));
});

test('一覧ACLは全件一括取得し、編集権限・管理責任者・ISO日付を返す', () => {
  const f = createRuntime(); f.seed();
  for (let i = 0; i < 20; i++) f.state.tables.artifacts.push([`artifact-${i}`, 'Item', '', 'former@example.com', 'owner@example.com', 'version', 'list', 'active', new Date('2026-09-05'), new Date('2026-09-05'), '']);
  f.state.tables.artifacts[1][9] = new Date('2026-09-05');
  const result = f.Store.listVisibleArtifacts('owner@example.com');
  assert.equal(f.state.reads.acl, 1);
  assert.equal(result[0].isEditor, true);
  assert.equal(result[0].isCustodian, true);
  assert.equal(result[0].updatedAt, '2026-09-05T00:00:00.000Z');
});

test('設定保存はメタ情報とACLの最終状態を一度に反映する', () => {
  const f = createRuntime(); f.seed();
  f.Store.saveArtifactSettings('owner@example.com', 'artifact', 'Private', '=1+1', 'private', [{ email: 'new@example.com', role: 'editor' }]);
  assert.equal(f.state.tables.artifacts[1][6], 'private');
  assert.equal(f.state.tables.artifacts[1][2], '=1+1');
  assert.equal(f.Store.canEdit(f.Store.findArtifact(f.spreadsheet, 'artifact'), 'new@example.com', f.Store.listAcl(f.spreadsheet, 'artifact')), false);
  assert.ok(f.Store.listAcl(f.spreadsheet, 'artifact').some(acl => acl.email === 'new@example.com'));
});

test('システム設定は必須キー欠損・重複・不正値をfail closedで拒否する', () => {
  const cases = [
    rows => rows.filter(row => row[0] !== 'ALLOWED_DOMAIN'),
    rows => [...rows, ['SYSTEM_ENABLED', 'true']],
    rows => rows.map(row => row[0] === 'SYSTEM_ENABLED' ? ['SYSTEM_ENABLED', 'enabled'] : row),
    rows => rows.map(row => row[0] === 'ALLOWED_DOMAIN' ? ['ALLOWED_DOMAIN', 'example..com'] : row),
    rows => rows.map(row => row[0] === 'MAX_HTML_SIZE_KB' ? ['MAX_HTML_SIZE_KB', 'NaN'] : row)
  ];
  for (const corrupt of cases) {
    const f = createRuntime();
    f.state.tables.system_config.splice(0, f.state.tables.system_config.length, ...corrupt(f.state.tables.system_config));
    assert.throws(() => f.Store.getSystemConfig(), /設定|SYSTEM_ENABLED|ALLOWED_DOMAIN|MAX_HTML_SIZE_KB/);
  }
  const disabled = createRuntime();
  disabled.state.tables.system_config.find(row => row[0] === 'SYSTEM_ENABLED')[1] = false;
  assert.equal(disabled.Store.getSystemConfig().SYSTEM_ENABLED, 'false');
});

test('設定保存はStore境界でもメタデータとACLを再検証する', () => {
  const invalidCases = [
    ['', '', 'all', []],
    ['Title', '', 'invalid', []],
    ['Title', '', 'list', [{ email: 'outside@other.example', role: 'viewer' }]],
    ['Title', '', 'list', [{ email: 'member@example.com', role: 'viewer' }, { email: 'MEMBER@example.com', role: 'editor' }]]
  ];
  for (const [title, description, visibility, acls] of invalidCases) {
    const f = createRuntime(); f.seed(); const initial = f.snapshot();
    assert.throws(() => f.Store.saveArtifactSettings('owner@example.com', 'artifact', title, description, visibility, acls), /設定|タイトル|公開範囲|メール|重複/);
    assert.deepEqual(f.snapshot(), initial);
  }
});

test('最大200件・最大長のACLも監査セル上限を超えず保存する', () => {
  const f = createRuntime(); f.seed();
  const acls = Array.from({ length: 200 }, (_, index) => ({
    email: `${String(index).padStart(3, '0')}${'a'.repeat(239)}@example.com`,
    role: index % 2 ? 'viewer' : 'editor'
  }));
  assert.doesNotThrow(() => f.Store.saveArtifactSettings('owner@example.com', 'artifact', 'Title', '', 'list', acls));
  assert.equal(f.Store.listAcl(f.spreadsheet, 'artifact').length, 201);
  assert.ok(String(f.state.tables.audit_log.at(-1)[5]).length < 50000);
});

test('管理責任者を含む200人設定と含まない200人設定は同じACL最終状態になる', () => {
  const members = Array.from({ length: 200 }, (_, index) => ({
    email: `member${String(index).padStart(3, '0')}@example.com`, role: index % 2 ? 'viewer' : 'editor'
  }));
  const omitted = createRuntime(); omitted.seed();
  const included = createRuntime(); included.seed();
  omitted.Store.saveArtifactSettings('owner@example.com', 'artifact', 'Title', '', 'list', members);
  included.Store.saveArtifactSettings('owner@example.com', 'artifact', 'Title', '', 'list', [
    { email: ' OWNER@EXAMPLE.COM ', role: 'viewer' }, ...members
  ]);
  const state = f => f.Store.listAcl(f.spreadsheet, 'artifact').map(({ email, role }) => ({ email, role }));
  assert.deepEqual(JSON.parse(JSON.stringify(state(included))), JSON.parse(JSON.stringify(state(omitted))));
  assert.deepEqual(JSON.parse(JSON.stringify(state(included)[0])), { email: 'owner@example.com', role: 'editor' });
});

test('200人時はタイトルだけを保存でき、201人目の追加は全状態を変更せず拒否する', () => {
  const f = createRuntime(); f.seed(); setLegacyAclMembers(f, 200);
  const currentAcl = f.Store.listAcl(f.spreadsheet, 'artifact').map(({ email, role }) => ({ email, role }));
  assert.doesNotThrow(() => f.Store.saveArtifactSettings(
    'owner@example.com', 'artifact', 'Renamed', '', 'list', currentAcl
  ));
  assert.equal(f.state.tables.artifacts[1][1], 'Renamed');
  const before = f.snapshot();
  assert.throws(() => f.Store.updateAcl(
    'owner@example.com', 'artifact', 'overflow@example.com', 'viewer', false
  ), /200/);
  assert.deepEqual(f.snapshot(), before);
});

test('既存超過ACLは削除で段階的に削減できるが追加とロール更新は拒否する', () => {
  const f = createRuntime(); f.seed(); setLegacyAclMembers(f, 202);
  assert.doesNotThrow(() => f.Store.updateAcl(
    'owner@example.com', 'artifact', 'member201@example.com', '', true
  ));
  assert.equal(f.Store.listAcl(f.spreadsheet, 'artifact').length, 202); // custodian + 201

  for (const mutation of [
    () => f.Store.updateAcl('owner@example.com', 'artifact', 'extra@example.com', 'viewer', false),
    () => f.Store.updateAcl('owner@example.com', 'artifact', 'member000@example.com', 'viewer', false)
  ]) {
    const before = f.snapshot();
    assert.throws(mutation, /200/);
    assert.deepEqual(f.snapshot(), before);
  }

  assert.doesNotThrow(() => f.Store.updateAcl(
    'owner@example.com', 'artifact', 'member200@example.com', '', true
  ));
  assert.equal(f.Store.listAcl(f.spreadsheet, 'artifact').length, 201); // custodian + 200
});

test('ACL追加・削除・ロール更新は大小文字を正規化しcustodianを降格させない', () => {
  const f = createRuntime(); f.seed();
  f.Store.updateAcl('owner@example.com', 'artifact', ' NEW@Example.COM ', 'viewer', false);
  assert.equal(f.Store.listAcl(f.spreadsheet, 'artifact').find(entry => entry.email === 'new@example.com').role, 'viewer');
  f.Store.updateAcl('owner@example.com', 'artifact', 'new@example.com', 'editor', false);
  assert.equal(f.Store.listAcl(f.spreadsheet, 'artifact').find(entry => entry.email === 'new@example.com').role, 'editor');
  f.Store.updateAcl('owner@example.com', 'artifact', 'NEW@example.com', '', true);
  assert.equal(f.Store.listAcl(f.spreadsheet, 'artifact').some(entry => entry.email === 'new@example.com'), false);
  assert.throws(() => f.Store.updateAcl('owner@example.com', 'artifact', 'OWNER@example.com', 'viewer', false), /管理責任者/);
  assert.throws(() => f.Store.updateAcl('owner@example.com', 'artifact', 'owner@example.com', '', true), /管理責任者/);
});

test('一括保存と新規作成は大小文字重複を拒否し、責任者を除く201人を保存前に拒否する', () => {
  const duplicate = createRuntime(); duplicate.seed();
  assert.throws(() => duplicate.Store.saveArtifactSettings('owner@example.com', 'artifact', 'Title', '', 'list', [
    { email: 'member@example.com', role: 'viewer' },
    { email: ' MEMBER@EXAMPLE.COM ', role: 'editor' }
  ]), /重複/);

  const createDuplicate = createRuntime();
  assert.throws(() => createDuplicate.Store.createArtifact(
    'owner@example.com', 'Title', '', 'list', '<h1>new</h1>', ['member@example.com', ' MEMBER@EXAMPLE.COM ']
  ), /重複/);
  assert.equal(activeFileCount(createDuplicate), 0);

  const principals = Array.from({ length: 201 }, (_, index) => `member${String(index).padStart(3, '0')}@example.com`);
  const saveTooMany = createRuntime(); saveTooMany.seed();
  const beforeSave = saveTooMany.snapshot();
  assert.throws(() => saveTooMany.Store.saveArtifactSettings(
    'owner@example.com', 'artifact', 'Changed', '', 'list',
    principals.map(email => ({ email, role: 'viewer' }))
  ), /200/);
  assert.deepEqual(saveTooMany.snapshot(), beforeSave);

  const atLimit = createRuntime();
  const created = atLimit.Store.createArtifact(
    'owner@example.com', 'Title', '', 'list', '<h1>new</h1>', [' OWNER@EXAMPLE.COM ', ...principals.slice(0, 200)]
  );
  assert.equal(atLimit.Store.listAcl(atLimit.spreadsheet, created.artifactId).length, 201);

  const tooMany = createRuntime();
  assert.throws(() => tooMany.Store.createArtifact(
    'owner@example.com', 'Title', '', 'list', '<h1>new</h1>', principals
  ), /200/);
  assert.equal(activeFileCount(tooMany), 0);
});

test('有限行Sheetへの追記はロック内で必要行だけ拡張する', () => {
  const f = createRuntime();
  const before = { ...f.state.maxRows };
  f.Store.createArtifact('owner@example.com', 'New', '', 'list', '<h1>new</h1>', [
    'viewer1@example.com', 'viewer2@example.com'
  ]);
  assert.deepEqual(f.state.rowExpansions, [
    { sheet: 'artifacts', afterPosition: before.artifacts, howMany: 1 },
    { sheet: 'versions', afterPosition: before.versions, howMany: 1 },
    { sheet: 'acl', afterPosition: before.acl, howMany: 3 },
    { sheet: 'audit_log', afterPosition: before.audit_log, howMany: 1 }
  ]);
  assert.equal(f.state.locked, false);
});

const rowAppendOperations = {
  artifacts: f => f.Store.createArtifact('owner@example.com', 'New', '', 'all', '<h1>new</h1>', []),
  versions: f => f.Store.uploadVersion('owner@example.com', 'artifact', '<h1>new</h1>'),
  acl: f => f.Store.updateAcl('owner@example.com', 'artifact', 'new@example.com', 'viewer', false),
  audit_log: f => f.Store.updateMetadata('owner@example.com', 'artifact', 'Changed', '', 'all')
};

for (const [sheetName, operation] of Object.entries(rowAppendOperations)) {
  for (const when of ['before', 'after']) {
    test(`${sheetName}: 物理行拡張の${when === 'before' ? '前' : '後'}で失敗しても業務データを復元する`, () => {
      const f = createRuntime();
      if (sheetName !== 'artifacts') f.seed();
      const before = f.snapshot();
      const maxRows = f.state.maxRows[sheetName];
      const files = activeFileCount(f);
      f.state.rowExpansionFailure = { sheet: sheetName, when };
      assert.throws(() => operation(f), /row expansion failure/);
      assert.deepEqual(f.snapshot(), before);
      assert.equal(activeFileCount(f), files);
      assert.equal(f.state.maxRows[sheetName], maxRows + (when === 'after' ? 1 : 0));
      assert.equal(f.state.locked, false);
    });
  }
}

test('行拡張後の書込みと補償が失敗した場合は版参照を維持しDriveを保持してROLLBACK_FAILEDを返す', () => {
  const f = createRuntime(); f.seed();
  const currentVersionId = f.state.tables.artifacts[1][5];
  const auditCount = f.state.tables.audit_log.length;
  f.state.failure = { at: 1, when: 'after' };
  f.state.rollbackFailure = true;
  assert.throws(() => f.Store.uploadVersion('owner@example.com', 'artifact', '<h1>new</h1>'), /ROLLBACK_FAILED/);
  assert.equal(f.state.tables.artifacts[1][5], currentVersionId);
  assert.equal(f.state.tables.audit_log.length, auditCount);
  assert.equal(activeFileCount(f), 2);
  assert.ok(f.state.maxRows.versions > 2);
  assert.equal(f.state.locked, false);
});

const operations = {
  create: f => f.Store.createArtifact('owner@example.com', 'New', 'Description', 'list', '<h1>new</h1>', ['viewer@example.com']),
  upload: f => f.Store.uploadVersion('owner@example.com', 'artifact', '<h1>new</h1>'),
  switch: f => f.Store.switchVersion('owner@example.com', 'artifact', 'version'),
  metadata: f => f.Store.updateMetadata('owner@example.com', 'artifact', 'Changed', 'Desc', 'all'),
  acl: f => f.Store.updateAcl('owner@example.com', 'artifact', 'viewer@example.com', 'editor', false),
  aclDelete: f => f.Store.updateAcl('owner@example.com', 'artifact', 'viewer@example.com', '', true),
  remove: f => f.Store.deleteArtifact('owner@example.com', 'artifact'),
  settings: f => f.Store.saveArtifactSettings('owner@example.com', 'artifact', 'Changed', 'Desc', 'all', [{ email: 'new@example.com', role: 'editor' }])
};

for (const [name, operation] of Object.entries(operations)) {
  test(`${name}: 各Sheet書込みの前後で失敗してもデータ全体を復元する`, () => {
    const baseline = createRuntime(); baseline.seed(); operation(baseline);
    const writes = baseline.state.writes;
    assert.ok(writes > 0);
    for (const when of ['before', 'after']) for (let at = 1; at <= writes; at++) {
      const f = createRuntime(); f.seed(); const initial = f.snapshot();
      f.state.failure = { at, when };
      assert.throws(() => operation(f), undefined, `${name}: ${when} write ${at}`);
      assert.deepEqual(f.snapshot(), initial, `${name}: restore ${when} write ${at}`);
      assert.equal([...f.state.files.values()].filter(file => !file.trashed).length, 1);
      assert.equal(f.state.locked, false);
    }
  });
}

test('flushの失敗も補償し、ロックを必ず解放する', () => {
  const f = createRuntime(); f.seed(); const initial = f.snapshot();
  f.state.failFlushAt = 1;
  assert.throws(() => operations.upload(f), /flush/);
  assert.deepEqual(f.snapshot(), initial);
  assert.equal(f.state.locked, false);
});

test('補償書込みも失敗した場合はDriveを保持して復旧必要を明示する', () => {
  const f = createRuntime(); f.seed();
  f.state.failure = { at: 2, when: 'after' }; f.state.rollbackFailure = true;
  assert.throws(() => operations.upload(f), /ROLLBACK_FAILED/);
  assert.equal([...f.state.files.values()].filter(file => !file.trashed).length, 2);
});

test('監査ログ欠落を成功扱いにせずデータを復元する', () => {
  const f = createRuntime(); f.seed(); const initial = f.snapshot(); delete f.sheets.audit_log;
  assert.throws(() => operations.upload(f), /監査|audit_log/);
  assert.deepEqual(f.snapshot(), initial);
});

test('設定済みDriveフォルダの取得失敗は同名フォルダへ切り替えない', () => {
  const f = createRuntime({ invalidFolder: true });
  assert.throws(() => f.DriveStore.getOrCreateStorageFolder('missing'), /フォルダ|folder/);
  assert.equal(f.state.folderSearches, 0);
});

test('Drive作成後のメタ情報取得失敗はファイルを補償削除する', () => {
  const f = createRuntime({ failFileSize: true });
  assert.throws(() => f.DriveStore.saveHtml(f.DriveStore.getOrCreateStorageFolder('folder'), 'a', 1, '<h1>test</h1>'));
  assert.ok([...f.state.files.values()].every(file => file.trashed));
});
