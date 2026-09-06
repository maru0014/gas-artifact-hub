const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setupHarness(email = 'admin@example.com') {
  const sheets = new Map();
  const folders = [];
  const trashedFolders = [];
  const properties = {};
  let flushed = false;
  let released = false;
  let locked = false;
  const uiCalls = [];
  const responses = [];
  const ui = {
    Button: { OK: 'OK', CANCEL: 'CANCEL' }, ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL' },
    createMenu(name) { uiCalls.push(['menu', name]); return { addItem(label, callback) { uiCalls.push(['item', label, callback]); return this; }, addToUi() { uiCalls.push(['show']); } }; },
    prompt(...args) { assert.equal(locked, false, '入力待ちの間はロックを保持しない'); uiCalls.push(['prompt', ...args]); const response = responses.shift() || { button: 'OK', text: '' }; return { getSelectedButton: () => response.button, getResponseText: () => response.text }; },
    alert(...args) { assert.equal(locked, false, '通知の間はロックを保持しない'); uiCalls.push(['alert', ...args]); return 'OK'; }
  };
  function sheet(name) {
    const rows = [];
    let maxColumns = 26;
    const style = { setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; } };
    const result = {
      rows, getLastRow: () => rows.length,
      getName: () => name, getMaxColumns: () => maxColumns, getMaxRows: () => 1000,
      getLastColumn: () => rows.reduce((max, row) => Math.max(max, row.length), 0),
      getDataRange: () => ({ getValues: () => rows.map(row => [...row]), isBlank: () => rows.every(row => row.every(cell => cell === '')), getNotes: () => [['']] }),
      appendRow(row) { rows.push([...row]); return result; },
      getRange: (r, c, nr, nc) => ({ ...style, isBlank: () => rows.slice(r - 1, r - 1 + nr).every(row => row.slice(c - 1, c - 1 + nc).every(cell => cell === '')), getNotes: () => [['']] }), setFrozenRows() {},
      deleteColumns(start, count) { assert.ok(start > 0 && count > 0 && start + count - 1 <= maxColumns); maxColumns -= count; }
    };
    sheets.set(name, result);
    return result;
  }
  const ss = { getId: () => 'db-local', getSheetByName: name => sheets.get(name), insertSheet: sheet, deleteSheet(target) { sheets.delete(target.getName()); } };
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => ui, flush() { flushed = true; } },
    Session: { getActiveUser: () => ({ getEmail: () => email }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key], setProperty(key, value) { properties[key] = value; } }) },
    DriveStore: { getOrCreateStorageFolder(id) { folders.push(id || ''); return { getId: () => id || 'new-storage', setTrashed(value) { assert.equal(value, true); trashedFolders.push(id || 'new-storage'); } }; } },
    LockService: { getScriptLock: () => ({ tryLock() { locked = true; return true; }, releaseLock() { released = true; locked = false; assert.equal(flushed, true); } }) },
    Logger: { log() {} }
  });
  for (const filename of ['Constants.gs', 'Setup.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', filename), 'utf8'), context, { filename });
  }
  return { context, sheets, folders, trashedFolders, properties, sheet, ss, uiCalls, responses, status: () => ({ flushed, released }) };
}

test('再セットアップは停止設定と保存フォルダ・既存行を維持する', () => {
  const h = setupHarness();
  h.context.setupSystem_();
  h.sheets.get('system_config').rows.find(row => row[0] === 'SYSTEM_ENABLED')[1] = 'false';
  h.sheets.get('artifacts').rows.push(['existing']);
  const before = JSON.stringify([...h.sheets].map(([name, value]) => [name, value.rows]));
  h.context.setupSystem_();
  assert.deepEqual(h.folders, ['', 'new-storage']);
  assert.equal(JSON.stringify([...h.sheets].map(([name, value]) => [name, value.rows])), before);
  assert.equal(h.properties.SPREADSHEET_ID, 'db-local');
  assert.deepEqual(h.status(), { flushed: true, released: true });
});

