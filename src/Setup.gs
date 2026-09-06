/** シートを開いたときはメニューだけを追加する。認証が必要な初期化は行わない。 */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('GAS Artifact Hub')
    .addItem('初回セットアップ', 'runSetupFromMenu_')
    .addToUi();
}

/** シートのメニュー専用。末尾の _ によりブラウザRPCには公開しない。 */
function runSetupFromMenu_() {
  const ui = SpreadsheetApp.getUi();
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(Constants.SHEETS.SYSTEM_CONFIG);
    const hasStorage = sheet && sheet.getDataRange().getValues().some(function (row) {
      return row[0] === Constants.CONFIG_KEYS.STORAGE_FOLDER_ID && String(row[1] || '').trim();
    });
    let folderId = '';
    if (hasStorage) {
      if (ui.alert('セットアップ済みです', '既存の保存先・設定・データを保持して、空の初期シートと未使用列を整理します。続けますか？', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
    } else {
      const response = ui.prompt('初回セットアップ',
        'HTMLの保存先として使う専用フォルダのIDを入力してください（URLではなくID）。一般社員に直接共有していないフォルダを指定してください。\n空欄の場合は、マイドライブ直下に GAS-Artifact-Hub-Storage フォルダを作成します。',
        ui.ButtonSet.OK_CANCEL);
      if (response.getSelectedButton() !== ui.Button.OK) return;
      folderId = response.getResponseText().trim();
    }
    // prompt/alertは実行を中断するため、対話を終えてからロックを取得する。
    const result = setupSystem_(folderId);
    ui.alert('セットアップ完了', '管理用の5シートを準備しました。\n保存先フォルダID: ' + result.folderId +
      '\n次に、拡張機能 → Apps Script → デプロイからWebアプリを作成してください。実行ユーザーは「自分」、アクセスは「組織内」に設定します。', ui.ButtonSet.OK);
  } catch (error) {
    ui.alert('セットアップできませんでした', String(error.message || error), ui.ButtonSet.OK);
  }
}

/** 初回設定の本体。対話を含めず、ブラウザRPCには公開しない。 */
function setupSystem_(storageFolderId) {
  if (storageFolderId !== undefined && typeof storageFolderId !== 'string') throw new Error('保存先フォルダIDは文字列で入力してください。');
  const requestedFolderId = (storageFolderId || '').trim();
  if (requestedFolderId && !/^[a-zA-Z0-9_-]+$/.test(requestedFolderId)) throw new Error('保存先フォルダIDが不正です。URLではなくフォルダIDだけを入力してください。');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('スプレッドシートの「拡張機能 → Apps Script」から実行してください。');
  const email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  const domain = email.split('@')[1] || '';
  if (!/^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || !Constants.isValidDomain(domain) || ['gmail.com', 'googlemail.com'].includes(domain)) {
    throw new Error('Google Workspaceの管理者アカウントを識別できません。');
  }
  const definitions = [
    { name: Constants.SHEETS.SYSTEM_CONFIG, headers: ['key', 'value', 'description'] },
    { name: Constants.SHEETS.ARTIFACTS, headers: ['artifact_id', 'title', 'description', 'created_by', 'custodian', 'current_version_id', 'visibility', 'status', 'created_at', 'updated_at', 'deleted_at'] },
    { name: Constants.SHEETS.VERSIONS, headers: ['version_id', 'artifact_id', 'version_num', 'drive_file_id', 'sha256', 'file_size', 'warnings_json', 'created_by', 'created_at'] },
    { name: Constants.SHEETS.ACL, headers: ['artifact_id', 'email', 'role', 'granted_by', 'granted_at'] },
    { name: Constants.SHEETS.AUDIT_LOG, headers: ['timestamp', 'user', 'action', 'artifact_id', 'version_id', 'details'] }
  ];
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(Constants.LIMITS.LOCK_TIMEOUT_MS)) throw new Error('他の処理が実行中です。しばらく待ってから再実行してください。');
  try {
    // 既存データを初期化し直さない。列構成が違う場合は変更前に停止する。
    for (const definition of definitions) {
      const sheet = ss.getSheetByName(definition.name);
      if (sheet && sheet.getLastRow() > 0) {
        const headers = sheet.getDataRange().getValues()[0];
        if (definition.headers.some((header, index) => headers[index] !== header)) {
          throw new Error(definition.name + ' のヘッダーが想定と異なります。バックアップを取り、列構成を確認してください。');
        }
      }
    }
    const config = Object.create(null);
    const existingConfig = ss.getSheetByName(Constants.SHEETS.SYSTEM_CONFIG);
    if (existingConfig && existingConfig.getLastRow() > 0) {
      for (const row of existingConfig.getDataRange().getValues().slice(1)) {
        const key = String(row[0] || '').trim();
        if (!key) continue;
        if (Object.prototype.hasOwnProperty.call(config, key)) throw new Error('システム設定のキーが重複しています: ' + key);
        config[key] = String(row[1] == null ? '' : row[1]).trim();
      }
    }
    Object.keys(config).forEach(function (key) {
      if (!config[key]) throw new Error(key + ' が空欄です。設定を確認して再実行してください。');
    });
    if (config.ALLOWED_DOMAIN && config.ALLOWED_DOMAIN.toLowerCase() !== domain) {
      throw new Error('許可ドメインが実行アカウントと異なります。導入先Google Workspaceと設定を確認してください。');
    }
    const artifactSheet = ss.getSheetByName(Constants.SHEETS.ARTIFACTS);
    if (!config.STORAGE_FOLDER_ID && artifactSheet && artifactSheet.getLastRow() > 1) {
      throw new Error('既存データの保存フォルダ設定がありません。新規作成せず、バックアップから設定を復旧してください。');
    }
    if (config.STORAGE_FOLDER_ID && requestedFolderId && config.STORAGE_FOLDER_ID !== requestedFolderId) {
      throw new Error('セットアップ済みの保存先フォルダは変更できません。既存の保存先を維持して再実行してください。');
    }
    // 指定先へのアクセス失敗では、自動作成やシート変更へ進まない。
    const existingFolderId = config.STORAGE_FOLDER_ID || requestedFolderId;
    let folder = existingFolderId ? DriveStore.getOrCreateStorageFolder(existingFolderId) : null;
    for (const definition of definitions) {
      const sheet = ss.getSheetByName(definition.name) || ss.insertSheet(definition.name);
      if (sheet.getLastRow() === 0) {
        sheet.appendRow(definition.headers);
        sheet.getRange(1, 1, 1, definition.headers.length).setFontWeight('bold').setBackground('#1e293b').setFontColor('#f8fafc');
        sheet.setFrozenRows(1);
      }
    }
    // 定義外のデータ・数式・メモを残し、空の余剰列だけを削除する。
    for (const definition of definitions) {
      const sheet = ss.getSheetByName(definition.name);
      const extraColumns = sheet.getMaxColumns() - definition.headers.length;
      if (extraColumns > 0) {
        const extra = sheet.getRange(1, definition.headers.length + 1, sheet.getMaxRows(), extraColumns);
        if (extra.isBlank() && extra.getNotes().every(function (row) { return row.every(function (note) { return !note; }); })) {
          sheet.deleteColumns(definition.headers.length + 1, extraColumns);
        }
      }
    }
    ['シート1', 'Sheet1'].forEach(function (name) {
      const sheet = ss.getSheetByName(name);
      if (!sheet) return;
      const range = sheet.getDataRange();
      if (range.isBlank() && range.getNotes().every(function (row) { return row.every(function (note) { return !note; }); })) ss.deleteSheet(sheet);
    });
    // シート準備を完了してから新規フォルダを作成し、保存先を最初に記録する。
    SpreadsheetApp.flush();
    const createdFolder = !folder;
    if (!folder) folder = DriveStore.getOrCreateStorageFolder();
    const folderId = folder.getId();
    const configSheet = ss.getSheetByName(Constants.SHEETS.SYSTEM_CONFIG);
    if (!config.STORAGE_FOLDER_ID) {
      try {
        configSheet.appendRow([Constants.CONFIG_KEYS.STORAGE_FOLDER_ID, folderId, 'HTML保存先。利用者へ直接共有しない']);
        SpreadsheetApp.flush();
      } catch (error) {
        if (createdFolder) {
          try {
            // 書込み後に例外になった場合は、参照済みフォルダを削除しない。
            const referenced = configSheet.getDataRange().getValues().some(function (row) {
              return row[0] === Constants.CONFIG_KEYS.STORAGE_FOLDER_ID && String(row[1]) === folderId;
            });
            if (!referenced) folder.setTrashed(true);
          } catch (rollbackError) {
            throw new Error('ROLLBACK_FAILED: 保存先フォルダの状態を確認してください。ID: ' + folderId + ' / ' + String(error.message || error));
          }
        }
        throw error;
      }
    }
    const initialRows = [
      [Constants.CONFIG_KEYS.SYSTEM_ENABLED, 'true', 'true: 稼働、false: 新しい読込・API操作を停止'],
      [Constants.CONFIG_KEYS.ALLOWED_DOMAIN, domain, '同一Google Workspaceの許可ドメイン'],
      [Constants.CONFIG_KEYS.MAX_HTML_SIZE_KB, String(Constants.LIMITS.DEFAULT_MAX_HTML_SIZE_KB), 'HTMLのUTF-8サイズ上限（KB）']
    ];
    for (const row of initialRows) {
      if (!Object.prototype.hasOwnProperty.call(config, row[0])) configSheet.appendRow(row);
    }
    PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
    Logger.log('セットアップ完了。DOMAIN / USER_DEPLOYINGでデプロイし、別の一般社員アカウントで本人識別と権限を確認してください。');
    return { success: true, spreadsheetId: ss.getId(), folderId: folder.getId() };
  } finally {
    try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); }
  }
}
