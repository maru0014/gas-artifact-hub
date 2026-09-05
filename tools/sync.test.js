/**
 * tools/sync.test.js - Scanner.gs と scanner-rules.js の完全同期機械検査
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { SCANNER_RULES, scanHtml } = require('./scanner-rules.js');

test('src/Scanner.gs と tools/scanner-rules.js のルール定義が完全に一致している', () => {
  const scannerGsPath = path.join(__dirname, '..', 'src', 'Scanner.gs');
  const content = fs.readFileSync(scannerGsPath, 'utf8');

  // Scanner.gs 内の name: '...' を正規表現で抽出
  const matches = content.matchAll(/name:\s*['"]([A-Z0-9_]+)['"]/g);
  const gsRuleNames = Array.from(matches, m => m[1]);

  const jsRuleNames = SCANNER_RULES.map(r => r.name);

  assert.strictEqual(
    gsRuleNames.length,
    jsRuleNames.length,
    `ルール数が不一致です: Scanner.gs(${gsRuleNames.length}) vs scanner-rules.js(${jsRuleNames.length})`
  );

  for (let i = 0; i < jsRuleNames.length; i++) {
    assert.strictEqual(
      gsRuleNames[i],
      jsRuleNames[i],
      `ルール[${i}]の名前が不一致です: ${gsRuleNames[i]} vs ${jsRuleNames[i]}`
    );
  }
});

test('Scanner.gs と scanner-rules.js のスキャン結果オブジェクトがディープイコール（完全一致）する', () => {
  const scannerGsPath = path.join(__dirname, '..', 'src', 'Scanner.gs');
  const gsContent = fs.readFileSync(scannerGsPath, 'utf8');

  // Node.js vm コンテキスト内で Scanner.gs を実行
  const context = { console };
  vm.createContext(context);
  vm.runInContext(gsContent, context);
  const ScannerGs = context.Scanner;

  const testHtml = `<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap">
</head>
<body>
  <button onclick="window.open('https://help.example.com')">ヘルプ</button>
  <script>
    fetch("https://api.example.com/rates");
    localStorage.setItem("key", "val");
    eval("1 + 1");
  </script>
</body>
</html>`;

  const gsWarnings = ScannerGs.scan(testHtml);
  const jsWarnings = scanHtml(testHtml);

  // vm realm の差異を正規化してディープイコールを検証
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(gsWarnings)),
    jsWarnings,
    'Scanner.gs と scanner-rules.js のスキャン結果が完全一致すること'
  );
});

test('GAS本体 (src/Scanner.gs) に Node.js 依存 (require / import) が混入していないこと', () => {
  const scannerGsPath = path.join(__dirname, '..', 'src', 'Scanner.gs');
  const gsContent = fs.readFileSync(scannerGsPath, 'utf8');

  assert.strictEqual(/\brequire\s*\(/.test(gsContent), false, 'require() が含まれていないこと');
  assert.strictEqual(/^\s*import\s+/m.test(gsContent), false, 'import 文が含まれていないこと');
  assert.strictEqual(/\bmodule\.exports\b/.test(gsContent), false, 'module.exports が含まれていないこと');
});
