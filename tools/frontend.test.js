const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {scanHtml} = require('./scanner-rules');
const {renderTemplate} = require('./html-template');

function loadClient(file) {
  const elements = new Map();
  const events = {};
  const readers = [];
  function element() {
    const classes = new Set();
    return {
      value: '', textContent: '', innerHTML: '', disabled: false, style: {}, children: [],
      classList: {add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)), contains: n => classes.has(n), toggle(n, force) { const enabled = force === undefined ? !classes.has(n) : force; enabled ? classes.add(n) : classes.delete(n); return enabled; }},
      setAttribute() {}, removeAttribute() {}, focus() {}, appendChild(child) { this.children.push(child); }, querySelectorAll() { return []; }, contains() { return false; },
    };
  }
  const document = {
    documentElement: element(), body: element(), activeElement: null,
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    querySelectorAll() { return []; }, addEventListener(name, fn) { events[name] = fn; },
    createElement: element, createDocumentFragment: element,
  };
  const calls = [];
  const run = new Proxy({}, {get(target, key) {
    if (key === 'withSuccessHandler') return fn => {target.success = fn; return run;};
    if (key === 'withFailureHandler') return fn => {target.failure = fn; return run;};
    return (...args) => calls.push({name: key, args, success: target.success, failure: target.failure});
  }});
  const context = {
    document, window: {addEventListener(name, fn) {events[name] = fn;}, location: {search: '', origin: 'https://example.test', pathname: '/'}},
    localStorage: {getItem() {throw new Error('Storage denied');}, setItem() {throw new Error('Storage denied');}},
    FileReader: function () { readers.push(this); this.readAsText = () => {}; },
    google: {script: {run}}, URLSearchParams, URL, console, setTimeout, clearTimeout,
    SERVER_ARTIFACT_ID: 'artifact-1', SERVER_VERSION_ID: '', SERVER_APP_URL: 'https://script.google.com/macros/s/production/exec',
    APP_URL: 'https://script.google.com/macros/s/production/exec', navigator: {},
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8').replace(/^<script>\s*|<\/script>\s*$/g, ''), context);
  context.showToast = () => {};
  return {context, document, events, readers, calls};
}

test('一覧と詳細は同じ設定・新版投稿テンプレートを使用する', () => {
  const upload = renderTemplate('Upload');
  const shell = renderTemplate('Shell');
  for (const html of [upload, shell]) {
    assert.equal((html.match(/id="settingsModal"/g) || []).length, 1);
    assert.equal((html.match(/id="uploadModal"/g) || []).length, 1);
    assert.match(html, />表示名 </);
    assert.match(html, /id="settings-artifact-id"/);
    assert.match(html, /id="update-change-note"[^>]*maxlength="500"/);
    assert.match(html, /onclick="openNewVersionModal\(true\)"/);
  }
});

for (const file of ['UploadJs.html', 'ShellJs.html']) {
  test(`${file}: ストレージ禁止でも初期RPCを開始する`, () => {
    const {context, events, calls} = loadClient(file);
    context.setupEventListeners = () => {};
    context.setupGlobalShortcuts = () => {};
    context.setupUpdateDropzone = () => {};
    assert.doesNotThrow(() => events.DOMContentLoaded());
    assert.equal(calls.length, 1);
  });
}

for (const [file, processName, stateName, previewName, buttonId] of [
  ['UploadJs.html', 'processFile', 'uploadState', 'previewScanResult', 'btn-submit-upload'],
  ['ShellJs.html', 'processUpdateFile', 'updateState', 'previewUpdateScanResult', 'btn-submit-version'],
]) {
  test(`${file}: ファイル切替中に旧HTMLを送信せず遅い読込も無視する`, () => {
    const {context, document, readers} = loadClient(file);
    context[previewName] = () => {};
    context[processName]({name: 'a.html', size: 20});
    readers[0].onload({target: {result: '<html>A</html>'}});
    context[processName]({name: 'b.html', size: 20});
    assert.equal(context[stateName].htmlContent, '');
    assert.equal(document.getElementById(buttonId).disabled, true);
    context[processName]({name: 'c.html', size: 20});
    readers[2].onload({target: {result: '<html>C</html>'}});
    readers[1].onload({target: {result: '<html>B</html>'}});
    assert.equal(context[stateName].htmlContent, '<html>C</html>');
  });
}

test('版の共有リンクは公開版を追従する固定URLを使う', async () => {
  const {context} = loadClient('ShellJs.html');
  let copied;
  context.navigator.clipboard = {writeText: async value => {copied = value;}};
  context.viewerState.artifactId = 'artifact-1';
  context.viewerState.currentVersionId = 'version-2';
  context.copyShareLink();
  assert.equal(copied, 'https://script.google.com/macros/s/production/exec?a=artifact-1');
});

