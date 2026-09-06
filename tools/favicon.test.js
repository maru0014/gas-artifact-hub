const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryAssetBase =
  'https://raw.githubusercontent.com/maru0014/gas-artifact-hub/9addfb4338e749a64b07925647d4d239af3debdf/assets';

test('ポータルとビューアがリポジトリ上のファビコンを参照する', () => {
  for (const file of ['src/Upload.html', 'src/Shell.html']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(source.includes(
      `<link rel="icon" href="${repositoryAssetBase}/favicon.ico" sizes="any">`
    ));
    assert.ok(source.includes(
      `<link rel="icon" type="image/png" sizes="32x32" href="${repositoryAssetBase}/favicon-32x32.png">`
    ));
    assert.ok(source.includes(
      `<link rel="icon" type="image/png" sizes="16x16" href="${repositoryAssetBase}/favicon-16x16.png">`
    ));
    assert.ok(source.includes(
      `<link rel="apple-touch-icon" sizes="180x180" href="${repositoryAssetBase}/apple-touch-icon.png">`
    ));
  }
});

test('ポータルのブランドマークがリポジトリ上のアイコンを表示する', () => {
  const source = fs.readFileSync('src/Upload.html', 'utf8');
  assert.match(
    source,
    new RegExp(`${repositoryAssetBase}/android-chrome-192x192\\.png`)
  );
  assert.match(source, /<img[^>]+alt=""[^>]+aria-hidden="true"/);
  const css = fs.readFileSync('src/UploadCss.html', 'utf8');
  assert.match(css, /\.brand-mark img\s*\{[\s\S]*?object-fit:\s*contain;/);
});

test('参照するファビコン資産がリポジトリに含まれる', () => {
  for (const file of [
    'favicon.ico',
    'favicon-16x16.png',
    'favicon-32x32.png',
    'apple-touch-icon.png',
    'android-chrome-192x192.png',
  ]) {
    assert.ok(fs.existsSync(path.join('assets', file)), `${file} がありません`);
  }
});

test('PNGとICO資産が期待する形式と寸法を持つ', () => {
  const pngDimensions = new Map([
    ['favicon-16x16.png', [16, 16]],
    ['favicon-32x32.png', [32, 32]],
    ['apple-touch-icon.png', [180, 180]],
    ['android-chrome-192x192.png', [192, 192]],
  ]);

  for (const [file, expected] of pngDimensions) {
    const image = fs.readFileSync(path.join('assets', file));
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.deepEqual([image.readUInt32BE(16), image.readUInt32BE(20)], expected);
  }

  const ico = fs.readFileSync(path.join('assets', 'favicon.ico'));
  assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0]);
  const iconCount = ico.readUInt16LE(4);
  const dimensions = [];
  for (let index = 0; index < iconCount; index += 1) {
    const offset = 6 + index * 16;
    const width = ico[offset] || 256;
    const height = ico[offset + 1] || 256;
    dimensions.push([width, height]);
  }
  assert.deepEqual(dimensions, [[16, 16], [32, 32], [48, 48]]);
});
