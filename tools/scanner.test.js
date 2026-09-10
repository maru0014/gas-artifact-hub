/**
 * tools/scanner.test.js - 静的検査の単体テスト
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { scanHtml, SCANNER_RULES, KNOWN_CDNS } = require('./scanner-rules.js');

const scannerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'Scanner.gs'), 'utf8');

function scanProductionInVm(html, timeout = 2000) {
  const context = { html };
  vm.createContext(context);
  vm.runInContext(scannerSource, context);
  return JSON.parse(JSON.stringify(vm.runInContext('Scanner.scan(html)', context, { timeout })));
}

test('安全な単一HTMLでは警告が0件である', () => {
  const safeHtml = `<!DOCTYPE html>
<html>
<head>
  <style>body { font-family: sans-serif; color: #333; }</style>
</head>
<body>
  <h1>カウンター</h1>
  <button id="btn">0</button>
  <script>
    let count = 0;
    document.getElementById('btn').addEventListener('click', () => {
      count++;
      document.getElementById('btn').textContent = count;
    });
  </script>
</body>
</html>`;

  const warnings = scanHtml(safeHtml);
  assert.strictEqual(warnings.length, 0);
});

test('NETWORK カテゴリ: fetch / XMLHttpRequest / WebSocket を検出する', () => {
  const html = `<!DOCTYPE html>
<html>
<body>
  <script>
    fetch("https://api.example.com/data");
    const xhr = new XMLHttpRequest();
    const ws = new WebSocket("wss://stream.example.com");
  </script>
</body>
</html>`;

  const warnings = scanHtml(html);
  assert.strictEqual(warnings.length, 3);
  assert.strictEqual(warnings[0].rule, 'NETWORK_FETCH');
  assert.strictEqual(warnings[0].url, 'https://api.example.com/data');
  assert.strictEqual(warnings[1].rule, 'NETWORK_XHR');
  assert.strictEqual(warnings[2].rule, 'NETWORK_WEBSOCKET');
});

test('EXTERNAL_TAG カテゴリ: 外部スクリプト・スタイル・画像を検出しURLと属性を抽出する', () => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="https://cdn.example.com/app.css">
  <script src="https://cdn.example.com/lib.js"></script>
</head>
<body>
  <img src="https://images.example.com/photo.png">
</body>
</html>`;

  const warnings = scanHtml(html);
  assert.strictEqual(warnings.length, 3);
  assert.strictEqual(warnings[0].rule, 'TAG_EXTERNAL_URL_ATTR');
  assert.strictEqual(warnings[0].attribute, 'href');
  assert.strictEqual(warnings[0].url, 'https://cdn.example.com/app.css');
  assert.ok(warnings[0].message.includes('https://cdn.example.com/app.css'));

  assert.strictEqual(warnings[1].rule, 'TAG_EXTERNAL_URL_ATTR');
  assert.strictEqual(warnings[1].attribute, 'src');
  assert.strictEqual(warnings[1].url, 'https://cdn.example.com/lib.js');
  assert.ok(warnings[1].message.includes('https://cdn.example.com/lib.js'));

  assert.strictEqual(warnings[2].rule, 'TAG_EXTERNAL_URL_ATTR');
  assert.strictEqual(warnings[2].attribute, 'src');
  assert.strictEqual(warnings[2].url, 'https://images.example.com/photo.png');
});

test('著名CDNメタデータ: Tailwind CSS や Google Fonts を公式配信として識別する', () => {
  const html = `<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">
</head>
</html>`;

  const warnings = scanHtml(html);
  assert.strictEqual(warnings.length, 2);
  assert.ok(warnings[0].cdnMeta, 'TailwindのCDNメタデータが存在すること');
  assert.strictEqual(warnings[0].cdnMeta.name, 'Tailwind CSS');
  assert.strictEqual(warnings[0].cdnMeta.isExecutableScript, true);

  assert.ok(warnings[1].cdnMeta, 'Google FontsのCDNメタデータが存在すること');
  assert.strictEqual(warnings[1].cdnMeta.name, 'Google Fonts');
  assert.strictEqual(warnings[1].cdnMeta.isExecutableScript, false);
});

test('長大クエリパラメータの安全短縮: 70文字超のURLはクエリ以降が短縮される', () => {
  const longUrl = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+JP:wght@400;500;700&display=swap';
  const html = `<link href="${longUrl}" rel="stylesheet">`;

  const warnings = scanHtml(html);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].url, 'https://fonts.googleapis.com/css2?...');
  assert.strictEqual(warnings[0].fullUrl, longUrl);
});

test('プロトコル相対URL: //cdn.example.com/lib.js を確実に検出し、著名CDNも識別する', () => {
  const html = `<script src="//cdn.tailwindcss.com"></script>`;
  const warnings = scanHtml(html);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].url, '//cdn.tailwindcss.com');
  assert.strictEqual(warnings[0].attribute, 'src');
  assert.ok(warnings[0].cdnMeta, 'プロトコル相対URLでもCDNメタデータが取得できること');
  assert.strictEqual(warnings[0].cdnMeta.name, 'Tailwind CSS');
  assert.strictEqual(warnings[0].cdnMeta.isExecutableScript, true);
});

test('改行バイパス防止: タグと属性が改行されていても属性の存在する正確な行番号を検出する', () => {
  const multilineHtml = `<!DOCTYPE html>
<html>
<head>
  <script
    src="https://external-cdn.example.com/malicious.js">
  </script>
</head>
<body>
</body>
</html>`;

  const warnings = scanHtml(multilineHtml);
  assert.ok(warnings.length >= 1, '改行された外部スクリプトが検出されること');
  assert.strictEqual(warnings[0].rule, 'TAG_EXTERNAL_URL_ATTR');
  assert.strictEqual(warnings[0].line, 5, 'src属性の存在する5行目が検出されること');
  assert.strictEqual(warnings[0].url, 'https://external-cdn.example.com/malicious.js');
});

test('POPUP カテゴリ: window.open / target="_blank" を検出する', () => {
  const html = `<!DOCTYPE html>
<html>
<body>
  <a href="#section" target="_blank">新規タブ</a>
  <button onclick="window.open('https://example.com')">開く</button>
</body>
</html>`;

  const warnings = scanHtml(html);
  assert.strictEqual(warnings.length, 2);
  assert.strictEqual(warnings[0].rule, 'POPUP_TARGET_BLANK');
  assert.strictEqual(warnings[1].rule, 'POPUP_WINDOW_OPEN');
  assert.strictEqual(warnings[1].url, 'https://example.com');
});

test('STORAGE カテゴリ: localStorage / sessionStorage を検出する', () => {
  const html = `<!DOCTYPE html>
<html>
<body>
  <script>
    localStorage.setItem("key", "value");
    sessionStorage.getItem("token");
  </script>
</body>
</html>`;

  const warnings = scanHtml(html);
  assert.strictEqual(warnings.length, 2);
  assert.strictEqual(warnings[0].rule, 'STORAGE_LOCAL');
  assert.strictEqual(warnings[1].rule, 'STORAGE_SESSION');
});

test('DYNAMIC_EVAL カテゴリ: eval / new Function を検出する', () => {
  const html = `<!DOCTYPE html>
<html>
<body>
  <script>
    eval("console.log(1)");
    const fn = new Function("return 2");
  </script>
</body>
</html>`;

  const warnings = scanHtml(html);
  assert.strictEqual(warnings.length, 2);
  assert.strictEqual(warnings[0].rule, 'EVAL_EXEC');
  assert.strictEqual(warnings[1].rule, 'NEW_FUNCTION');
});

test('警告情報には行番号とコード抜粋が含まれる', () => {
  const html = `line 1
line 2: fetch("https://example.com")
line 3`;

  const warnings = scanHtml(html);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].line, 2);
  assert.ok(warnings[0].snippet.includes('fetch("https://example.com")'));
  assert.strictEqual(warnings[0].url, 'https://example.com');
});

test('ネットワークAPI・動的実行・別タブ属性の改行を検出する', () => {
  const html = 'fetch\n("https://example.com");\nnew\nXMLHttpRequest\n();\neval\n("1");\n<a\n target="_blank" href="#">Open</a>';
  const warnings = scanHtml(html);
  assert.ok(warnings.some(warning => warning.rule === 'NETWORK_FETCH' && warning.line === 1));
  assert.ok(warnings.some(warning => warning.rule === 'NETWORK_XHR'));
  assert.ok(warnings.some(warning => warning.rule === 'EVAL_EXEC'));
  assert.ok(warnings.some(warning => warning.rule === 'POPUP_TARGET_BLANK'));
});

test('類似ドメイン・別パッケージ・userinfoを公式CDNに分類しない', () => {
  for (const url of ['https://cdn.tailwindcss.com.evil.example/x.js', 'https://cdn.tailwindcss.com@evil.example/x.js', 'https://unpkg.com/lucide-evil/x.js', 'https://cdn.jsdelivr.net/lucide-evil/x.js']) {
    const warnings = scanHtml(`<script src="${url}"></script>`);
    assert.equal(warnings[0].cdnMeta, null, url);
  }
});

test('new Function の改行を検出し、先頭の行番号を返す', () => {
  const html = 'const f =\nnew\nFunction\n("return 1");';
  const warnings = scanHtml(html);
  const warn = warnings.find(w => w.rule === 'NEW_FUNCTION');
  assert.ok(warn, 'new Function の改行が検出されること');
  assert.strictEqual(warn.line, 2, 'newの存在する2行目が検出されること');
});

test('警告配列はシリアライズ後45000文字以下に制限され、末尾にSCAN_TRUNCATEDが生成される', () => {
  // 長いURLやJSONエスケープ文字を含む大量警告HTML
  const longUrl = 'https://example.com/' + 'a'.repeat(300) + '?q=' + 'b'.repeat(200);
  const html = Array.from({ length: 200 }, (_, i) => `<img src="${longUrl}&id=${i}">`).join('\n');
  const warnings = scanHtml(html);

  const jsonStr = JSON.stringify(warnings);
  assert.ok(jsonStr.length <= 45000, `警告JSON長(${jsonStr.length})が45000文字以下であること`);

  const lastWarning = warnings[warnings.length - 1];
  assert.strictEqual(lastWarning.rule, 'SCAN_TRUNCATED', '末尾の要素がSCAN_TRUNCATEDであること');
  assert.ok(lastWarning.category, 'categoryが存在すること');
  assert.ok(typeof lastWarning.line === 'number', 'lineが存在すること');
  assert.ok(lastWarning.snippet, 'snippetが存在すること');
  assert.ok(lastWarning.message, 'messageが存在すること');
});

test('本番Scannerは1MBの未閉鎖タグ反復をVM上限内で走査する', () => {
  const size = 1024 * 1024;
  const html = '<div '.repeat(Math.ceil(size / 5)).slice(0, size);
  assert.deepStrictEqual(scanProductionInVm(html), []);
});

test('本番Scannerは1MBの単一長大タグ名をVM上限内で走査する', () => {
  const html = '<' + 'a'.repeat(1024 * 1024);
  assert.deepStrictEqual(scanProductionInVm(html), []);
});

test('タグ走査は閉鎖タグを無視し、引用符中の > と改行属性を越えて外部URL属性を検出する', () => {
  const html = `<section data-label="1 > 0">
</section>
<img
  title='2 > 1'
  src="https://assets.example.com/image.png">`;

  const warnings = scanProductionInVm(html);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].rule, 'TAG_EXTERNAL_URL_ATTR');
  assert.strictEqual(warnings[0].line, 5);
  assert.strictEqual(warnings[0].attribute, 'src');
  assert.strictEqual(warnings[0].url, 'https://assets.example.com/image.png');
});

test('別属性の引用値内にある src= と href= を外部URL属性として誤検出しない', () => {
  const fixtures = [
    '<div data-text="src=https://evil.example/x.js"></div>',
    '<div title="href=//evil.example/x"></div>'
  ];

  for (const html of fixtures) {
    assert.deepStrictEqual(scanProductionInVm(html), [], html);
  }
});

test('未引用属性値中の < を値として消費し、空白後の実src属性を検出する', () => {
  const html = '<img data=a<! src="https://assets.example/a.js">';
  const warnings = scanProductionInVm(html);

  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].rule, 'TAG_EXTERNAL_URL_ATTR');
  assert.strictEqual(warnings[0].line, 1);
  assert.strictEqual(warnings[0].attribute, 'src');
  assert.strictEqual(warnings[0].url, 'https://assets.example/a.js');
});

test('severity: 静的リソースのみの著名CDN(Google Fonts)はLOWに格下げされる', () => {
  const html = '<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">';
  const warnings = scanHtml(html);
  assert.strictEqual(warnings[0].cdnMeta.isExecutableScript, false);
  assert.strictEqual(warnings[0].severity, 'LOW');
});

test('severity: 実行可能スクリプトを配信する著名CDN(Tailwind/cdnjs)はLOWに格下げしない', () => {
  const html = '<script src="https://cdn.tailwindcss.com"></script><script src="https://cdnjs.cloudflare.com/ajax/libs/lib/1.0/lib.js"></script>';
  const warnings = scanHtml(html);
  assert.strictEqual(warnings.length, 2);
  warnings.forEach((w) => {
    assert.strictEqual(w.cdnMeta.isExecutableScript, true);
    assert.strictEqual(w.severity, 'MEDIUM', `${w.cdnMeta.name} はMEDIUMのまま維持されること`);
  });
});

test('severity: eval・fetch・new Worker・<base>はHIGHに分類される', () => {
  const html = `<base href="https://evil.example/">
<script>
  fetch("https://api.example.com/data");
  eval("1");
  new Worker("https://worker.example.com/w.js");
</script>`;
  const warnings = scanHtml(html);
  const byRule = Object.fromEntries(warnings.map((w) => [w.rule, w]));
  assert.strictEqual(byRule.TAG_BASE.severity, 'HIGH');
  assert.strictEqual(byRule.NETWORK_FETCH.severity, 'HIGH');
  assert.strictEqual(byRule.EVAL_EXEC.severity, 'HIGH');
  assert.strictEqual(byRule.NETWORK_WORKER.severity, 'HIGH');
});

test('severity: target="_blank" と localStorage はLOWに分類される', () => {
  const html = `<a href="#" target="_blank">link</a>
<script>localStorage.setItem("k", "v");</script>`;
  const warnings = scanHtml(html);
  const byRule = Object.fromEntries(warnings.map((w) => [w.rule, w]));
  assert.strictEqual(byRule.POPUP_TARGET_BLANK.severity, 'LOW');
  assert.strictEqual(byRule.STORAGE_LOCAL.severity, 'LOW');
});

test('severity: 未省略時(SCAN_TRUNCATED)はHIGHで折りたたみに埋もれない', () => {
  const longUrl = 'https://example.com/' + 'a'.repeat(300) + '?q=' + 'b'.repeat(200);
  const html = Array.from({ length: 200 }, (_, i) => `<img src="${longUrl}&id=${i}">`).join('\n');
  const warnings = scanHtml(html);
  const truncated = warnings[warnings.length - 1];
  assert.strictEqual(truncated.rule, 'SCAN_TRUNCATED');
  assert.strictEqual(truncated.severity, 'HIGH');
});

// ShellJs.html のクライアント側フォールバック解決(resolveWarningSeverity_)を、
// 実ファイルから抽出したソースで検証する。過去バージョン(severity欠落データ)との
// 後方互換性を担保するロジックのため、Scanner.gsのRULES.severityと独立に確認する。
test('resolveWarningSeverity_: severityフィールドが無い過去データをrule名からフォールバック解決する', () => {
  const shellJsPath = path.join(__dirname, '..', 'src', 'ShellJs.html');
  const shellJsSource = fs.readFileSync(shellJsPath, 'utf8');

  const startMarker = 'var RULE_SEVERITY_FALLBACK_ = {';
  const endMarker = '  // 警告メタデータの補完解決';
  const startIdx = shellJsSource.indexOf(startMarker);
  const endIdx = shellJsSource.indexOf(endMarker, startIdx);
  assert.ok(startIdx !== -1 && endIdx !== -1, 'ShellJs.html からフォールバックロジックを抽出できること');

  const snippet = shellJsSource.slice(startIdx, endIdx);
  const context = {};
  vm.createContext(context);
  vm.runInContext(snippet, context);

  // 新規スキャン分: severityフィールドがあればそれを優先
  assert.strictEqual(context.resolveWarningSeverity_({ severity: 'HIGH', rule: 'STORAGE_LOCAL' }), 'HIGH');

  // 過去データ想定: severityフィールドが無い
  assert.strictEqual(context.resolveWarningSeverity_({ rule: 'EVAL_EXEC' }), 'HIGH');
  assert.strictEqual(context.resolveWarningSeverity_({ rule: 'STORAGE_LOCAL' }), 'LOW');
  assert.strictEqual(context.resolveWarningSeverity_({ rule: 'POPUP_TARGET_BLANK' }), 'LOW');
  assert.strictEqual(
    context.resolveWarningSeverity_({ rule: 'TAG_EXTERNAL_URL_ATTR', cdnMeta: { isExecutableScript: false } }),
    'LOW'
  );
  assert.strictEqual(
    context.resolveWarningSeverity_({ rule: 'TAG_EXTERNAL_URL_ATTR', cdnMeta: { isExecutableScript: true } }),
    'MEDIUM'
  );
  assert.strictEqual(context.resolveWarningSeverity_({ rule: 'TAG_EXTERNAL_URL_ATTR' }), 'MEDIUM');

  // 未知のruleは安全側でMEDIUM（無条件で隠さない）
  assert.strictEqual(context.resolveWarningSeverity_({ rule: 'UNKNOWN_FUTURE_RULE' }), 'MEDIUM');
});
