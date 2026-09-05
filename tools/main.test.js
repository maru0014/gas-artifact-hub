const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadMain({ email = 'member@example.com', config = {}, sessionError = false } = {}) {
  const calls = [];
  const systemConfig = { SYSTEM_ENABLED: 'true', ALLOWED_DOMAIN: 'example.com', MAX_HTML_SIZE_KB: '1024', ...config };
  const store = new Proxy({
    getSystemConfig() { calls.push('config'); return systemConfig; }
  }, { get(target, name) {
    return target[name] || ((...args) => { calls.push({ name, args }); return name === 'listVisibleArtifacts' ? [] : {}; });
  }});
  const output = { setTitle() { return this; }, setXFrameOptionsMode() { return this; }, addMetaTag() { return this; } };
  const templates = [];
  const context = vm.createContext({
    console, Store: store,
    Session: { getActiveUser() { if (sessionError) throw new Error('identity unavailable'); return { getEmail: () => email }; } },
    Utilities: { newBlob: value => ({ getBytes: () => Buffer.from(value) }) },
    HtmlService: {
      XFrameOptionsMode: { DEFAULT: 'DEFAULT' },
      createTemplateFromFile(name) { const template = { name, evaluate: () => output }; templates.push(template); return template; }
    }
  });
  for (const filename of ['Constants.gs', 'Main.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', filename), 'utf8'), context, { filename });
  }
  return { context, calls, templates };
}

const apiCalls = [
  ['apiGetInitialData', []], ['apiBootstrap', []], ['apiListArtifacts', []],
  ['apiGetArtifact', ['artifact-1', '']],
  ['apiUploadArtifact', [{ title: 'test', htmlContent: '<html>test</html>', visibility: 'all' }]],
  ['apiUploadVersion', ['artifact-1', '<html>test</html>']],
  ['apiSwitchVersion', ['artifact-1', 'version-1']],
  ['apiUpdateMetadata', ['artifact-1', 'test', '', 'all']],
  ['apiUpdateAcl', ['artifact-1', 'viewer@example.com', 'viewer', false]],
  ['apiGetAcl', ['artifact-1']], ['apiDeleteArtifact', ['artifact-1']],
  ['apiSaveArtifactSettings', ['artifact-1', 'test', '', 'all', []]]
];

test('初期HTMLは本人識別やデータ取得を待たずに返る', () => {
  const { context, calls, templates } = loadMain({ sessionError: true });
  assert.doesNotThrow(() => context.doGet({ parameter: {} }));
  assert.equal(templates[0].name, 'Upload');
  assert.deepEqual(calls, []);
  assert.equal(templates[0].initialArtifactsJson, 'null');
});

test('不正なURL IDを別の有効IDへ変形しない', () => {
  const { context, templates } = loadMain();
  context.doGet({ parameter: { a: 'artifact-1<script>', v: 'version-1' } });
  assert.equal(templates[0].name, 'Upload');
  assert.equal(templates[0].artifactId, undefined);
});

for (const [condition, options] of [
  ['識別不可', { email: '' }], ['社外ユーザー', { email: 'outsider@other.example' }],
  ['未設定ドメイン', { config: { ALLOWED_DOMAIN: '' } }],
  ['壊れたドメイン設定', { email: 'member@example..com', config: { ALLOWED_DOMAIN: 'example..com' } }],
  ['全体停止', { config: { SYSTEM_ENABLED: 'false' } }]
]) {
  test(`${condition}では全RPCがデータ操作前に拒否する`, () => {
    for (const [api, args] of apiCalls) {
      const { context, calls } = loadMain(options);
      assert.equal(typeof context[api], 'function', api);
      const response = context[api](...args);
      assert.equal(response.ok, false, api);
      assert.ok(response.error, api);
      assert.deepEqual(calls.filter(call => typeof call !== 'string'), [], api);
    }
  });
}

test('利用者識別は空白と大小文字を正規化し実行所有者へ代替しない', () => {
  const { context, calls } = loadMain({ email: ' Member@Example.COM ' });
  assert.equal(context.apiListArtifacts().ok, true);
  assert.equal(calls.find(call => call.name === 'listVisibleArtifacts').args[0], 'member@example.com');
  assert.equal(loadMain({ email: '' }).context.apiListArtifacts().ok, false);
});

