/**
 * GAS Artifact Hub - Driveストレージ操作 (DriveStore.gs)
 * 専用フォルダ配下でのHTML実体ファイルの保存・読み取り・ロールバックを行う。
 */

var DriveStore = (function () {
  /**
   * 専用ストレージフォルダの取得または作成
   */
  function getOrCreateStorageFolder(folderId) {
    if (folderId) {
      try {
        return DriveApp.getFolderById(folderId);
      } catch (e) {
        throw new Error('設定済みの保存フォルダにアクセスできません。管理者にフォルダIDと権限の確認を依頼してください。');
      }
    }

    // 初回セットアップだけが空IDを渡す。同名の共有フォルダを誤採用しない。
    return DriveApp.createFolder(Constants.STORAGE_FOLDER_NAME);
  }

  /**
   * HTML実体ファイルを保存
   */
  function saveHtml(folder, artifactId, versionNum, htmlContent) {
    var fileName = artifactId + '_v' + versionNum + '.html';
    var blob = Utilities.newBlob(htmlContent, 'text/html; charset=UTF-8', fileName);
    // SHA-256 ハッシュ計算
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, htmlContent, Utilities.Charset.UTF_8);
    var hashHex = digest.map(function (byte) {
      var v = (byte < 0 ? byte + 256 : byte).toString(16);
      return v.length === 1 ? '0' + v : v;
    }).join('');

    var file = folder.createFile(blob);
    try {
      return { fileId: file.getId(), fileSize: file.getSize(), sha256: hashHex };
    } catch (err) {
      try { file.setTrashed(true); } catch (cleanupError) {
        Logger.log('Drive保存後の復元失敗: ' + cleanupError.message);
        throw new Error('保存に失敗し、不要ファイルを削除できませんでした。管理者に連絡してください。(ROLLBACK_FAILED)');
      }
      throw err;
    }
  }

  /**
   * HTML実体ファイルを読み取り (UTF-8明示)
   */
  function readHtml(fileId) {
    var file = DriveApp.getFileById(fileId);
    return file.getBlob().getDataAsString('UTF-8');
  }

  /**
   * 失敗時のロールバック (孤児ファイルの削除)
   */
  function rollbackFile(fileId) {
    if (!fileId) return;
    try {
      var file = DriveApp.getFileById(fileId);
      file.setTrashed(true);
      Logger.log('ロールバック実行: ファイルをゴミ箱に移動しました ' + fileId);
    } catch (err) {
      Logger.log('ロールバック失敗 (ファイル削除不可): ' + err.message);
      throw err;
    }
  }

  return {
    getOrCreateStorageFolder: getOrCreateStorageFolder,
    saveHtml: saveHtml,
    readHtml: readHtml,
    rollbackFile: rollbackFile
  };
})();
