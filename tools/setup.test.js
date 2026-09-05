const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setupHarness(email = 'admin@example.com') {
  const sheets = new Map();
  const folders = [];
  const properties = {};
  let flushed = false;
  let released = false;
  function sheet(name) {
    const rows = [];
    const style = { setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; } };
    const result = {
      rows, getLastRow: () => rows.length,
      getDataRange: () => ({ getValues: () => rows.map(row => [...row]) }),
      appendRow(row) { rows.push([...row]); return result; },
      getRange: () => style, setFrozenRows() {}
    };
    sheets.set(name, result);
    return result;
  }
  const ss = { getId: () => 'db-local', getSheetByName: name => sheets.get(name), insertSheet: sheet };
  const context = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() { flushed = true; } },
    Session: { getActiveUser: () => ({ getEmail: () => email }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key], setProperty(key, value) { properties[key] = value; } }) },
    DriveStore: { getOrCreateStorageFolder(id) { folders.push(id || ''); return { getId: () => id || 'new-storage' }; } },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() { released = true; assert.equal(flushed, true); } }) },
    Logger: { log() {} }
  });
  for (const filename of ['Constants.gs', 'Setup.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', filename), 'utf8'), context, { filename });
  }
  return { context, sheets, folders, properties, sheet, status: () => ({ flushed, released }) };
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
