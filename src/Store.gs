/**
 * GAS Artifact Hub - Sheetsを正本とする認可・保存処理。
 * Sheets/Driveに原子的トランザクションはないため、失敗時は変更した範囲を補償する。
 */
var Store = (function () {
  function normalizeEmail_(value) {
    return String(value || '').trim().toLowerCase();
  }

  function dateValue_(value) {
    if (Object.prototype.toString.call(value) === '[object Date]') {
      return isNaN(value.getTime()) ? '' : value.toISOString();
    }
    return String(value == null ? '' : value);
  }

  // setValuesも先頭「=」を式として扱う。既存の先頭アポストロフィも往復で保持する。
  function literalCells_(rows) {
    return rows.map(function (row) {
      return row.map(function (value) {
        return typeof value === 'string' && /^[=']/.test(value) ? "'" + value : value;
      });
    });
  }

  function ensureRows_(sheet, lastRequiredRow) {
    const maxRows = sheet.getMaxRows();
    if (lastRequiredRow > maxRows) {
      // 物理行の拡張は業務データを破壊しないため、失敗時にも縮小しない。
      sheet.insertRowsAfter(maxRows, lastRequiredRow - maxRows);
    }
  }

  function withScriptLock_(callback) {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(Constants.LIMITS.LOCK_TIMEOUT_MS)) {
      throw new Error('サーバーが混み合っています。しばらく待ってから再試行してください。(LOCK_TIMEOUT)');
    }
    try { return callback(); } finally { lock.releaseLock(); }
  }

  function getSpreadsheet() {
    const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) throw new Error('セットアップが必要です。管理者に連絡してください。');
    return ss;
  }

  function requireSheet_(ss, name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) throw new Error('必要なシートがありません: ' + name + '。管理者に連絡してください。');
    return sheet;
  }

  function getSystemConfig(ss) {
    ss = ss || getSpreadsheet();
    const sheet = requireSheet_(ss, Constants.SHEETS.SYSTEM_CONFIG);
    const config = Object.create(null);
    const seen = Object.create(null);
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const key = String(data[i][0] || '').trim();
      if (!key) continue;
      if (seen[key]) throw new Error('システム設定のキーが重複しています: ' + key);
      seen[key] = true;
      config[key] = String(data[i][1] == null ? '' : data[i][1]).trim();
    }
    const required = [Constants.CONFIG_KEYS.SYSTEM_ENABLED, Constants.CONFIG_KEYS.STORAGE_FOLDER_ID,
      Constants.CONFIG_KEYS.ALLOWED_DOMAIN, Constants.CONFIG_KEYS.MAX_HTML_SIZE_KB];
    required.forEach(function (key) {
      if (!seen[key] || !config[key]) throw new Error('システム設定 ' + key + ' が未設定です。');
    });
    const enabled = config.SYSTEM_ENABLED.toLowerCase();
    if (enabled !== 'true' && enabled !== 'false') throw new Error('システム設定 SYSTEM_ENABLED が不正です。');
    config.SYSTEM_ENABLED = enabled;
    config.ALLOWED_DOMAIN = config.ALLOWED_DOMAIN.toLowerCase();
    if (!Constants.isValidDomain(config.ALLOWED_DOMAIN)) throw new Error('システム設定 ALLOWED_DOMAIN が不正です。');
    if (!/^[a-zA-Z0-9_-]+$/.test(config.STORAGE_FOLDER_ID)) throw new Error('システム設定 STORAGE_FOLDER_ID が不正です。');
    const maxHtmlSizeKb = Number(config.MAX_HTML_SIZE_KB);
    if (!Number.isFinite(maxHtmlSizeKb) || maxHtmlSizeKb <= 0) throw new Error('システム設定 MAX_HTML_SIZE_KB が不正です。');
    config.MAX_HTML_SIZE_KB = String(maxHtmlSizeKb);
    return config;
  }

  function canView(artifact, actorEmail, aclList) {
    const actor = normalizeEmail_(actorEmail);
    if (!artifact || artifact.status !== Constants.STATUS.ACTIVE || !actor) return false;
    if (normalizeEmail_(artifact.custodian) === actor) return true;
    if (artifact.visibility === Constants.VISIBILITY.PRIVATE) return false;
    if (artifact.visibility === Constants.VISIBILITY.ALL) return true;
    if (artifact.visibility !== Constants.VISIBILITY.LIST) return false;
    return (aclList || []).some(function (acl) {
      return normalizeEmail_(acl.email) === actor &&
        (acl.role === Constants.ROLES.EDITOR || acl.role === Constants.ROLES.VIEWER);
    });
  }

  function canEdit(artifact, actorEmail, aclList) {
    const actor = normalizeEmail_(actorEmail);
    if (!artifact || artifact.status !== Constants.STATUS.ACTIVE || !actor) return false;
    if (normalizeEmail_(artifact.custodian) === actor) return true;
    if (artifact.visibility !== Constants.VISIBILITY.ALL && artifact.visibility !== Constants.VISIBILITY.LIST) return false;
    return (aclList || []).some(function (acl) {
      return normalizeEmail_(acl.email) === actor && acl.role === Constants.ROLES.EDITOR;
    });
  }

  function artifactFromRow_(row, index) {
    return {
      rowIndex: index, artifact_id: String(row[0]), title: String(row[1] || ''), description: String(row[2] || ''),
      created_by: normalizeEmail_(row[3]), custodian: normalizeEmail_(row[4]), current_version_id: String(row[5] || ''),
      visibility: row[6], status: row[7], created_at: dateValue_(row[8]), updated_at: dateValue_(row[9]), deleted_at: dateValue_(row[10])
    };
  }

  function findArtifact(ss, artifactId) {
    const data = requireSheet_(ss, Constants.SHEETS.ARTIFACTS).getDataRange().getValues();
    for (let i = 1; i < data.length; i++) if (data[i][0] === artifactId) return artifactFromRow_(data[i], i + 1);
    return null;
  }

  function listVersions(ss, artifactId) {
    const data = requireSheet_(ss, Constants.SHEETS.VERSIONS).getDataRange().getValues();
    const list = [];
    for (let i = 1; i < data.length; i++) {
      if (data[i][1] !== artifactId) continue;
      let warnings;
      try {
        warnings = JSON.parse(data[i][6] || '[]');
        if (!Array.isArray(warnings)) throw new Error('invalid warnings');
      } catch (error) {
        warnings = [{ rule: 'SCAN_UNAVAILABLE', category: 'SCAN_NOTICE', line: 0, snippet: '', message: '保存済み検査結果を読み取れません。ソースを確認してください。' }];
      }
      list.push({
        version_id: String(data[i][0]), artifact_id: artifactId, version_num: Number(data[i][2]), drive_file_id: String(data[i][3]),
        sha256: String(data[i][4]), file_size: Number(data[i][5]), warnings: warnings,
        created_by: normalizeEmail_(data[i][7]), created_at: dateValue_(data[i][8]), change_note: String(data[i][9] || '')
      });
    }
    return list.sort(function (a, b) { return b.version_num - a.version_num; });
  }

  function aclIndex_(ss) {
    const data = requireSheet_(ss, Constants.SHEETS.ACL).getDataRange().getValues();
    const index = Object.create(null);
    for (let i = 1; i < data.length; i++) {
      if (!data[i][0]) continue;
      const id = String(data[i][0]);
      if (!index[id]) index[id] = [];
      index[id].push({ email: normalizeEmail_(data[i][1]), role: data[i][2], granted_by: normalizeEmail_(data[i][3]), granted_at: dateValue_(data[i][4]) });
    }
    return index;
  }

  function listAcl(ss, artifactId) { return aclIndex_(ss)[artifactId] || []; }

  function validateChangeNote_(value) {
    if (value == null) return '';
    if (typeof value !== 'string') throw new Error('更新メモの設定が不正です。');
    const note = value.trim();
    if (note.length > Constants.LIMITS.MAX_CHANGE_NOTE_LENGTH) throw new Error('更新メモは' + Constants.LIMITS.MAX_CHANGE_NOTE_LENGTH + '文字以内で入力してください。');
    return note;
  }

  function ensureVersionChangeNoteColumn_(sheet) {
    const legacyHeaders = ['version_id', 'artifact_id', 'version_num', 'drive_file_id', 'sha256', 'file_size', 'warnings_json', 'created_by', 'created_at'];
    const currentColumns = sheet.getMaxColumns();
    const headers = sheet.getRange(1, 1, 1, Math.min(10, currentColumns)).getValues()[0] || [];
    if (headers[9] === 'change_note') return;
    let occupiedUnknownColumn = false;
    if (currentColumns >= 10) {
      const reservedRange = sheet.getRange(1, 10, sheet.getMaxRows(), 1);
      occupiedUnknownColumn = reservedRange.getValues().some(function (row) { return row[0] !== undefined && row[0] !== null && row[0] !== ''; }) ||
        reservedRange.getFormulas().some(function (row) { return Boolean(row[0]); }) ||
        reservedRange.getNotes().some(function (row) { return Boolean(row[0]); });
    }
    if (legacyHeaders.some(function (header, index) { return headers[index] !== header; }) || (headers[9] && headers[9] !== 'change_note') || occupiedUnknownColumn) {
      throw new Error('versions のヘッダーが想定と異なります。バックアップを取り、列構成を確認してください。');
    }
    if (sheet.getMaxColumns() < 10) sheet.insertColumnsAfter(sheet.getMaxColumns(), 10 - sheet.getMaxColumns());
    sheet.getRange(1, 10).setValue('change_note');
  }

  /**
   * undoは書込みの前に登録し、サービスが「書込み後に例外」を返す場合も補償する。
   * 復元とflushを確認できた場合だけ、新規Driveファイルを削除する。
   */
  function mutate_(actorEmail, callback) {
    const actor = normalizeEmail_(actorEmail);
    if (!actor) throw new Error('ユーザーを識別できません。');
    return withScriptLock_(function () {
      const ss = getSpreadsheet();
      const config = getSystemConfig(ss);
      if (config.SYSTEM_ENABLED !== 'true') throw new Error('システムは現在停止中です。');
      requireSheet_(ss, Constants.SHEETS.AUDIT_LOG);
      const undo = [];
      const files = [];
      const tx = {
        ss: ss, config: config, actor: actor,
        setValues: function (sheet, row, col, values) {
          if (!values.length) return;
          ensureRows_(sheet, row + values.length - 1);
          const range = sheet.getRange(row, col, values.length, values[0].length);
          const previous = range.getValues();
          undo.push(function () { range.setValues(literalCells_(previous)); });
          range.setValues(literalCells_(values));
        },
        appendRows: function (sheet, values) {
          if (!values.length) return;
          tx.setValues(sheet, sheet.getLastRow() + 1, 1, values);
        },
        saveHtml: function (artifactId, versionNum, html) {
          if (!config.STORAGE_FOLDER_ID) throw new Error('保存フォルダが未設定です。セットアップを実行してください。');
          const folder = DriveStore.getOrCreateStorageFolder(config.STORAGE_FOLDER_ID);
          const result = DriveStore.saveHtml(folder, artifactId, versionNum, html);
          files.push(result.fileId);
          return result;
        },
        audit: function (action, artifactId, versionId, details) {
          Audit.log(ss, actor, action, artifactId, versionId, details, function (sheet, row) { tx.appendRows(sheet, [row]); });
        }
      };
      try {
        const result = callback(tx);
        SpreadsheetApp.flush();
        return result;
      } catch (error) {
        const failures = [];
        for (let i = undo.length - 1; i >= 0; i--) {
          try { undo[i](); } catch (rollbackError) { failures.push(rollbackError.message); }
        }
        try { SpreadsheetApp.flush(); } catch (flushError) { failures.push(flushError.message); }
        if (failures.length) {
          Logger.log('補償失敗。Driveファイルを保持: ' + files.join(',') + ' / ' + failures.join(';'));
          throw new Error('保存の復元に失敗しました。管理者による整合性確認が必要です。(ROLLBACK_FAILED)');
        }
        for (let i = 0; i < files.length; i++) {
          try { DriveStore.rollbackFile(files[i]); } catch (fileError) { failures.push(fileError.message); }
        }
        if (failures.length) throw new Error('データを復元しましたが不要ファイルの削除に失敗しました。管理者に連絡してください。(ROLLBACK_FAILED)');
        throw error;
      }
    });
  }

  function editableArtifact_(tx, artifactId) {
    const artifact = findArtifact(tx.ss, artifactId);
    if (!artifact || artifact.status !== Constants.STATUS.ACTIVE) throw new Error('指定されたアーティファクトが見つかりません。');
    if (!canEdit(artifact, tx.actor, listAcl(tx.ss, artifactId))) throw new Error('このアーティファクトを変更する権限がありません。');
    return artifact;
  }

  function normalizedAcl_(items, custodian) {
    const entries = Object.create(null);
    const owner = normalizeEmail_(custodian);
    (items || []).forEach(function (item) {
      const email = normalizeEmail_(item.email);
      if (!email || (item.role !== Constants.ROLES.EDITOR && item.role !== Constants.ROLES.VIEWER)) throw new Error('権限設定が不正です。');
      if (email === owner) return;
      entries[email] = { email: email, role: item.role };
    });
    const result = owner ? [{ email: owner, role: Constants.ROLES.EDITOR }] : [];
    return result.concat(Object.keys(entries).map(function (key) { return entries[key]; }));
  }

  function validateAclEntries_(items, config, custodian) {
    if (!Array.isArray(items)) throw new Error('メンバー設定が不正です。');
    if (items.length > Constants.LIMITS.MAX_ACL_MEMBERS + 1) {
      throw new Error('メンバーは管理責任者を除き' + Constants.LIMITS.MAX_ACL_MEMBERS + '人以内で指定してください。');
    }
    const domain = config.ALLOWED_DOMAIN;
    const owner = normalizeEmail_(custodian);
    const seen = Object.create(null);
    const normalized = items.map(function (item) {
      if (!item || typeof item.email !== 'string' || (item.role !== Constants.ROLES.EDITOR && item.role !== Constants.ROLES.VIEWER)) {
        throw new Error('メンバーの権限設定が不正です。');
      }
      const email = normalizeEmail_(item.email);
      if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || email.split('@')[1] !== domain) {
        throw new Error('メンバーのメール設定が不正です。');
      }
      if (seen[email]) throw new Error('メンバーのメール設定が重複しています。');
      seen[email] = true;
      return { email: email, role: item.role };
    });
    const memberCount = normalized.filter(function (entry) { return entry.email !== owner; }).length;
    if (memberCount > Constants.LIMITS.MAX_ACL_MEMBERS) {
      throw new Error('メンバーは管理責任者を除き' + Constants.LIMITS.MAX_ACL_MEMBERS + '人以内で指定してください。');
    }
    return normalizedAcl_(normalized, owner);
  }

  function aclMemberCount_(items, custodian) {
    const owner = normalizeEmail_(custodian);
    return normalizedAcl_(items, owner).filter(function (entry) { return entry.email !== owner; }).length;
  }

  function validateSettings_(title, description, visibility, items, config, custodian) {
    if (typeof title !== 'string' || (description != null && typeof description !== 'string')) throw new Error('タイトルと説明の設定が不正です。');
    const cleanTitle = title.trim();
    const cleanDescription = String(description || '').trim();
    if (!cleanTitle || cleanTitle.length > Constants.LIMITS.MAX_TITLE_LENGTH) throw new Error('タイトルの設定が不正です。');
    if (cleanDescription.length > Constants.LIMITS.MAX_DESC_LENGTH) throw new Error('説明の設定が不正です。');
    if (visibility !== Constants.VISIBILITY.ALL && visibility !== Constants.VISIBILITY.LIST && visibility !== Constants.VISIBILITY.PRIVATE) {
      throw new Error('公開範囲の設定が不正です。');
    }
    return { title: cleanTitle, description: cleanDescription, visibility: visibility,
      acls: validateAclEntries_(items, config, custodian) };
  }

  function replaceAcl_(tx, artifactId, entries) {
    const sheet = requireSheet_(tx.ss, Constants.SHEETS.ACL);
    const data = sheet.getDataRange().getValues();
    const now = new Date().toISOString();
    const rows = entries.map(function (entry) { return [artifactId, entry.email, entry.role, tx.actor, now]; });
    let next = 0;
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] !== artifactId) continue;
      tx.setValues(sheet, i + 1, 1, [rows[next++] || ['', '', '', '', '']]);
    }
    if (next < rows.length) tx.appendRows(sheet, rows.slice(next));
  }

  function updateMetadata_(tx, artifact, title, description, visibility) {
    const sheet = requireSheet_(tx.ss, Constants.SHEETS.ARTIFACTS);
    tx.setValues(sheet, artifact.rowIndex, 2, [[title, description || '']]);
    tx.setValues(sheet, artifact.rowIndex, 7, [[visibility]]);
    tx.setValues(sheet, artifact.rowIndex, 10, [[new Date().toISOString()]]);
  }

  function createArtifact(actorEmail, title, description, visibility, htmlContent, principals) {
    const warnings = Scanner.scan(htmlContent);
    return mutate_(actorEmail, function (tx) {
      const artifactId = Utilities.getUuid();
      const versionId = Utilities.getUuid();
      const now = new Date().toISOString();
      if (!Array.isArray(principals)) throw new Error('メンバー設定が不正です。');
      const acls = validateAclEntries_(principals.map(function (email) {
        return { email: email, role: Constants.ROLES.VIEWER };
      }), tx.config, tx.actor);
      const file = tx.saveHtml(artifactId, 1, htmlContent);
      tx.appendRows(requireSheet_(tx.ss, Constants.SHEETS.ARTIFACTS), [[artifactId, title, description || '', tx.actor, tx.actor, versionId, visibility || Constants.VISIBILITY.ALL, Constants.STATUS.ACTIVE, now, now, '']]);
      const versionSheet = requireSheet_(tx.ss, Constants.SHEETS.VERSIONS);
      ensureVersionChangeNoteColumn_(versionSheet);
      tx.appendRows(versionSheet, [[versionId, artifactId, 1, file.fileId, file.sha256, file.fileSize, JSON.stringify(warnings), tx.actor, now, '']]);
      tx.appendRows(requireSheet_(tx.ss, Constants.SHEETS.ACL), acls.map(function (acl) { return [artifactId, acl.email, acl.role, tx.actor, now]; }));
      tx.audit(Constants.ACTIONS.CREATE_ARTIFACT, artifactId, versionId, { title: title, visibility: visibility, warningCount: warnings.length });
      return { artifactId: artifactId, versionId: versionId, versionNum: 1 };
    });
  }

  function uploadVersion(actorEmail, artifactId, htmlContent, changeNote) {
    const note = validateChangeNote_(changeNote);
    const warnings = Scanner.scan(htmlContent);
    return mutate_(actorEmail, function (tx) {
      const artifact = editableArtifact_(tx, artifactId);
      const versions = listVersions(tx.ss, artifactId);
      const versionNum = versions.length ? versions[0].version_num + 1 : 1;
      const versionId = Utilities.getUuid();
      const now = new Date().toISOString();
      const file = tx.saveHtml(artifactId, versionNum, htmlContent);
      const versionSheet = requireSheet_(tx.ss, Constants.SHEETS.VERSIONS);
      ensureVersionChangeNoteColumn_(versionSheet);
      tx.appendRows(versionSheet, [[versionId, artifactId, versionNum, file.fileId, file.sha256, file.fileSize, JSON.stringify(warnings), tx.actor, now, note]]);
      const sheet = requireSheet_(tx.ss, Constants.SHEETS.ARTIFACTS);
      tx.setValues(sheet, artifact.rowIndex, 6, [[versionId]]);
      tx.setValues(sheet, artifact.rowIndex, 10, [[now]]);
      tx.audit(Constants.ACTIONS.UPLOAD_VERSION, artifactId, versionId, { versionNum: versionNum, warningCount: warnings.length, changeNote: note });
      return { artifactId: artifactId, versionId: versionId, versionNum: versionNum };
    });
  }

  function switchVersion(actorEmail, artifactId, targetVersionId) {
    return mutate_(actorEmail, function (tx) {
      const artifact = editableArtifact_(tx, artifactId);
      if (!listVersions(tx.ss, artifactId).some(function (version) { return version.version_id === targetVersionId; })) throw new Error('指定されたバージョンが存在しません。');
      const sheet = requireSheet_(tx.ss, Constants.SHEETS.ARTIFACTS);
      tx.setValues(sheet, artifact.rowIndex, 6, [[targetVersionId]]);
      tx.setValues(sheet, artifact.rowIndex, 10, [[new Date().toISOString()]]);
      tx.audit(Constants.ACTIONS.SWITCH_VERSION, artifactId, targetVersionId, { previousVersionId: artifact.current_version_id });
      return { success: true, currentVersionId: targetVersionId };
    });
  }

  function updateMetadata(actorEmail, artifactId, title, description, visibility) {
    return mutate_(actorEmail, function (tx) {
      const artifact = editableArtifact_(tx, artifactId);
      updateMetadata_(tx, artifact, title, description, visibility);
      tx.audit(Constants.ACTIONS.UPDATE_METADATA, artifactId, '', { title: title, visibility: visibility });
      return { success: true };
    });
  }

  function updateAcl(actorEmail, artifactId, targetEmail, role, isDelete) {
    return mutate_(actorEmail, function (tx) {
      const artifact = editableArtifact_(tx, artifactId);
      const target = normalizeEmail_(targetEmail);
      validateAclEntries_([{ email: target, role: isDelete ? Constants.ROLES.VIEWER : role }], tx.config, artifact.custodian);
      if (target === artifact.custodian && (isDelete || role !== Constants.ROLES.EDITOR)) throw new Error('管理責任者の編集権限は削除できません。');
      const current = listAcl(tx.ss, artifactId);
      const entries = current.filter(function (acl) { return acl.email !== target; });
      if (!isDelete) entries.push({ email: target, role: role });
      const finalEntries = normalizedAcl_(entries, artifact.custodian);
      const currentCount = aclMemberCount_(current, artifact.custodian);
      const finalCount = aclMemberCount_(finalEntries, artifact.custodian);
      if (finalCount > Constants.LIMITS.MAX_ACL_MEMBERS && !(isDelete && finalCount < currentCount)) {
        throw new Error('メンバーは管理責任者を除き' + Constants.LIMITS.MAX_ACL_MEMBERS + '人以内で指定してください。');
      }
      replaceAcl_(tx, artifactId, finalEntries);
      tx.audit(Constants.ACTIONS.UPDATE_ACL, artifactId, '', { targetUser: target, role: role, isDelete: !!isDelete });
      return { success: true };
    });
  }

  function saveArtifactSettings(actorEmail, artifactId, title, description, visibility, acls) {
    return mutate_(actorEmail, function (tx) {
      const artifact = editableArtifact_(tx, artifactId);
      const settings = validateSettings_(title, description, visibility, acls, tx.config, artifact.custodian);
      updateMetadata_(tx, artifact, settings.title, settings.description, settings.visibility);
      replaceAcl_(tx, artifactId, settings.acls);
      tx.audit(Constants.ACTIONS.UPDATE_METADATA, artifactId, '', { title: settings.title, visibility: settings.visibility });
      const aclSummary = { memberCount: aclMemberCount_(settings.acls, artifact.custodian), editorCount: 0, viewerCount: 0 };
      settings.acls.forEach(function (entry) {
        if (entry.email === artifact.custodian) return;
        if (entry.role === Constants.ROLES.EDITOR) aclSummary.editorCount++;
        else aclSummary.viewerCount++;
      });
      // ACLシートを正本とし、監査セルには50,000文字を超えない固定長要約だけを残す。
      tx.audit(Constants.ACTIONS.UPDATE_ACL, artifactId, '', aclSummary);
      return { success: true };
    });
  }

  function deleteArtifact(actorEmail, artifactId) {
    return mutate_(actorEmail, function (tx) {
      const artifact = editableArtifact_(tx, artifactId);
      const sheet = requireSheet_(tx.ss, Constants.SHEETS.ARTIFACTS);
      const now = new Date().toISOString();
      tx.setValues(sheet, artifact.rowIndex, 8, [[Constants.STATUS.DELETED]]);
      tx.setValues(sheet, artifact.rowIndex, 10, [[now, now]]);
      tx.audit(Constants.ACTIONS.DELETE_ARTIFACT, artifactId, '', {});
      return { success: true };
    });
  }

  function cachedHtml_(version) {
    const key = Constants.CACHE.PREFIX_HTML + version.version_id + '_' + version.sha256;
    let cache;
    try {
      cache = CacheService.getScriptCache();
      const cached = cache.get(key);
      if (cached !== null) return cached;
    } catch (error) { cache = null; }
    const html = DriveStore.readHtml(version.drive_file_id);
    // Sheet上のfile_sizeが手動変更されても、実際のUTF-8サイズで判定する。
    if (cache && Utilities.newBlob(html).getBytes().length <= Constants.CACHE.MAX_HTML_SIZE_BYTES) {
      try { cache.put(key, html, Constants.CACHE.TTL_SEC); } catch (error) { /* キャッシュは任意の高速化 */ }
    }
    return html;
  }

  function getArtifactForView(actorEmail, artifactId, specifiedVersionId) {
    // 正本の複数シートを同一ロック内で読み、設定保存の中間状態を返さない。
    const snapshot = withScriptLock_(function () {
      const ss = getSpreadsheet();
      const config = getSystemConfig(ss);
      if (config.SYSTEM_ENABLED !== 'true') return { error: 'SYSTEM_DISABLED', message: 'システムは現在停止中です。' };
      const artifact = findArtifact(ss, artifactId);
      if (!artifact || artifact.status !== Constants.STATUS.ACTIVE) return { error: 'NOT_FOUND', message: 'アーティファクトが見つかりません。' };
      const acls = listAcl(ss, artifactId);
      if (!canView(artifact, actorEmail, acls)) return { error: 'FORBIDDEN', message: 'このアーティファクトを閲覧する権限がありません。' };
      const versions = listVersions(ss, artifactId);
      const targetId = specifiedVersionId || artifact.current_version_id;
      const version = versions.filter(function (item) { return item.version_id === targetId; })[0];
      if (!version) return { error: specifiedVersionId ? 'VERSION_NOT_FOUND' : 'NO_VERSION', message: '指定された公開バージョンが見つかりません。' };
      return { artifact: artifact, acls: acls, versions: versions, version: version, config: config };
    });
    if (snapshot.error) return snapshot;
    const artifact = snapshot.artifact;
    const version = snapshot.version;
    const editor = canEdit(artifact, actorEmail, snapshot.acls);
    return {
      userEmail: normalizeEmail_(actorEmail),
      maxHtmlSizeKb: Number(snapshot.config.MAX_HTML_SIZE_KB) || Constants.LIMITS.DEFAULT_MAX_HTML_SIZE_KB,
      artifact: { artifactId: artifact.artifact_id, title: artifact.title, description: artifact.description,
        createdBy: artifact.created_by, custodian: artifact.custodian, currentVersionId: artifact.current_version_id,
        visibility: artifact.visibility, updatedAt: artifact.updated_at },
      currentVersion: { versionId: version.version_id, versionNum: version.version_num, sha256: version.sha256,
        fileSize: version.file_size, warnings: version.warnings, createdAt: version.created_at, changeNote: version.change_note },
      versions: snapshot.versions.map(function (item) {
        return { versionId: item.version_id, versionNum: item.version_num, sha256: item.sha256, fileSize: item.file_size,
          warningCount: item.warnings.length, createdBy: item.created_by, createdAt: item.created_at, changeNote: item.change_note };
      }),
      acls: editor ? snapshot.acls : [], isEditor: editor, isCustodian: normalizeEmail_(actorEmail) === artifact.custodian,
      rawHtml: cachedHtml_(version)
    };
  }

  function listVisibleArtifacts(actorEmail) {
    return withScriptLock_(function () {
      const ss = getSpreadsheet();
      if (getSystemConfig(ss).SYSTEM_ENABLED !== 'true') throw new Error('システムは現在停止中です。');
      const data = requireSheet_(ss, Constants.SHEETS.ARTIFACTS).getDataRange().getValues();
      const index = aclIndex_(ss);
      const actor = normalizeEmail_(actorEmail);
      const result = [];
      for (let i = 1; i < data.length; i++) {
        const artifact = artifactFromRow_(data[i], i + 1);
        const acls = index[artifact.artifact_id] || [];
        if (!canView(artifact, actor, acls)) continue;
        result.push({ artifactId: artifact.artifact_id, title: artifact.title, description: artifact.description,
          createdBy: artifact.created_by, custodian: artifact.custodian, visibility: artifact.visibility, updatedAt: artifact.updated_at,
          isMine: !!actor && artifact.created_by === actor, isEditor: canEdit(artifact, actor, acls), isCustodian: !!actor && artifact.custodian === actor });
      }
      return result.sort(function (a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt); });
    });
  }

  return {
    withScriptLock_: withScriptLock_, getSpreadsheet: getSpreadsheet, getSystemConfig: getSystemConfig,
    canView: canView, canEdit: canEdit, findArtifact: findArtifact, listVersions: listVersions, listAcl: listAcl,
    createArtifact: createArtifact, uploadVersion: uploadVersion, switchVersion: switchVersion,
    updateMetadata: updateMetadata, updateAcl: updateAcl, saveArtifactSettings: saveArtifactSettings,
    deleteArtifact: deleteArtifact, getArtifactForView: getArtifactForView, listVisibleArtifacts: listVisibleArtifacts
  };
})();
