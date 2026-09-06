/** GAS Artifact Hub: HTML配信と認証・入力検証を行うRPC境界。 */
function doGet(e) {
  const parameters = (e && e.parameter) || {};
  const rawArtifactId = String(parameters.a || '');
  const rawVersionId = String(parameters.v || '');
  // 不正文字を削って別IDに変形せず、URL入力全体を有効・無効で判定する。
  const artifactId = /^[a-zA-Z0-9_-]{1,128}$/.test(rawArtifactId) ? rawArtifactId : '';
  const versionId = /^[a-zA-Z0-9_-]{1,128}$/.test(rawVersionId) ? rawVersionId : '';
  const template = HtmlService.createTemplateFromFile(artifactId ? 'Shell' : 'Upload');
  if (artifactId) {
    template.artifactId = artifactId;
    template.versionId = versionId;
  } else {
    // データ取得前に画面を返し、ブラウザでロード状態を表示する。
    template.initialBootstrapJson = 'null';
    template.initialArtifactsJson = 'null';
  }
  return template.evaluate().setTitle('GAS Artifact Hub')
    // Apps Script はHTMLテンプレート内の favicon link を無視するため、HtmlOutput に設定する。
    .setFaviconUrl('https://raw.githubusercontent.com/maru0014/gas-artifact-hub/9addfb4338e749a64b07925647d4d239af3debdf/assets/favicon.ico')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// 末尾の _ により google.script.run からの呼出しを禁止する。
function include_(filename) {
  if (!['UploadCss', 'UploadJs', 'ShellCss', 'ShellJs', 'ArtifactDialogsCss', 'ArtifactSettings', 'ArtifactVersionUpload'].includes(filename)) throw new Error('許可されていないテンプレートです。');
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getActorEmail_() {
  const user = Session.getActiveUser();
  // getEffectiveUser() は実行所有者なので本人識別の代替にしない。
  return String(user ? user.getEmail() : '').trim().toLowerCase();
}

function assertRequestAllowed_(email, config) {
  if (!email) throw new Error('利用者を識別できません。同じGoogle Workspaceのアカウントで開き、管理者に本人識別の確認を依頼してください。');
  const domain = String(config.ALLOWED_DOMAIN || '').trim().toLowerCase();
  if (!Constants.isValidDomain(domain)) throw new Error('許可ドメインが未設定または不正です。管理者にセットアップの確認を依頼してください。');
  validateMemberEmail_(email, domain);
  if (String(config.SYSTEM_ENABLED).toLowerCase() !== 'true') throw new Error('システムは現在メンテナンスまたは緊急停止中です。');
}

function runApi_(operation) {
  try {
    const email = getActorEmail_();
    const config = Store.getSystemConfig();
    assertRequestAllowed_(email, config);
    return { ok: true, data: operation(email, config) };
  } catch (error) {
    return { ok: false, error: error.message || '処理に失敗しました。管理者に連絡してください。' };
  }
}

function maxHtmlSizeKb_(config) {
  const value = Number(config.MAX_HTML_SIZE_KB || Constants.LIMITS.DEFAULT_MAX_HTML_SIZE_KB);
  if (!Number.isFinite(value) || value <= 0) throw new Error('HTMLサイズ上限の設定が不正です。');
  return value;
}

function buildConfigPayload_(config, email) {
  return { userEmail: email, systemEnabled: String(config.SYSTEM_ENABLED).toLowerCase() === 'true',
    maxHtmlSizeKb: maxHtmlSizeKb_(config), allowedDomain: String(config.ALLOWED_DOMAIN).trim().toLowerCase() };
}

function validateId_(value, optional) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error('アーティファクトまたはバージョンのIDが不正です。');
  return value;
}

function validateMetadata_(title, description, visibility) {
  if (typeof title !== 'string' || (description != null && typeof description !== 'string')) throw new Error('タイトルと説明は文字列で指定してください。');
  const cleanTitle = title.trim();
  const cleanDescription = (description || '').trim();
  if (!cleanTitle || cleanTitle.length > Constants.LIMITS.MAX_TITLE_LENGTH) throw new Error('タイトルは1〜' + Constants.LIMITS.MAX_TITLE_LENGTH + '文字で入力してください。');
  if (cleanDescription.length > Constants.LIMITS.MAX_DESC_LENGTH) throw new Error('説明は' + Constants.LIMITS.MAX_DESC_LENGTH + '文字以内で入力してください。');
  if (![Constants.VISIBILITY.ALL, Constants.VISIBILITY.LIST, Constants.VISIBILITY.PRIVATE].includes(visibility)) throw new Error('公開範囲が不正です。');
  return { title: cleanTitle, description: cleanDescription, visibility: visibility };
}

function validateMemberEmail_(value, allowedDomain) {
  if (typeof value !== 'string') throw new Error('メールアドレスは文字列で指定してください。');
  const email = value.trim().toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || email.length > 254) throw new Error('有効なメールアドレスを指定してください。');
  if (email.split('@')[1] !== String(allowedDomain).trim().toLowerCase()) throw new Error('許可されたGoogle Workspaceドメインのユーザーだけが利用できます。');
  return email;
}