test('本人不明・個人Gmail・壊れたドメインでは初期化を開始しない', () => {
  for (const email of ['', 'someone@gmail.com', 'someone@googlemail.com', 'someone@example..com', 'someone@-example.com']) {
    const h = setupHarness(email);
    assert.throws(() => h.context.setupSystem_(), /Workspace|識別/);
    assert.equal(h.sheets.size, 0);
    assert.equal(h.folders.length, 0);
  }
});

test('既存シートの列構成が異なる場合は上書きせず停止する', () => {
  const h = setupHarness();
  h.sheet('artifacts').rows.push(['other-schema']);
  assert.throws(() => h.context.setupSystem_(), /列|ヘッダー/);
  assert.equal(h.folders.length, 0);
  assert.deepEqual(h.sheets.get('artifacts').rows, [['other-schema']]);
});

test('空の既存設定はDriveフォルダを作成する前に拒否する', () => {
  const h = setupHarness();
  h.sheet('system_config').rows.push(
    ['key', 'value', 'description'],
    ['STORAGE_FOLDER_ID', '', '保存先']
  );
  assert.throws(() => h.context.setupSystem_(), /STORAGE_FOLDER_ID.*空欄/);
  assert.equal(h.folders.length, 0);
});

test('シートを開くとメニューだけを追加し、初期化やDriveアクセスは行わない', () => {
  const h = setupHarness();
  assert.equal(typeof h.context.onOpen, 'function');
  h.context.onOpen();
  assert.deepEqual(h.uiCalls, [['menu', 'GAS Artifact Hub'], ['item', '初回セットアップ', 'runSetupFromMenu_'], ['show']]);
  assert.equal(h.sheets.size, 0);
  assert.equal(h.folders.length, 0);
  assert.equal(h.status().released, false);
});

test('メニューの入力をキャンセルするとシート・Drive・プロパティを変更しない', () => {
  const h = setupHarness();
  h.responses.push({ button: 'CANCEL', text: 'ignored' });
  assert.equal(typeof h.context.runSetupFromMenu_, 'function');
  h.context.runSetupFromMenu_();
  assert.equal(h.sheets.size, 0);
  assert.equal(h.folders.length, 0);
  assert.deepEqual(h.properties, {});
});

test('メニューで指定したフォルダを直接使用し、入力中はロックを取らない', () => {
  const h = setupHarness();
  h.responses.push({ button: 'OK', text: '  chosen-folder_1  ' });
  assert.equal(typeof h.context.runSetupFromMenu_, 'function');
  h.context.runSetupFromMenu_();
  assert.deepEqual(h.folders, ['chosen-folder_1']);
  assert.equal(h.sheets.get('system_config').rows.find(row => row[0] === 'STORAGE_FOLDER_ID')[1], 'chosen-folder_1');
  assert.ok(h.uiCalls.some(call => call[0] === 'alert' && call.join(' ').includes('完了')));
});

test('空欄のメニュー入力は新規作成し、再実行では入力を求めず既存の停止設定を維持する', () => {
  const h = setupHarness();
  h.context.runSetupFromMenu_();
  h.sheets.get('system_config').rows.find(row => row[0] === 'SYSTEM_ENABLED')[1] = 'false';
  h.context.runSetupFromMenu_();
  assert.deepEqual(h.folders, ['', 'new-storage']);
  assert.equal(h.uiCalls.filter(call => call[0] === 'prompt').length, 1);
  assert.equal(h.sheets.get('system_config').rows.find(row => row[0] === 'SYSTEM_ENABLED')[1], 'false');
});

test('空欄に見える数式やセルのメモがある領域を整理で削除しない', () => {
  const h = setupHarness();
  const initial = h.sheet('シート1');
  initial.getDataRange = () => ({ getValues: () => [['']], isBlank: () => true, getNotes: () => [['残すメモ']] });
  h.context.setupSystem_();
  assert.equal(h.sheets.has('シート1'), true);
  const artifact = h.sheets.get('artifacts');
  artifact.getMaxColumns = () => 12;
  artifact.deleteColumns = () => assert.fail('数式・メモがある余剰列を削除した');
  artifact.getRange = () => ({ isBlank: () => false, getNotes: () => [['']] });
  h.context.setupSystem_();
  artifact.getRange = () => ({ isBlank: () => true, getNotes: () => [['残すメモ']] });
  h.context.setupSystem_();
});

