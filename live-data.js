/* ============================================================
   SOLAR CUP TWO · live-data.js · 共用雲端資料層（小傑・時間與排程總管）
   資料來源：雲端後端資料庫（Google Sheets, gviz CSV 匯出）
   純瀏覽器端 vanilla JS，無外部套件；各頁 <script src="live-data.js"></script> 即可用
   ============================================================ */
(function (global) {
  'use strict';

  var SHEET_ID = '1KqX0AJKHU8TR-t0hUZLqB6jib0tL7BbR';
  var CACHE_MS = 45000;
  var QUAL_LAST = 150;   // 資格賽最後一場的場次編號

  // sheetName -> {t:抓取時間戳, promise:進行中/已完成的 Promise<rows>, data:最後一次成功結果}
  var _cache = {};

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
        if (_cache[sheetName]) _cache[sheetName].data = rows;
        return rows;
      })
      .catch(function (err) {
        console.warn('[SolarCupLive] fetchSheet 失敗：', sheetName, err);
        return prevData || null;
      });
    _cache[sheetName] = { t: now, promise: promise, data: prevData };
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

      // 7_球團積分：代表球團,隊伍數,球團總分,排名,備註
      var clubScores = [];
      cRows.slice(1).forEach(function (r) {
        if (!r || !r[0]) return;
        var club = str(r[0]);
        if (!club) return;
        clubScores.push({ club: club, teams: num(r[1]) || 0, total: num(r[2]) || 0, rank: num(r[3]) });
      });

      return {
        matches: matches, qualRank: qualRank, teamScores: teamScores,
        clubScores: clubScores, hasReal: hasReal,
        qualDone: qualDone, qualTotal: QUAL_LAST, knockoutStarted: knockoutStarted,
        updatedAt: new Date(),
      };
    }).catch(function (err) {
      console.warn('[SolarCupLive] load 失敗：', err);
      return null;
    });
  }

  // ---- 立刻載入一次並開始輪詢;每次成功才回呼 cb(data),失敗靜默略過該次 ----
  function onUpdate(cb, intervalMs) {
    intervalMs = intervalMs || 45000;
    function tick() {
      load().then(function (data) { if (data) cb(data); });
    }
    tick();
    var timer = setInterval(tick, intervalMs);
    return function stop() { clearInterval(timer); };
  }

  global.SolarCupLive = {
    SHEET_ID: SHEET_ID,
    fetchSheet: fetchSheet,
    load: load,
    onUpdate: onUpdate,
  };
})(typeof window !== 'undefined' ? window : this);
