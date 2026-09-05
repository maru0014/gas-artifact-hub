/**
 * GAS Artifact Hub - 静的検査 (Scanner.gs)
 * HTMLを静的解析し、外部通信・ポップアップ・動的実行などの警告情報を抽出する。
 * ※安全性の保証ではなく、警告・同意（Consent）・透明性（Source確認）のための補助判定。
 */

var Scanner = (function () {
  var ATTR = '(?:"[^"]*"|\'[^\']*\'|[^>"\'])*';
  var URL_ATTRS = 'src|href|xlink:href|data|action|formaction|poster|srcset|background|cite|manifest|ping|codebase';
  var URL_ATTR_NAME_PATTERN = re_('^(?:' + URL_ATTRS + ')$', 'i');
  var EXTERNAL_URL_VALUE_PATTERN = /^(?:https?:)?\/\/[\s\S]+/i;

  // 保存サイズと収集上限の制御定数
  var MAX_SERIALIZED_CHARS = 45000; // Google Sheetsセル上限50,000文字に対する安全閾値
  var MAX_WARNINGS_CAP = 250;       // メモリ・CPU浪費を防ぐ収集上限

  function re_(source, flags) {
    return new RegExp(source, flags || '');
  }

  // 著名CDNの客観的メタデータ定義
  var KNOWN_CDNS = [
    {
      name: 'Google Fonts',
      // userinfo（@）を含まない、ホスト名の境界で判定
      pattern: /^https?:\/\/(?![^/]*@)(?:fonts\.googleapis\.com|fonts\.gstatic\.com)(?::\d+)?(?:\/|$|\?|#)/i,
      isExecutableScript: false,
      label: '公式配信: Google Fonts (フォント/CSS)',
      info: 'Google公式フォント・スタイル配信リソースです。'
    },
    {
      name: 'Tailwind CSS',
      // userinfo（@）を含まない、ホスト名の境界で判定
      pattern: /^https?:\/\/(?![^/]*@)cdn\.tailwindcss\.com(?::\d+)?(?:\/|$|\?|#)/i,
      isExecutableScript: true,
      label: '公式配信: Tailwind CSS (スクリプト)',
      info: 'Tailwind CSS開発用JITスクリプトです（実行可能コードを含みます）。'
    },
    {
      name: 'Lucide Icons',
      // userinfo（@）を含まない、パッケージ名境界（/ または @）で判定
      pattern: /^https?:\/\/(?![^/]*@)(?:unpkg\.com|cdn\.jsdelivr\.net)(?::\d+)?\/(?:npm\/)?(?:lucide|lucide-static)(?:@|\/|$|\?|#)/i,
      isExecutableScript: true,
      label: '公式配信: Lucide Icons (スクリプト/SVG)',
      info: 'Lucide公式アイコン配信リソースです。'
    },
    {
      name: 'cdnjs (Cloudflare)',
      // userinfo（@）を含まない、ホスト名の境界で判定
      pattern: /^https?:\/\/(?![^/]*@)cdnjs\.cloudflare\.com(?::\d+)?(?:\/|$|\?|#)/i,
      isExecutableScript: true,
      label: '著名CDN: cdnjs (スクリプト/CSS)',
      info: 'Cloudflareが運営する著名なオープンソースライブラリCDNです。'
    }
  ];

  var RULES = [
    // --- 1. ネットワーク外部通信 ---
    {
      category: 'NETWORK',
      name: 'NETWORK_FETCH',
      pattern: /\bfetch\s*\(/gi,
      message: '外部サーバーとの通信 (fetch)'
    },
    {
      category: 'NETWORK',
      name: 'NETWORK_XHR',
      pattern: /\bnew\s+XMLHttpRequest\s*\(/gi,
      message: '外部サーバーとの通信 (XMLHttpRequest)'
    },
    {
      category: 'NETWORK',
      name: 'NETWORK_SENDBEACON',
      pattern: /navigator\s*\.\s*sendBeacon\s*\(/gi,
      message: '外部サーバーへのデータ送信 (sendBeacon)'
    },
    {
      category: 'NETWORK',
      name: 'NETWORK_EVENTSOURCE',
      pattern: /\bnew\s+EventSource\s*\(/gi,
      message: 'Server-Sent Events (EventSource)'
    },
    {
      category: 'NETWORK',
      name: 'NETWORK_WEBSOCKET',
      pattern: /\bnew\s+WebSocket\s*\(/gi,
      message: '双方向リアルタイム通信 (WebSocket)'
    },
    {
      category: 'NETWORK',
      name: 'NETWORK_WORKER',
      pattern: /\bnew\s+(?:Shared)?Worker\s*\(/gi,
      message: 'バックグラウンドワーカー (Worker)'
    },
    {
      category: 'NETWORK',
      name: 'NETWORK_WEBRTC',
      pattern: /\bnew\s+RTCPeerConnection\s*\(/gi,
      message: 'P2P通信 (RTCPeerConnection)'
    },

    // --- 2. 外部タグ・リソース読み込み ---
    {
      category: 'EXTERNAL_TAG',
      name: 'TAG_BASE',
      pattern: /<base\b/gi,
      message: '基準URLを変更する <base> タグ'
    },
    {
      category: 'EXTERNAL_TAG',
      name: 'TAG_META_REFRESH',
      pattern: re_('<meta\\b' + ATTR + 'http-equiv\\s*=\\s*["\']\\s*refresh\\s*["\']', 'gi'),
      message: '自動リダイレクト (<meta refresh>)'
    },
    {
      category: 'EXTERNAL_TAG',
      name: 'TAG_EXTERNAL_URL_ATTR',
      pattern: /<[a-zA-Z]/g,
      message: '外部リソースを読み込むタグ属性 (src, href等)'
    },
    {
      category: 'EXTERNAL_TAG',
      name: 'CSS_IMPORT_EXTERNAL',
      pattern: /@import\s+(?:url\()?\s*["']?(?:https?:)?\/\/[^"')]+/gi,
      message: '外部スタイルシートのインポート (@import)'
    },
    {
      category: 'EXTERNAL_TAG',
      name: 'CSS_URL_EXTERNAL',
      pattern: /url\(\s*["']?(?:https?:)?\/\/[^"')]+/gi,
      message: 'CSS内での外部リソース参照 (url(...))'
    },

    // --- 3. ポップアップ・外部ナビゲーション ---
    {
      category: 'POPUP',
      name: 'POPUP_WINDOW_OPEN',
      pattern: /\b(?:window\s*\.\s*)?open\s*\(/gi,
      message: '新しいウィンドウやポップアップを開く処理 (window.open)'
    },
    {
      category: 'POPUP',
      name: 'POPUP_TARGET_BLANK',
      pattern: /<a\b[^>]*?\btarget\s*=\s*["']_blank["']/gi,
      message: '別タブを開くリンク (target="_blank")'
    },
    {
      category: 'POPUP',
      name: 'NAV_LOCATION_ASSIGN',
      pattern: /\b(?:window\s*\.\s*)?location\s*\.\s*(?:assign|replace)\s*\(\s*["'](?:https?:)?\/\//gi,
      message: '外部サイトへの画面遷移 (location.assign/replace)'
    },

    // --- 4. ブラウザストレージ ---
    {
      category: 'STORAGE',
      name: 'STORAGE_LOCAL',
      pattern: /\blocalStorage\b/g,
      message: 'ブラウザローカルストレージ (localStorage) の利用'
    },
    {
      category: 'STORAGE',
      name: 'STORAGE_SESSION',
      pattern: /\bsessionStorage\b/g,
      message: 'セッションストレージ (sessionStorage) の利用'
    },
    {
      category: 'STORAGE',
      name: 'STORAGE_INDEXEDDB',
      pattern: /\bindexedDB\b/g,
      message: 'ブラウザデータベース (indexedDB) の利用'
    },

    // --- 5. 動的コード実行 ---
    {
      category: 'DYNAMIC_EVAL',
      name: 'EVAL_EXEC',
      pattern: /\beval\s*\(/gi,
      message: '動的コード評価 (eval)'
    },
    {
      category: 'DYNAMIC_EVAL',
      name: 'NEW_FUNCTION',
      pattern: /\bnew\s+Function\s*\(/gi,
      message: '文字列からの動的関数生成 (new Function)'
    },
    {
      category: 'DYNAMIC_EVAL',
      name: 'DYNAMIC_IMPORT',
      pattern: /\bimport\s*\(/gi,
      message: '動的モジュール読み込み (dynamic import)'
    }
  ];

  /**
   * テキストスニペットからURLおよび属性名を安全に抽出
   */
  function extractDetails(snippet) {
    var details = {
      url: null,
      fullUrl: null,
      attribute: null
    };

    if (!snippet || typeof snippet !== 'string') return details;

    // 1. タグ属性からの抽出 (例: src="https://..." または href='//...')
    var tagAttrMatch = snippet.match(/\b(src|href|xlink:href|data|action|formaction|poster|background)\s*=\s*["']?((?:https?:)?\/\/[^\s"'>]+)["']?/i);
    if (tagAttrMatch) {
      details.attribute = tagAttrMatch[1].toLowerCase();
      var rawUrl = tagAttrMatch[2].replace(/["'>]+$/, '');
      details.fullUrl = rawUrl;
      details.url = formatDisplayUrl(rawUrl);
      return details;
    }

    // 2. CSS @import / url(...)
    var cssMatch = snippet.match(/(?:@import\s+(?:url\()?\s*|url\(\s*)["']?((?:https?:)?\/\/[^\s"')]+)["']?/i);
    if (cssMatch) {
      details.attribute = snippet.indexOf('@import') !== -1 ? '@import' : 'url';
      var rawCssUrl = cssMatch[1].replace(/["')]+$/, '');
      details.fullUrl = rawCssUrl;
      details.url = formatDisplayUrl(rawCssUrl);
      return details;
    }

    // 3. 一般的なURL抽出 (fetch, open, location等)
    var genericUrlMatch = snippet.match(/(?:https?:)?\/\/[^\s"'>\)]+/i);
    if (genericUrlMatch) {
      var rawGenUrl = genericUrlMatch[0].replace(/["'>\)]+$/, '');
      details.fullUrl = rawGenUrl;
      details.url = formatDisplayUrl(rawGenUrl);
    }

    return details;
  }

  /**
   * 長大クエリパラメータを安全に短縮 (Origin + Pathname を保持)
   */
  function formatDisplayUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    var qIndex = rawUrl.indexOf('?');
    if (qIndex !== -1 && rawUrl.length > 70) {
      var basePart = rawUrl.substring(0, qIndex);
      return basePart + '?...';
    }
    if (rawUrl.length > 80) {
      return rawUrl.substring(0, 77) + '...';
    }
    return rawUrl;
  }

  /**
   * 著名CDNメタデータの解決
   */
  function resolveCdnMetadata(url) {
    if (!url) return null;
    // プロトコル相対URL（//...）の場合は判定用に https: を補完
    var normalizedUrl = url.indexOf('//') === 0 ? 'https:' + url : url;
    for (var i = 0; i < KNOWN_CDNS.length; i++) {
      var cdn = KNOWN_CDNS[i];
      if (cdn.pattern.test(normalizedUrl)) {
        return {
          name: cdn.name,
          isExecutableScript: cdn.isExecutableScript,
          label: cdn.label,
          info: cdn.info
        };
      }
    }
    return null;
  }

  /**
   * 改行位置テーブルを構築 (O(N))
   */
  function buildLineOffsets(text) {
    var offsets = [0];
    for (var i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) { // \n
        offsets.push(i + 1);
      }
    }
    return offsets;
  }

  /**
   * 文字インデックスから行番号を取得 (O(log L) 二分探索)
   */
  function getLineNumber(offsets, pos) {
    var low = 0;
    var high = offsets.length - 1;
    while (low <= high) {
      var mid = (low + high) >> 1;
      if (offsets[mid] <= pos) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return low; // 1-based line number
  }

  /**
   * 省略通知用警告アイテムの生成
   */
  function createTruncationWarning(lastLine) {
    return {
      category: 'EXTERNAL_TAG',
      rule: 'SCAN_TRUNCATED',
      line: lastLine || 1,
      snippet: '... (以降の警告は保存サイズ上限のため省略されました)',
      message: '警告数が多いため以降の検査結果を省略しました。完全な内容はソースコードを確認してください。',
      url: null,
      fullUrl: null,
      attribute: null,
      cdnMeta: null
    };
  }

  /**
   * 警告配列のサイズ・件数を安全な範囲（<= 45,000文字）に制限
   */
  function enforceWarningSizeLimits(warnings, truncatedDuringScan) {
    var isTruncated = truncatedDuringScan || false;

    if (warnings.length > MAX_WARNINGS_CAP) {
      warnings = warnings.slice(0, MAX_WARNINGS_CAP);
      isTruncated = true;
    }

    var jsonLength = JSON.stringify(warnings).length;
    if (jsonLength > MAX_SERIALIZED_CHARS) {
      isTruncated = true;
    }

    if (!isTruncated) {
      return warnings;
    }

    var lastLine = warnings.length > 0 ? warnings[warnings.length - 1].line : 1;
    var truncItem = createTruncationWarning(lastLine);

    // 省略アイテムを含めたシリアライズ長が MAX_SERIALIZED_CHARS 以下になるまで末尾から削減
    while (warnings.length > 0) {
      var candidate = warnings.concat([truncItem]);
      if (JSON.stringify(candidate).length <= MAX_SERIALIZED_CHARS) {
        return candidate;
      }
      warnings.pop();
      if (warnings.length > 0) {
        truncItem.line = warnings[warnings.length - 1].line;
      }
    }

    return [truncItem];
  }

  /**
   * タグ区間内を属性単位で走査し、実属性の外部URL値だけを返す。
   * 他属性の引用値内にある "src=" 等は属性名として解釈しない。
   */
  function findExternalUrlAttribute(html, start, end) {
    var i = start;

    while (i < end) {
      var ch = html.charAt(i);
      while (i < end && (isHtmlSpace(html.charAt(i)) || html.charAt(i) === '/')) i++;
      if (i >= end || html.charAt(i) === '>') return null;

      ch = html.charAt(i);
      if (ch === '"' || ch === "'") {
        i++;
        while (i < end && html.charAt(i) !== ch) i++;
        if (i < end) i++;
        continue;
      }

      var attrStart = i;
      while (i < end) {
        ch = html.charAt(i);
        if (isHtmlSpace(ch) || ch === '=' || ch === '/' || ch === '>' ||
            ch === '<' || ch === '"' || ch === "'") break;
        i++;
      }
      if (i === attrStart) {
        i++;
        continue;
      }

      var attrNameEnd = i;
      while (i < end && isHtmlSpace(html.charAt(i))) i++;
      if (html.charAt(i) !== '=') continue;

      i++;
      while (i < end && isHtmlSpace(html.charAt(i))) i++;
      var valueStart = i;
      var valueEnd;
      var valueTokenEnd;
      var valueQuote = html.charAt(i);

      if (valueQuote === '"' || valueQuote === "'") {
        valueStart = ++i;
        while (i < end && html.charAt(i) !== valueQuote) i++;
        valueEnd = i;
        if (i < end) i++;
        valueTokenEnd = i;
      } else {
        while (i < end) {
          ch = html.charAt(i);
          if (isHtmlSpace(ch) || ch === '>') break;
          i++;
        }
        valueEnd = i;
        valueTokenEnd = i;
      }

      var attrName = html.substring(attrStart, attrNameEnd);
      var attrValue = html.substring(valueStart, valueEnd);
      if (URL_ATTR_NAME_PATTERN.test(attrName) && EXTERNAL_URL_VALUE_PATTERN.test(attrValue)) {
        return {
          0: html.substring(attrStart, valueTokenEnd),
          index: attrStart,
          end: valueTokenEnd
        };
      }
    }

    return null;
  }

  function isHtmlSpace(ch) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
  }

  /**
   * タグを左から右へ一度だけ走査し、対象属性を含むタグを通知する。
   * 未引用の ">" または入力末尾までを同じタグ区間として扱う。
   * "<" は未引用属性値でもHTMLのパースエラー文字として値に取り込まれるため、区切りにしない。
   */
  function scanExternalUrlTagMatches(html, handleMatch) {
    var cursor = 0;

    while (cursor < html.length) {
      var tagStart = html.indexOf('<', cursor);
      if (tagStart === -1 || tagStart + 1 >= html.length) return false;

      var first = html.charAt(tagStart + 1);
      if (!/[a-zA-Z]/.test(first)) {
        cursor = tagStart + 1;
        continue;
      }

      var nameEnd = tagStart + 2;
      while (nameEnd < html.length && /[a-zA-Z0-9:-]/.test(html.charAt(nameEnd))) {
        nameEnd++;
      }

      var quote = '';
      var tagEnd = html.length;
      var nextCursor = html.length;

      for (var i = nameEnd; i < html.length; i++) {
        var ch = html.charAt(i);
        if (quote) {
          if (ch === quote) quote = '';
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === '>') {
          tagEnd = i + 1;
          nextCursor = i + 1;
          break;
        }
      }

      if (tagEnd > nameEnd) {
        var attrMatch = findExternalUrlAttribute(html, nameEnd, tagEnd);
        if (attrMatch) {
          if (handleMatch({
            0: attrMatch[0],
            index: tagStart,
            attributeIndex: attrMatch.index,
            end: attrMatch.end
          })) {
            return true;
          }
        }
      }

      cursor = nextCursor > tagStart ? nextCursor : tagStart + 1;
    }

    return false;
  }

  function recordWarning(rule, match, html, offsets, warnings, detectedKeys) {
    var matchedText = match[0];
    var pos = typeof match.attributeIndex === 'number' ? match.attributeIndex : match.index;

    var lineNum = getLineNumber(offsets, pos);
    var lineStart = offsets[lineNum - 1];
    var matchEnd = typeof match.end === 'number' ? match.end : match.index + matchedText.length;
    var snippetEnd = Math.min(html.length, Math.max(matchEnd + 80, lineStart + 140));
    var snippetSource = html.substring(lineStart, snippetEnd);
    var snippet = snippetSource.replace(/\s+/g, ' ').trim().substring(0, 120);

    // まずマッチしたテキストそのものから抽出を試み、取れなければ行スニペットから抽出
    var details = extractDetails(matchedText);
    if (!details.url && !details.attribute) {
      details = extractDetails(snippetSource);
    }
    var cdnMeta = resolveCdnMetadata(details.fullUrl || details.url);

    // 重複排除キー（同一ルール・同一行・同一URL）
    var key = rule.name + ':' + lineNum + ':' + (details.fullUrl || details.url || pos);
    if (detectedKeys[key]) return false;
    detectedKeys[key] = true;

    var formattedMessage = rule.message;
    if (rule.name === 'TAG_EXTERNAL_URL_ATTR' && details.url) {
      formattedMessage = '外部リソース読込 (' + (details.attribute || 'src') + '="' + details.url + '")';
    } else if (rule.name === 'CSS_IMPORT_EXTERNAL' && details.url) {
      formattedMessage = '外部スタイルシート読み込み (@import: ' + details.url + ')';
    } else if (rule.name === 'CSS_URL_EXTERNAL' && details.url) {
      formattedMessage = 'CSS内外部リソース参照 (url: ' + details.url + ')';
    } else if (rule.name === 'NETWORK_FETCH' && details.url) {
      formattedMessage = '外部サーバーとの通信 (fetch: ' + details.url + ')';
    } else if (rule.name === 'POPUP_WINDOW_OPEN' && details.url) {
      formattedMessage = '別ウィンドウ表示 (window.open: ' + details.url + ')';
    }

    warnings.push({
      category: rule.category,
      rule: rule.name,
      line: lineNum,
      snippet: snippet,
      message: formattedMessage,
      url: details.url,
      fullUrl: details.fullUrl,
      attribute: details.attribute,
      cdnMeta: cdnMeta,
      _pos: pos
    });

    return warnings.length >= MAX_WARNINGS_CAP + 10;
  }

  function scan(html) {
    if (typeof html !== 'string') return [];
    var offsets = buildLineOffsets(html);
    var warnings = [];
    var detectedKeys = {};
    var hitCap = false;

    for (var r = 0; r < RULES.length; r++) {
      var rule = RULES[r];
      rule.pattern.lastIndex = 0; // 正規表現ステートのリセット

      if (rule.name === 'TAG_EXTERNAL_URL_ATTR') {
        hitCap = scanExternalUrlTagMatches(html, function (tagMatch) {
          return recordWarning(rule, tagMatch, html, offsets, warnings, detectedKeys);
        });
        if (hitCap) break;
        continue;
      }

      var match;
      while ((match = rule.pattern.exec(html)) !== null) {
        if (recordWarning(rule, match, html, offsets, warnings, detectedKeys)) {
          hitCap = true;
          break;
        }

        // 空文字マッチによる無限ループ防止
        if (rule.pattern.lastIndex === match.index) {
          rule.pattern.lastIndex++;
        }
      }

      if (hitCap) break;
    }

    // 行番号および出現位置順に安定ソート
    warnings.sort(function (a, b) {
      if (a.line !== b.line) return a.line - b.line;
      return (a._pos || 0) - (b._pos || 0);
    });

    // 内部作業プロパティ _pos のクリーンアップ
    for (var i = 0; i < warnings.length; i++) {
      delete warnings[i]._pos;
    }

    return enforceWarningSizeLimits(warnings, hitCap);
  }

  function getRules() {
    return RULES.slice();
  }

  function getKnownCdns() {
    return KNOWN_CDNS.slice();
  }

  return {
    scan: scan,
    getRules: getRules,
    getKnownCdns: getKnownCdns
  };
})();