test('ストレージ禁止でも明示同意後の実行が成立する', () => {
  const {context, document} = loadClient('ShellJs.html');
  context.viewerState.artifactId = 'artifact-1';
  context.viewerState.currentVersionId = 'version-2';
  context.viewerState.htmlPayload = '<html>run</html>';
  assert.doesNotThrow(() => context.acceptConsentAndExecute());
  assert.equal(document.getElementById('artifact-sandbox').srcdoc, '<html>run</html>');
});

test('SCAN_TRUNCATEDは同意画面で検査結果の省略を明示する', () => {
  const {context} = loadClient('ShellJs.html');
  const html = Array.from({length: 300}, (_, index) =>
    `<img src="https://cdn.example.test/${index}/${'x'.repeat(240)}.png">`
  ).join('');
  const warning = scanHtml(html).at(-1);

  assert.equal(warning.rule, 'SCAN_TRUNCATED');
  const metadata = context.resolveWarningMetadata(warning);

  assert.equal(metadata.title, '検査結果の一部を省略しました');
  assert.equal(metadata.explanation, warning.message);
});

test('新版API読込時に非表示ソースを事前描画しない', () => {
  const {context, calls} = loadClient('ShellJs.html');
  let rendered = 0;
  context.renderHeaderInfo = () => {};
  context.renderVersionDropdown = () => {};
  context.renderFilterButtons = () => {};
  context.renderSourceCode = () => {rendered++;};
  context.checkConsentAndExecute = () => {};
  context.loadArtifactDetails();
  calls[0].success({ok: true, data: {artifact: {}, currentVersion: {versionId: 'v1'}, rawHtml: '<html>body</html>'}});
  assert.equal(rendered, 0);
});

test('ドロワー内へドロップしても更新モードと入力を維持する', () => {
  const {context, document, events} = loadClient('UploadJs.html');
  context.setupEventListeners();
  document.getElementById('drawer').classList.add('show');
  context.uploadState.isUpdateMode = true;
  context.uploadState.updateArtifactId = 'artifact-1';
  let processed;
  context.processFile = file => {processed = file;};
  events.drop({preventDefault() {}, dataTransfer: {files: [{name: 'b.html'}]}});
  assert.equal(context.uploadState.isUpdateMode, true);
  assert.equal(context.uploadState.updateArtifactId, 'artifact-1');
  assert.equal(processed.name, 'b.html');
});

test('同意済みバージョンは再訪問時に同意モーダルを再表示しない', () => {
  const {context} = loadClient('ShellJs.html');
  context.viewerState.artifactId = 'artifact-1';
  context.viewerState.currentVersionId = 'version-2';
  context.viewerState.artifactData = {userEmail: 'user@example.test'};
  context.viewerState.htmlPayload = '<html>run</html>';
  context.acceptConsentAndExecute();

  let executed = false;
  let dialogShown = false;
  context.executeInSandbox = () => {executed = true;};
  context.showDialog_ = () => {dialogShown = true;};
  context.viewerState.warnings = [{line: 1, message: 'warn'}];
  context.checkConsentAndExecute();

  assert.equal(executed, true);
  assert.equal(dialogShown, false);
});

test('共有リンクはSERVER_APP_URLが/devでも/execへ正規化する', async () => {
  const {context} = loadClient('ShellJs.html');
  context.SERVER_APP_URL = 'https://script.google.com/macros/s/testdeploy/dev';
  let copied;
  context.navigator.clipboard = {writeText: async value => {copied = value;}};
  context.viewerState.artifactId = 'artifact-1';
  context.copyShareLink();
  assert.equal(copied, 'https://script.google.com/macros/s/testdeploy/exec?a=artifact-1');
});

for (const [file, processName, labelId, subId, cardId] of [
  ['UploadJs.html', 'processFile', 'selected-file-label', 'selected-file-sub', 'scanSummaryCard'],
  ['ShellJs.html', 'processUpdateFile', 'update-file-label', 'update-file-sub', 'updateScanCard'],
]) {
  test(`${file}: 無効な拡張子の選択で直前のプレビューが残らない`, () => {
    const {context, document} = loadClient(file);
    document.getElementById(labelId).textContent = 'previous.html';
    document.getElementById(subId).textContent = '10 KB · 準備完了';
    document.getElementById(cardId).style.display = 'block';
    context[processName]({name: 'invalid.txt', size: 10});
    assert.notEqual(document.getElementById(labelId).textContent, 'previous.html');
    assert.equal(document.getElementById(cardId).style.display, 'none');
  });

  test(`${file}: サイズ超過の選択で直前のプレビューが残らない`, () => {
    const {context, document} = loadClient(file);
    document.getElementById(labelId).textContent = 'previous.html';
    document.getElementById(subId).textContent = '10 KB · 準備完了';
    document.getElementById(cardId).style.display = 'block';
    context[processName]({name: 'toobig.html', size: 2000000});
    assert.notEqual(document.getElementById(labelId).textContent, 'previous.html');
    assert.equal(document.getElementById(cardId).style.display, 'none');
  });
}
