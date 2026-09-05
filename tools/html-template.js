/** GASテンプレートをローカル検証用に展開する。本番へは配布しない。 */
const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.resolve(__dirname, '../src');
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

function renderTemplate(name, values = {}, ancestors = []) {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name) || ancestors.includes(name)) {
    throw new Error(`不正または再帰的なinclude: ${name}`);
  }
  const source = fs.readFileSync(path.join(srcDir, name + '.html'), 'utf8');
  const defaults = { appUrl: 'http://127.0.0.1:4173/', artifactId: 'demo-artifact', versionId: '' };
  const data = { ...defaults, ...values };
  const result = source.replace(/<\?(!?=)?([\s\S]*?)\?>/g, (tag, mode, body) => {
    const expression = body.trim().replace(/;$/, '').trim();
    const include = expression.match(/^include_?\(['"]([A-Za-z][A-Za-z0-9]*)['"]\)$/);
    if (include && mode === '!=') return renderTemplate(include[1], data, [...ancestors, name]);
    let value;
    if (expression === 'ScriptApp.getService().getUrl()') value = data.appUrl;
    else if (/^artifactId\s*\|\|\s*(['"])\1$/.test(expression)) value = data.artifactId;
    else if (/^versionId\s*\|\|\s*(['"])\1$/.test(expression)) value = data.versionId;
    else if (/^initial(?:Bootstrap|Artifacts)Json\s*\|\|\s*['"]null['"]$/.test(expression)) value = 'null';
    else throw new Error(`${name}.html: 未対応のGASテンプレート式: ${expression}`);
    if (!mode) throw new Error(`${name}.html: 実行scriptletはローカル検証では未対応`);
    return mode === '=' ? escapeHtml(value) : String(value);
  });
  if (result.includes('<?')) throw new Error(`${name}.html: 未展開のGASテンプレートが残っています`);
  return result;
}

module.exports = { renderTemplate };
