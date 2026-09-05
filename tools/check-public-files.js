/** Git公開対象（追跡済み＋未ignoreの新規ファイル）の漏出防止補助。値は出力しない。 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root });
const files = [...new Set(output.toString('utf8').split('\0').filter(Boolean))];
const findings = [];
const forbidden = /(^|\/)(?:\.clasp\.json|\.clasprc[^/]*\.json|\.env(?:\.(?!example$)[^/]+)?|(?:notion_page|planning_review|previous_project)_dump\.[^/]+|\.review_prompt_[^/]+|id_rsa|id_ed25519|credentials\.json)$/i;
const outputDirs = /^(?:node_modules|reports|test-results|playwright-report|coverage)\//;
const secretRules = [
  ['Google APIキー形式', /AIza[0-9A-Za-z_-]{35}/],
  ['GitHubトークン形式', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['秘密鍵', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['OAuth資格情報の値', /["'](?:refresh_token|access_token|client_secret)["']\s*:\s*["'][A-Za-z0-9._~+\/-]{20,}["']/]
];

for (const file of files) {
  const fullPath = path.join(root, file);
  if (!fs.existsSync(fullPath)) continue;
  if (forbidden.test(file) || outputDirs.test(file)) findings.push([file, '公開不要ファイル']);
  if (!/\.(?:gs|js|html|css|json|md|ya?ml|txt|toml|env|pem|key)$/i.test(file) && !/^(?:LICENSE|\.gitignore|\.claspignore)$/.test(file)) continue;
  const source = fs.readFileSync(fullPath, 'utf8');
  for (const [category, pattern] of secretRules) if (pattern.test(source)) findings.push([file, category]);
}
if (findings.length) {
  for (const [file, category] of findings) console.error(`[FAIL] ${file}: ${category}`);
  process.exitCode = 1;
} else {
  console.log(`[PASS] 公開対象 ${files.length} ファイルに禁止ファイル・既知の資格情報形式の検出なし。`);
  console.log('Git履歴・未知の秘密形式・文書の公開可否は別途レビューが必要です。');
}