test('指定フォルダIDの不正・アクセス失敗時に自動作成やシート変更へ進まない', () => {
  for (const id of ['https://drive.google.com/drive/folders/id', 'not valid', {}]) {
    const h = setupHarness();
    assert.throws(() => h.context.setupSystem_(id), /フォルダID/);
    assert.equal(h.sheets.size, 0);
    assert.equal(h.folders.length, 0);
  }
  const h = setupHarness();
  h.context.DriveStore.getOrCreateStorageFolder = () => { throw new Error('保存先アクセス拒否'); };
  assert.throws(() => h.context.setupSystem_('unavailable'), /アクセス/);
  assert.equal(h.sheets.size, 0);
});

test('再実行で別の保存先に切り替えず、既存設定・台帳を維持する', () => {
  const h = setupHarness();
  h.context.setupSystem_();
  const before = JSON.stringify([...h.sheets].map(([name, value]) => [name, value.rows]));
  assert.throws(() => h.context.setupSystem_('other-folder'), /保存先|フォルダ/);
  assert.deepEqual(h.folders, ['']);
  assert.equal(JSON.stringify([...h.sheets].map(([name, value]) => [name, value.rows])), before);
});

test('空の初期シートと管理シートの未使用列を削除する', () => {
  const h = setupHarness();
  h.sheet('シート1');
  h.sheet('Sheet1');
  h.context.setupSystem_();
  assert.equal(h.sheets.has('シート1'), false);
  assert.equal(h.sheets.has('Sheet1'), false);
  assert.deepEqual([...h.sheets].map(([name, s]) => [name, s.getMaxColumns()]), [['system_config', 3], ['artifacts', 11], ['versions', 9], ['acl', 5], ['audit_log', 6]]);
});

test('初期シートや余剰列にデータがあれば削除しない', () => {
  const h = setupHarness();
  h.sheet('シート1').rows.push(['業務メモ']);
  h.sheet('独自シート');
  h.context.setupSystem_();
  const artifact = h.sheets.get('artifacts');
  // 利用者が末尾へ追加した列は再実行時にも保護する。
  artifact.getMaxColumns = () => 12;
  artifact.rows[0].push('メモ');
  artifact.deleteColumns = () => assert.fail('データがある余剰列を削除した');
  h.context.setupSystem_();
  assert.deepEqual(h.sheets.get('シート1').rows, [['業務メモ']]);
  assert.equal(h.sheets.has('独自シート'), true);
  assert.equal(artifact.rows[0][11], 'メモ');
});

test('シート準備失敗時は新規フォルダを作成しない', () => {
  const h = setupHarness();
  h.ss.insertSheet = () => { throw new Error('シート作成失敗'); };
  assert.throws(() => h.context.setupSystem_(), /シート作成失敗/);
  assert.deepEqual(h.folders, []);
});

test('新規保存先IDの記録失敗で未参照のフォルダを補償し、再実行可能にする', () => {
  const h = setupHarness();
  const config = h.sheet('system_config');
  const append = config.appendRow;
  config.appendRow = row => { if (row[0] === 'STORAGE_FOLDER_ID') throw new Error('設定書込み失敗'); return append(row); };
  assert.throws(() => h.context.setupSystem_(), /設定書込み失敗/);
  assert.deepEqual(h.trashedFolders, ['new-storage']);
  assert.equal(config.rows.some(row => row[0] === 'STORAGE_FOLDER_ID'), false);
  config.appendRow = append;
  assert.equal(h.context.setupSystem_().success, true);
});

test('設定IDが書き込まれた後の例外では参照されたフォルダを削除しない', () => {
  const h = setupHarness();
  const config = h.sheet('system_config');
  const append = config.appendRow;
  config.appendRow = row => { append(row); if (row[0] === 'STORAGE_FOLDER_ID') throw new Error('書込み後失敗'); };
  assert.throws(() => h.context.setupSystem_(), /書込み後失敗/);
  assert.deepEqual(h.trashedFolders, []);
  config.appendRow = append;
  h.context.setupSystem_();
  assert.deepEqual(h.folders, ['', 'new-storage']);
});