test('設定保存は入力検証後に単一のStore操作を呼ぶ', () => {
  const { context, calls } = loadMain();
  const result = context.apiSaveArtifactSettings('artifact-1', ' Title ', ' Desc ', 'list', [
    { email: ' Viewer@Example.COM ', role: 'viewer' }
  ]);
  assert.equal(result.ok, true);
  const mutations = calls.filter(call => typeof call !== 'string');
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].name, 'saveArtifactSettings');
  assert.deepEqual(JSON.parse(JSON.stringify(mutations[0].args)), [
    'member@example.com', 'artifact-1', 'Title', 'Desc', 'list', [{ email: 'viewer@example.com', role: 'viewer' }]
  ]);
});

test('Main境界は管理責任者を除く200人を新規作成と設定保存で受け付ける', () => {
  const members = Array.from({ length: 200 }, (_, index) => `member${String(index).padStart(3, '0')}@example.com`);
  const upload = loadMain({ email: 'owner@example.com' });
  const uploadResult = upload.context.apiUploadArtifact({
    title: 'Title', htmlContent: '<html>test</html>', visibility: 'list',
    principals: [' OWNER@EXAMPLE.COM ', ...members]
  });
  assert.equal(uploadResult.ok, true);
  assert.equal(upload.calls.find(call => call.name === 'createArtifact').args[5].length, 201);

  const settings = loadMain({ email: 'owner@example.com' });
  const settingsResult = settings.context.apiSaveArtifactSettings('artifact-1', 'Title', '', 'list', [
    { email: ' OWNER@EXAMPLE.COM ', role: 'viewer' },
    ...members.map(email => ({ email, role: 'viewer' }))
  ]);
  assert.equal(settingsResult.ok, true);
  assert.equal(settings.calls.find(call => call.name === 'saveArtifactSettings').args[5].length, 201);
});

test('Main境界は既知の管理責任者を除く201人と大小文字重複をStore呼出し前に拒否する', () => {
  const members = Array.from({ length: 201 }, (_, index) => `member${String(index).padStart(3, '0')}@example.com`);
  for (const principals of [
    members,
    ['member@example.com', ' MEMBER@EXAMPLE.COM ']
  ]) {
    const { context, calls } = loadMain({ email: 'owner@example.com' });
    const result = context.apiUploadArtifact({
      title: 'Title', htmlContent: '<html>test</html>', visibility: 'list', principals
    });
    assert.equal(result.ok, false);
    assert.deepEqual(calls.filter(call => typeof call !== 'string'), []);
  }

  const settings = loadMain({ email: 'owner@example.com' });
  const settingsResult = settings.context.apiSaveArtifactSettings('artifact-1', 'Title', '', 'list', [
    { email: 'owner@example.com', role: 'editor' },
    ...members.map(email => ({ email, role: 'viewer' }))
  ]);
  assert.equal(settingsResult.ok, false);
  assert.deepEqual(settings.calls.filter(call => typeof call !== 'string'), []);
});

test('設定保存は社外ACL、重複ACL、不正ID・ロールを拒否する', () => {
  for (const [id, acls] of [
    ['artifact-1', [{ email: 'viewer@other.example', role: 'viewer' }]],
    ['artifact-1', [{ email: 'v@example.com', role: 'viewer' }, { email: 'V@example.com', role: 'editor' }]],
    ['artifact-1', [{ email: 'v@example.com', role: 'admin' }]],
    ['artifact<script>1', []]
  ]) {
    const { context, calls } = loadMain();
    assert.equal(context.apiSaveArtifactSettings(id, 'test', '', 'list', acls).ok, false);
    assert.deepEqual(calls.filter(call => typeof call !== 'string'), []);
  }
});

test('セットアップとincludeはブラウザから呼べる公開関数にしない', () => {
  const sources = fs.readdirSync(path.join(__dirname, '../src')).filter(name => name.endsWith('.gs'));
  const allowed = new Set(['doGet', ...apiCalls.map(([name]) => name)]);
  for (const filename of sources) {
    const content = fs.readFileSync(path.join(__dirname, '../src', filename), 'utf8');
    for (const match of content.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
      assert.ok(match[1].endsWith('_') || allowed.has(match[1]), `${filename}: 公開関数 ${match[1]}`);
    }
  }
});
