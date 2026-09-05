/**
 * GAS Artifact Hub - 監査ログ処理 (Audit.gs)
 * 変更系操作 (作成, バージョン追加, 版切替, メタデータ変更, ACL変更, 論理削除) を記録する。
 * ※閲覧ログはMVPでは記録しない (性能・クォータ考慮)。
 */

var Audit = (function () {
  function log(ss, userEmail, action, artifactId, versionId, details, appendRow) {
      var sheet = ss.getSheetByName(Constants.SHEETS.AUDIT_LOG);
      if (!sheet) throw new Error('監査ログシート audit_log がありません。');

      var detailsStr = typeof details === 'object' ? JSON.stringify(details) : (details || '');

      var row = [
        new Date().toISOString(),
        userEmail || 'unknown',
        action,
        artifactId || '',
        versionId || '',
        detailsStr
      ];
      if (appendRow) appendRow(sheet, row);
      else sheet.appendRow(row.map(function (value) {
        return typeof value === 'string' && /^[=']/.test(value) ? "'" + value : value;
      }));
  }

  return {
    log: log
  };
})();
