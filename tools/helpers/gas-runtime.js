const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

/** 本番 .gs を実行し、外部のGASサービス境界だけを代替する。 */
function createRuntime(options = {}) {
  const tables = {
    system_config: [['key', 'value'], ['SYSTEM_ENABLED', 'true'], ['STORAGE_FOLDER_ID', 'folder'], ['ALLOWED_DOMAIN', 'example.com'], ['MAX_HTML_SIZE_KB', '1024']],
    artifacts: [['id', 'title', 'description', 'created_by', 'custodian', 'version', 'visibility', 'status', 'created_at', 'updated_at', 'deleted_at']],
    versions: [['version_id', 'artifact_id', 'version_num', 'drive_file_id', 'sha256', 'file_size', 'warnings_json', 'created_by', 'created_at', 'change_note']],
    acl: [['artifact', 'email', 'role', 'granted_by', 'granted_at']],
    audit_log: [['timestamp', 'user', 'action', 'artifact', 'version', 'details']]
  };
  const state = {
    tables, files: new Map(), cache: new Map(), writes: 0, reads: {}, flushes: 0,
    locked: false, failure: null, rollbackFailure: false, folderSearches: 0, logs: [],
    formulas: Object.fromEntries(Object.keys(tables).map(name => [name, []])),
    notes: Object.fromEntries(Object.keys(tables).map(name => [name, []])),
    maxRows: Object.fromEntries(Object.entries(tables).map(([name, data]) => [name, data.length])),
    maxColumns: Object.fromEntries(Object.entries(tables).map(([name, data]) => [name, Math.max(...data.map(row => row.length), 1)])),
    rowExpansions: [], rowExpansionFailure: null
  };
  let uuid = 0;
  function lastRow(data) {
    let length = data.length;
    while (length && data[length - 1].every(value => value === '' || value == null)) length--;
    return length;
  }
  function write(action) {
    state.writes++;
    const fail = state.failure && state.failure.at === state.writes;
    if (state.rollbackFailure && state.failureTriggered) throw new Error('rollback write failed');
    if (fail && state.failure.when !== 'after') { state.failureTriggered = true; throw new Error('injected write failure'); }
    action();
    if (fail) { state.failureTriggered = true; throw new Error('injected write failure'); }
  }
  function inputValue(value) {
    if (typeof value !== 'string') return value;
    if (value.length > 50000) throw new Error('Cell exceeds 50000 characters');
    if (value.startsWith("'")) return value.slice(1);
    if (value.startsWith('=')) return value === '=1+1' ? 2 : '#FORMULA';
    return value;
  }
  const sheets = {};
  for (const [name, data] of Object.entries(tables)) {
    const sheet = {
      getName: () => name,
      getLastRow: () => lastRow(data),
      getMaxRows: () => state.maxRows[name],
      getMaxColumns: () => state.maxColumns[name],
      getLastColumn: () => Math.max(...data.map(row => row.length), 0),
      getDataRange: () => ({ getValues: () => { state.reads[name] = (state.reads[name] || 0) + 1; return data.slice(0, lastRow(data)).map(row => row.slice()); } }),
      getRange: (row, col, height = 1, width = 1) => {
        if (row < 1 || height < 1 || row + height - 1 > state.maxRows[name]) {
          throw new Error(`Range exceeds physical rows: ${name} row ${row} height ${height} max ${state.maxRows[name]}`);
        }
        return ({
        getValues: () => Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, j) => data[row + i - 1]?.[col + j - 1] ?? '')),
        getFormulas: () => Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, j) => state.formulas[name][row + i - 1]?.[col + j - 1] || '')),
        getNotes: () => Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, j) => state.notes[name][row + i - 1]?.[col + j - 1] || '')),
        setValues: values => write(() => {
          values.forEach((cells, i) => cells.forEach((value, j) => {
            data[row + i - 1] ||= [];
            data[row + i - 1][col + j - 1] = inputValue(value);
          }));
        }),
        setValue: value => write(() => { data[row - 1] ||= []; data[row - 1][col - 1] = inputValue(value); }),
        clearContent: () => write(() => {
          for (let i = 0; i < height; i++) for (let j = 0; j < width; j++) {
            data[row + i - 1] ||= [];
            data[row + i - 1][col + j - 1] = '';
          }
        })
        });
      },
      insertRowsAfter: (afterPosition, howMany) => {
        if (!state.locked) throw new Error('row expansion outside lock');
        if (afterPosition < 1 || afterPosition > state.maxRows[name] || howMany < 1) throw new Error('Invalid row expansion');
        const failure = state.rowExpansionFailure;
        const shouldFail = failure && (!failure.sheet || failure.sheet === name);
        if (shouldFail && failure.when !== 'after') throw new Error(`injected row expansion failure: ${name}`);
        state.maxRows[name] += howMany;
        state.rowExpansions.push({ sheet: name, afterPosition, howMany });
        if (shouldFail) throw new Error(`injected row expansion failure: ${name}`);
      },
      insertColumnsAfter: (afterPosition, howMany) => {
        if (!state.locked) throw new Error('column expansion outside lock');
        if (afterPosition < 1 || afterPosition > state.maxColumns[name] || howMany < 1) throw new Error('Invalid column expansion');
        state.maxColumns[name] += howMany;
      },
      appendRow: values => write(() => { data[lastRow(data)] = values.map(inputValue); }),
      deleteRow: row => write(() => data.splice(row - 1, 1))
    };
    sheets[name] = sheet;
  }
  const spreadsheet = { getSheetByName: name => sheets[name] || null };
  function blob(content, mime, name) {
    return { getBytes: () => Array.from(Buffer.from(content, 'utf8')), getDataAsString: () => content, getName: () => name, content };
  }
  const folder = {
    getId: () => 'folder',
    createFile: data => {
      const id = `file-${state.files.size + 1}`;
      const file = { id, trashed: false, content: data.content,
        getId: () => id, getSize: () => { if (options.failFileSize) throw new Error('file size failed'); return Buffer.byteLength(data.content); },
        getBlob: () => blob(data.content), setTrashed: value => { if (options.failTrash) throw new Error('trash failed'); file.trashed = value; }
      };
      state.files.set(id, file);
      return file;
    }
  };
  const cache = {
    get: key => { if (options.failCache) throw new Error('cache unavailable'); return state.cache.get(key) || null; },
    put: (key, value) => { if (options.failCache) throw new Error('cache unavailable'); if (Buffer.byteLength(value) > 100 * 1024) throw new Error('Cache value too large'); state.cache.set(key, value); if (state.onCachePut) state.onCachePut(key); },
    remove: key => { if (options.failCache) throw new Error('cache unavailable'); state.cache.delete(key); }
  };
  const context = {
    console,
    Logger: { log: value => state.logs.push(value) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'spreadsheet' }) },
    SpreadsheetApp: { openById: () => spreadsheet, getActiveSpreadsheet: () => spreadsheet, flush: () => {
      if (!state.locked) throw new Error('flush outside lock');
      state.flushes++;
      if (state.failFlushAt === state.flushes) throw new Error('flush failed');
    } },
    CacheService: { getScriptCache: () => cache },
    LockService: { getScriptLock: () => ({ tryLock: () => { state.locked = true; return true; }, releaseLock: () => { state.locked = false; } }) },
    Utilities: { getUuid: () => `uuid-${++uuid}`, newBlob: blob, DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: (algorithm, content) => Array.from(crypto.createHash('sha256').update(content).digest()) },
    DriveApp: {
      getFolderById: () => { if (options.invalidFolder) throw new Error('folder missing'); return folder; },
      getFoldersByName: () => { state.folderSearches++; return { hasNext: () => true, next: () => folder }; },
      createFolder: () => folder,
      getFileById: id => { const file = state.files.get(id); if (!file || file.trashed) throw new Error('file missing'); return file; }
    }
  };
  vm.createContext(context);
  for (const filename of ['Constants.gs', 'Scanner.gs', 'DriveStore.gs', 'Audit.gs', 'Store.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'src', filename), 'utf8'), context, { filename });
  }
  function seed(visibility = 'list') {
    const html = '<h1>existing</h1>';
    const file = folder.createFile(blob(html));
    tables.artifacts.push(['artifact', 'Existing', '', 'former@example.com', 'owner@example.com', 'version', visibility, 'active', '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z', '']);
    tables.versions.push(['version', 'artifact', 1, file.id, 'sha', Buffer.byteLength(html), '[]', 'former@example.com', '2026-09-05T00:00:00.000Z']);
    tables.acl.push(['artifact', 'owner@example.com', 'editor', 'owner@example.com', '2026'], ['artifact', 'editor@example.com', 'editor', 'owner@example.com', '2026'], ['artifact', 'viewer@example.com', 'viewer', 'owner@example.com', '2026']);
    for (const [name, data] of Object.entries(tables)) state.maxRows[name] = Math.max(state.maxRows[name], data.length);
  }
  const snapshot = () => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(tables).map(([name, data]) => [name, data.slice(0, lastRow(data))]))));
  return { ...context, context, state, options, sheets, spreadsheet, seed, snapshot };
}

module.exports = { createRuntime };
