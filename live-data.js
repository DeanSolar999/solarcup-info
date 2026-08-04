/* ============================================================
   SOLAR CUP TWO · live-data.js · 共用雲端資料層（小傑・時間與排程總管）
   資料來源：雲端後端資料庫（Google Sheets, gviz CSV 匯出）
   純瀏覽器端 vanilla JS，無外部套件；各頁 <script src="live-data.js"></script> 即可用
   ============================================================ */
(function (global) {
  'use strict';

  var SHEET_ID = '1kQ-D248ADzN1SxDfQGPkZ-MHhk11sR4zoll3qxL1YdA';
  var CACHE_MS = 45000;
  var QUAL_LAST = 150;   // 資格賽最後一場的場次編號

  // sheetName -> {t:抓取時間戳, promise:進行中/已完成的 Promise<rows>, data:最後一次成功結果}
  var _cache = {};
  var _lastGood = null;   // 最後一次「四張分頁全部成功」的時間

  function gvizUrl(sheetName) {
    return 'https://docs.google.com/spreadsheets/d/' + SHEET_ID +
      '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(sheetName);
  }

  // ---- CSV 解析(RFC4180 風格):處理雙引號包欄位、內含逗號、""跳脫、CRLF ----
  function parseCSV(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var len = text.length;
    for (var i = 0; i < len; i++) {
      var c = text.charAt(i);
      if (inQuotes) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i++; }
          else { inQuotes = false; }
        } else {
          field += c;
        }
      } else {
        if (c === '"') { inQuotes = true; }
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\r') { /* 忽略,交給 \n 收尾 */ }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else { field += c; }
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // ---- 抓取單一分頁(45 秒快取,失敗回退舊快取或 null,不丟例外炸頁面) ----
  function fetchSheet(sheetName) {
    var now = Date.now();
    var entry = _cache[sheetName];
    if (entry && entry.promise && (now - entry.t) < CACHE_MS) {
      return entry.promise;
    }
    var prevData = entry ? entry.data : null;
    var promise = fetch(gvizUrl(sheetName), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + '（' + sheetName + '）');
        return res.text();
      })
      .then(function (text) {
        var rows = parseCSV(text);
        if (_cache[sheetName]) { _cache[sheetName].data = rows; _cache[sheetName].ok = true; }
        return rows;
      })
      .catch(function (err) {
        // 沿用舊快取讓畫面不閃爍，但標記本次未成功——updatedAt 不可假裝是「剛更新」
        console.warn('[SolarCupLive] fetchSheet 失敗：', sheetName, err);
        if (_cache[sheetName]) _cache[sheetName].ok = false;
        return prevData || null;
      });
    _cache[sheetName] = { t: now, promise: promise, data: prevData, ok: false };
    return promise;
  }

  // ---- 數字解析:空字串/「—」/「-」視為 null,含千分位逗號自動去除 ----
  function num(v) {
    if (v === undefined || v === null) return null;
    var s = String(v).trim();
    if (s === '' || s === '—' || s === '-' || s === '－') return null;
    var n = parseFloat(s.replace(/,/g, ''));
    return isNaN(n) ? null : n;
  }
  function str(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }

  // ---- 彙整四張分頁 → 契約物件(不在此重算積分,只搬運後端算好的數字) ----
  function load() {
    return Promise.all([
      fetchSheet('8_發布_戰情看板'),
      fetchSheet('3_資格賽積分榜'),
      fetchSheet('6_積分總表'),
      fetchSheet('7_球團積分'),
    ]).then(function (results) {
      var mRows = results[0] || [];
      var qRows = results[1] || [];
      var tRows = results[2] || [];
      var cRows = results[3] || [];

      // 8_發布_戰情看板：場次編號,隊A,隊B,分A,分B
      // 場次 1–150＝資格賽，151–310＝淘汰賽＋曜請組（見 0_賽事設定 賽程表）
      var matches = {};
      var hasReal = false;
      var qualDone = 0;
      var knockoutStarted = false;
      mRows.slice(1).forEach(function (r) {
        if (!r || !r[0]) return;
        var id = str(r[0]);
        if (!id) return;
        var a = str(r[1]), b = str(r[2]);
        var sa = num(r[3]), sb = num(r[4]);
        var done = sa !== null && sb !== null;
        if (done) hasReal = true;
        var n = parseInt(id, 10);
        if (done && n >= 1 && n <= QUAL_LAST) qualDone++;
        // 淘汰賽隊名是抽籤後才填的；要求雙方隊名＋雙方分數都在，
        // 才不會被「只誤觸一格分數」的空白列提早觸發力場閘門
        if (done && n > QUAL_LAST && a && b) knockoutStarted = true;
        matches[id] = { a: a, b: b, sa: sa, sb: sb, done: done };
      });

      // 3_資格賽積分榜：編號,隊名,賽別,組別,勝場,總得分,總失分,得失分差,失分率,組內排名,自動晉級
      var qualRank = {};
      qRows.slice(1).forEach(function (r) {
        if (!r || !r[0]) return;
        var id = str(r[0]);
        if (!id) return;
        qualRank[id] = {
          name: str(r[1]), type: str(r[2]), group: str(r[3]),
          w: num(r[4]), gf: num(r[5]), ga: num(r[6]), diff: num(r[7]),
          ratio: num(r[8]), rank: num(r[9]), tier: str(r[10]),
        };
      });

      // 6_積分總表：編號,隊名,賽別,代表球團,自動晉級,晉級覆蓋,採用晉級,自動止步,止步覆蓋,採用止步,底分,名次分,隊伍總分
      var teamScores = {};
      tRows.slice(1).forEach(function (r) {
        if (!r || !r[0]) return;
        var id = str(r[0]);
        if (!id) return;
        teamScores[id] = {
          name: str(r[1]), type: str(r[2]), club: str(r[3]),
          tier: str(r[6]), stop: str(r[9]),
          base: num(r[10]) || 0, place: num(r[11]) || 0, total: num(r[12]) || 0,
        };
      });

      // 7_球團積分：代表球團,隊伍數,球團總分,競技組總分,排名,備註
      // comp＝白金＋黃金隊伍的隊伍總分加總，是球團總分同分時的判定依據。
      // 2026-08-04 起「競技組總分」插在總分與排名之間，排名索引因此由 3 變 4。
      var clubScores = [];
      cRows.slice(1).forEach(function (r) {
        if (!r || !r[0]) return;
        var club = str(r[0]);
        if (!club) return;
        clubScores.push({
          club: club, teams: num(r[1]) || 0, total: num(r[2]) || 0,
          comp: num(r[3]), rank: num(r[4]), note: str(r[5]),
        });
      });

      // 四張分頁全部抓取成功才算「剛更新」；有任一張是沿用舊快取就保留上次成功時間，
      // 避免連線異常時畫面顯示舊資料卻標成剛更新
      var allOk = ['8_發布_戰情看板','3_資格賽積分榜','6_積分總表','7_球團積分']
        .every(function (n) { return _cache[n] && _cache[n].ok; });
      if (allOk) _lastGood = new Date();
      // 三態：fresh（allOk）／stale（有 last-good 但本次未全成功）／cold（從未成功過）
      var state = allOk ? 'fresh' : (_lastGood ? 'stale' : 'cold');
      return {
        matches: matches, qualRank: qualRank, teamScores: teamScores,
        clubScores: clubScores, hasReal: hasReal,
        qualDone: qualDone, qualTotal: QUAL_LAST, knockoutStarted: knockoutStarted,
        // cold 時 updatedAt 為 null——沒有成功過就不該顯示任何時間
        state: state, stale: !allOk, updatedAt: _lastGood,
      };
    }).catch(function (err) {
      console.warn('[SolarCupLive] load 失敗：', err);
      return null;
    });
  }

  // ---- 測試資料橫幅（LIVE 開關 B12）------------------------------------
  // 「0_賽事設定」的 LIVE開關（0＝示範／1＝正式）本來沒有任何程式在讀,等於是死開關。
  // 演練會把模擬分數寫進正式資料庫,公開網站會照常顯示——沒有這個橫幅,
  // 球友看到的假成績跟真成績長得一模一樣。
  //
  // 判定用「找 A 欄標籤」而不是寫死 B12:gviz 會把開頭數列併成表頭,
  // 陣列索引和試算表列號對不起來,設定表一改版就會靜默讀錯格。
  var _bannerEl = null;
  function liveSwitchFrom(rows) {
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      if (r && String(r[0] || '').indexOf('LIVE開關') === 0) return num(r[1]);
    }
    return null;
  }
  function setTestBanner(on) {
    if (on && !_bannerEl) {
      var el = document.createElement('div');
      el.id = 'scl-test-banner';
      el.textContent = '⚠ 測試資料 · 非正式成績（賽務演練中）';
      el.setAttribute('role', 'status');
      // 置底而非置頂:這幾頁都有滿版視覺,置頂會壓到標題
      el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;'
        + 'background:#b3261e;color:#fff;font:600 13px/1.6 system-ui,-apple-system,"Noto Sans TC",sans-serif;'
        + 'text-align:center;padding:7px 12px;letter-spacing:.05em;'
        + 'box-shadow:0 -2px 12px rgba(0,0,0,.35);pointer-events:none;';
      document.body.appendChild(el);
      _bannerEl = el;
    } else if (!on && _bannerEl) {
      _bannerEl.remove();
      _bannerEl = null;
    }
  }
  // 讀不到設定表時不掛橫幅:賽事當天一次網路抖動不該讓正式成績被標成測試資料。
  // 演練開跑前會先確認橫幅有出現,再往下走。
  function refreshTestMode() {
    return fetchSheet('0_賽事設定').then(function (rows) {
      var v = liveSwitchFrom(rows);
      setTestBanner(v === 0);
      return v;
    }).catch(function () { return null; });
  }
  function watchTestMode(intervalMs) {
    refreshTestMode();
    var timer = setInterval(refreshTestMode, intervalMs || 45000);
    return function stop() { clearInterval(timer); };
  }

  // ---- 立刻載入一次並開始輪詢;每次成功才回呼 cb(data),失敗靜默略過該次 ----
  function onUpdate(cb, intervalMs) {
    intervalMs = intervalMs || 45000;
    function tick() {
      load().then(function (data) { if (data) cb(data); });
      refreshTestMode();
    }
    tick();
    var timer = setInterval(tick, intervalMs);
    return function stop() { clearInterval(timer); };
  }

  // ---- 各頁共用的狀態文字（三態一致呈現）----
  function fmtTime(d){
    try { return d.toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',hour12:false}); }
    catch(e){ return ''; }
  }
  function statusText(d){
    if (!d || d.state === 'cold') return { cls:'err', text:'連線失敗 · 尚無可用資料' };
    if (d.state === 'stale') return { cls:'warn',
      text:'連線異常 · 暫用上次成功資料（' + fmtTime(d.updatedAt) + '）' };
    return { cls:'ok', text:'更新於 ' + fmtTime(d.updatedAt) };
  }

  global.SolarCupLive = {
    SHEET_ID: SHEET_ID,
    fetchSheet: fetchSheet,
    load: load,
    onUpdate: onUpdate,
    statusText: statusText,
    fmtTime: fmtTime,
    watchTestMode: watchTestMode,
    refreshTestMode: refreshTestMode,
  };
})(typeof window !== 'undefined' ? window : this);
