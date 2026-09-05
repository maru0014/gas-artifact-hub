/**
 * tools/scanner-rules.js - Scanner.gs 互換アダプタ
 * 本番正本である src/Scanner.gs を Node.js vm コンテキストでロードし、テストおよび外部ツール向けに提供する。
 * ルール定義の二重管理を解消しつつ、既存の export インターフェース（SCANNER_RULES, KNOWN_CDNS, scanHtml）を完全維持する。
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scannerGsPath = path.join(__dirname, '..', 'src', 'Scanner.gs');
const gsContent = fs.readFileSync(scannerGsPath, 'utf8');

const context = { console };
vm.createContext(context);
vm.runInContext(gsContent, context);

const Scanner = context.Scanner;

module.exports = {
  SCANNER_RULES: JSON.parse(JSON.stringify(Scanner.getRules())),
  KNOWN_CDNS: JSON.parse(JSON.stringify(Scanner.getKnownCdns ? Scanner.getKnownCdns() : [])),
  scanHtml: function (html) {
    return JSON.parse(JSON.stringify(Scanner.scan(html)));
  },
  Scanner: Scanner
};