function validateAcl_(acls, domain, custodian) {
  if (!Array.isArray(acls)) throw new Error('メンバーは一覧で指定してください。');
  const owner = custodian ? validateMemberEmail_(custodian, domain) : '';
  // 設定保存時はMain境界でcustodianを特定できないため、Storeで最終状態を厳密に検査する。
  // ここではcustodianが1人含まれ得る上限を超える入力を先に拒否する。
  if (acls.length > Constants.LIMITS.MAX_ACL_MEMBERS + 1) {
    throw new Error('メンバーは管理責任者を除き' + Constants.LIMITS.MAX_ACL_MEMBERS + '人以内の一覧で指定してください。');
  }
  const seen = new Set();
  const normalized = acls.map(entry => {
    if (!entry || ![Constants.ROLES.EDITOR, Constants.ROLES.VIEWER].includes(entry.role)) throw new Error('メンバーの権限が不正です。');
    const email = validateMemberEmail_(entry.email, domain);
    if (seen.has(email)) throw new Error('メンバーのメールアドレスが重複しています。');
    seen.add(email);
    return { email: email, role: entry.role };
  });
  const memberCount = normalized.filter(entry => entry.email !== owner).length;
  if (owner && memberCount > Constants.LIMITS.MAX_ACL_MEMBERS) {
    throw new Error('メンバーは管理責任者を除き' + Constants.LIMITS.MAX_ACL_MEMBERS + '人以内の一覧で指定してください。');
  }
  return normalized;
}

function validateHtml_(value, config) {
  if (typeof value !== 'string' || value.trim().length < 10) throw new Error('有効な単一HTMLを選択してください。');
  const byteSize = Utilities.newBlob(value).getBytes().length;
  const maxKb = maxHtmlSizeKb_(config);
  if (byteSize > maxKb * 1024) throw new Error('HTMLサイズが上限（' + maxKb + 'KB）を超えています。');
  return value;
}

function validateChangeNote_(value) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error('更新メモは文字列で指定してください。');
  const clean = value.trim();
  if (clean.length > Constants.LIMITS.MAX_CHANGE_NOTE_LENGTH) throw new Error('更新メモは' + Constants.LIMITS.MAX_CHANGE_NOTE_LENGTH + '文字以内で入力してください。');
  return clean;
}

function apiGetInitialData() {
  return runApi_((email, config) => ({ config: buildConfigPayload_(config, email), artifacts: Store.listVisibleArtifacts(email) }));
}
function apiBootstrap() {
  return runApi_((email, config) => buildConfigPayload_(config, email));
}
function apiListArtifacts() {
  return runApi_(email => Store.listVisibleArtifacts(email));
}
function apiGetArtifact(artifactId, versionId) {
  return runApi_(email => {
    const result = Store.getArtifactForView(email, validateId_(artifactId), validateId_(versionId, true));
    if (result.error) throw new Error(result.message || 'このアーティファクトを表示できません。');
    return result;
  });
}
function apiUploadArtifact(req) {
  return runApi_((email, config) => {
    if (!req || typeof req !== 'object' || Array.isArray(req)) throw new Error('投稿内容が不正です。');
    const metadata = validateMetadata_(req.title, req.description, req.visibility || Constants.VISIBILITY.ALL);
    const principals = req.principals == null ? [] : req.principals;
    if (!Array.isArray(principals)) throw new Error('メンバー一覧が不正です。');
    const acls = validateAcl_(principals.map(principal => ({ email: principal, role: Constants.ROLES.VIEWER })), config.ALLOWED_DOMAIN, email);
    return Store.createArtifact(email, metadata.title, metadata.description, metadata.visibility,
      validateHtml_(req.htmlContent, config), acls.map(entry => entry.email));
  });
}
function apiUploadVersion(artifactId, htmlContent, changeNote) {
  return runApi_((email, config) => Store.uploadVersion(email, validateId_(artifactId), validateHtml_(htmlContent, config), validateChangeNote_(changeNote)));
}
function apiSwitchVersion(artifactId, versionId) {
  return runApi_(email => Store.switchVersion(email, validateId_(artifactId), validateId_(versionId)));
}
function apiUpdateMetadata(artifactId, title, description, visibility) {
  return runApi_(email => {
    const metadata = validateMetadata_(title, description, visibility);
    return Store.updateMetadata(email, validateId_(artifactId), metadata.title, metadata.description, metadata.visibility);
  });
}
function apiSaveArtifactSettings(artifactId, title, description, visibility, acls) {
  return runApi_((email, config) => {
    const metadata = validateMetadata_(title, description, visibility);
    return Store.saveArtifactSettings(email, validateId_(artifactId), metadata.title, metadata.description,
      metadata.visibility, validateAcl_(acls, config.ALLOWED_DOMAIN));
  });
}
function apiUpdateAcl(artifactId, targetEmail, role, isDelete) {
  return runApi_((email, config) => {
    if (typeof isDelete !== 'boolean') throw new Error('権限変更の操作が不正です。');
    const target = validateMemberEmail_(targetEmail, config.ALLOWED_DOMAIN);
    if (!isDelete && ![Constants.ROLES.EDITOR, Constants.ROLES.VIEWER].includes(role)) throw new Error('権限ロールが不正です。');
    return Store.updateAcl(email, validateId_(artifactId), target, role, isDelete);
  });
}
function apiGetAcl(artifactId) {
  return runApi_(email => {
    const id = validateId_(artifactId);
    const ss = Store.getSpreadsheet();
    const artifact = Store.findArtifact(ss, id);
    const acls = Store.listAcl(ss, id);
    if (!Store.canEdit(artifact, email, acls)) throw new Error('メンバー一覧を閲覧する権限がありません。');
    return { acls: acls };
  });
}
function apiDeleteArtifact(artifactId) {
  return runApi_(email => Store.deleteArtifact(email, validateId_(artifactId)));
}
