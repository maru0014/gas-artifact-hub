/** 本番GSとHTML内JavaScriptの構文検査。GASサービス実行はしない。 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { renderTemplate } = require('./html-template');

const srcDir = path.join(__dirname, '../src');
const files = fs.readdirSync(srcDir);
const gsFiles = files.filter(file => file.endsWith('.gs'));
let failed = false;
let count = 0;

function check(source, filename) {
  try {
    new vm.Script(source, { filename });
    console.log(`[PASS] ${filename}`);
    count++;
  } catch (error) {
    failed = true;
    console.error(`[FAIL] ${filename}: ${error.message}`);
  }
}

if (!gsFiles.length) {
  console.error('[FAIL] 本番 .gs ファイルがありません');
  process.exit(1);
}
for (const file of gsFiles) check(fs.readFileSync(path.join(srcDir, file), 'utf8'), file);
for (const file of files.filter(file => file.endsWith('.html'))) {
  try {
    const html = renderTemplate(path.basename(file, '.html'));
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    const openings = [...html.matchAll(/<script\b/gi)].length;
    if (openings !== scripts.length) throw new Error('閉じていないscriptタグがあります');
    scripts.forEach((match, index) => {
      if (/\bsrc\s*=/.test(match[1])) throw new Error('外部scriptの構文は検証できません');
      const type = match[1].match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1];
      if (type && !['text/javascript', 'application/javascript'].includes(type.toLowerCase())) {
        throw new Error(`未対応のscript type: ${type}`);
      }
      check(match[2], `${file}:script[${index + 1}]`);
    });
  } catch (error) {
    failed = true;
    console.error(`[FAIL] ${file}: ${error.message}`);
  }
}
console.log(`${count} 個のJavaScriptソースを検査しました。`);
process.exitCode = failed ? 1 : 0;
