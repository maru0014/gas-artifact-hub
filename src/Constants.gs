/**
 * GAS Artifact Hub - 定数定義 (Constants.gs)
 */

var Constants = (function () {
  function isValidDomain(value) {
    var domain = String(value || '').trim().toLowerCase();
    var labels = domain.split('.');
    if (domain.length > 253 || labels.length < 2 || labels[labels.length - 1].length < 2) return false;
    return labels.every(function (label) {
      return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
    });
  }

  return {
    isValidDomain: isValidDomain,
    // スプレッドシート各シート名
    SHEETS: {
      SYSTEM_CONFIG: 'system_config',
      ARTIFACTS: 'artifacts',
      VERSIONS: 'versions',
      ACL: 'acl',
      AUDIT_LOG: 'audit_log'
    },

    // 権限ロール
    ROLES: {
      EDITOR: 'editor',
      VIEWER: 'viewer'
    },

    // 公開範囲
    VISIBILITY: {
      ALL: 'all',         // 組織全体
      LIST: 'list',       // 特定ユーザー (ACL参照)
      PRIVATE: 'private'  // 自分だけ (作成者・Custodianのみ)
    },

    // アーティファクト状態
    STATUS: {
      ACTIVE: 'active',     // 正常稼働
      DISABLED: 'disabled', // 緊急停止
      DELETED: 'deleted'    // 論理削除
    },

    // 変更系監査ログアクション
    ACTIONS: {
      CREATE_ARTIFACT: 'CREATE_ARTIFACT',
      UPLOAD_VERSION: 'UPLOAD_VERSION',
      SWITCH_VERSION: 'SWITCH_VERSION',
      UPDATE_METADATA: 'UPDATE_METADATA',
      UPDATE_ACL: 'UPDATE_ACL',
      DELETE_ARTIFACT: 'DELETE_ARTIFACT'
    },

    // システム設定キー名
    CONFIG_KEYS: {
      SYSTEM_ENABLED: 'SYSTEM_ENABLED',
      STORAGE_FOLDER_ID: 'STORAGE_FOLDER_ID',
      ALLOWED_DOMAIN: 'ALLOWED_DOMAIN',
      MAX_HTML_SIZE_KB: 'MAX_HTML_SIZE_KB'
    },

    // キャッシュ関連定数
    CACHE: {
      TTL_SEC: 600,                     // 10分
      MAX_HTML_SIZE_BYTES: 90 * 1024,   // 90KB (CacheService 100KB上限に対する安全マージン)
      PREFIX_META: 'meta_',
      PREFIX_HTML: 'html_'
    },

    // 制限値
    LIMITS: {
      DEFAULT_MAX_HTML_SIZE_KB: 1024,    // 1MB
      MAX_TITLE_LENGTH: 100,
      MAX_DESC_LENGTH: 200,
      MAX_CHANGE_NOTE_LENGTH: 500,
      MAX_ACL_MEMBERS: 200,              // 管理責任者を除く正規化済み一意ユーザー数
      LOCK_TIMEOUT_MS: 30000            // 30秒
    },

    // Google Drive専用フォルダ名
    STORAGE_FOLDER_NAME: 'GAS-Artifact-Hub-Storage'
  };
})();
