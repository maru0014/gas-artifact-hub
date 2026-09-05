/** 初回設定。Apps Scriptエディタから実行し、ブラウザRPCには公開しない。 */
function setupSystem_() {
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
    for (const definition of definitions) {
      const sheet = ss.getSheetByName(definition.name) || ss.insertSheet(definition.name);
      if (sheet.getLastRow() === 0) {
        sheet.appendRow(definition.headers);
        sheet.getRange(1, 1, 1, definition.headers.length).setFontWeight('bold').setBackground('#1e293b').setFontColor('#f8fafc');
        sheet.setFrozenRows(1);
      }
    }
    const folder = DriveStore.getOrCreateStorageFolder(config.STORAGE_FOLDER_ID || '');
    const initialRows = [
      [Constants.CONFIG_KEYS.SYSTEM_ENABLED, 'true', 'true: 稼働、false: 新しい読込・API操作を停止'],
      [Constants.CONFIG_KEYS.STORAGE_FOLDER_ID, folder.getId(), 'HTML保存先。利用者へ直接共有しない'],
      [Constants.CONFIG_KEYS.ALLOWED_DOMAIN, domain, '同一Google Workspaceの許可ドメイン'],
      [Constants.CONFIG_KEYS.MAX_HTML_SIZE_KB, String(Constants.LIMITS.DEFAULT_MAX_HTML_SIZE_KB), 'HTMLのUTF-8サイズ上限（KB）']
    ];
    const configSheet = ss.getSheetByName(Constants.SHEETS.SYSTEM_CONFIG);
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
