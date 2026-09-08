/** 本番テンプレートを使うローカルUI検証サーバー。GAS認証/サービスは再現しない。 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { renderTemplate } = require('../html-template');

const host = '127.0.0.1';
const port = 4173;
const base = `http://${host}:${port}/`;
const server = http.createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  const url = new URL(request.url, base);
  if (request.method !== 'GET') {
    response.writeHead(405).end();
    return;
  }
  if (url.pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'text/plain' }).end('local-ui-test-server');
    return;
  }
  if (url.pathname === '/__test/rpc.js') {
    response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    response.end(fs.readFileSync(path.join(__dirname, 'rpc-stub.js')));
    return;
  }
  if (url.pathname === '/__test/coop-target') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cross-Origin-Opener-Policy': 'same-origin'
    });
    response.end('<!DOCTYPE html><html><body><h1 id="coop-loaded">COOPページ正常読み込み</h1></body></html>');
    return;
  }
  if (url.pathname !== '/') {
    response.writeHead(404).end();
    return;
  }
  try {
    const artifactId = url.searchParams.get('a') || '';
    const versionId = url.searchParams.get('v') || '';
    if (![artifactId, versionId].every(value => /^[A-Za-z0-9_-]*$/.test(value))) {
      response.writeHead(400).end('Invalid fixture identifier');
      return;
    }
    const template = renderTemplate(artifactId ? 'Shell' : 'Upload', { appUrl: base, artifactId, versionId });
    const html = template.replace('</head>', '<script src="/__test/rpc.js"></script></head>');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
  } catch (error) {
    console.error(error.message);
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('テンプレート展開に失敗しました。サーバーログを確認してください。');
  }
});

server.listen(port, host, () => console.log(`ローカルUI検証専用: ${base}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
