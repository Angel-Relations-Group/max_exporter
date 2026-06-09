const SEL_HISTORY = 'div.history.svelte-1prjz03';
const SEL_ITEM = 'div.item.svelte-rg2upy';
const SEL_BUBBLE = 'div.bubble.svelte-1htnb3l';
const SEL_TEXT = 'span.text.svelte-1htnb3l';

let RUNNING = false;
let SHOULD_STOP = false;

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

function numericIdToUrlId(numericId) {
  const n = BigInt(numericId);
  const hex = n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, '0');
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(String.fromCharCode(parseInt(hex.substr(i, 2), 16)));
  }
  return btoa(bytes.join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let _resolvedSlug = null;

async function findChannelSlug() {
  if (_resolvedSlug) return _resolvedSlug;
  const urlSlug = location.pathname.split('/').filter(Boolean)[0] || 'unknown';
  if (!/^-?\d+$/.test(urlSlug)) { _resolvedSlug = urlSlug; return urlSlug; }

  if (slugMap.has(urlSlug)) { _resolvedSlug = slugMap.get(urlSlug); return _resolvedSlug; }
  const noMinus = urlSlug.replace(/^-/, '');
  if (slugMap.has(noMinus)) { _resolvedSlug = slugMap.get(noMinus); return _resolvedSlug; }

  const ogUrl = document.querySelector('meta[property="og:url"]');
  if (ogUrl) {
    const content = ogUrl.getAttribute('content') || '';
    const m = content.match(/max\.ru\/([a-zA-Z][a-zA-Z0-9_]{2,})/);
    if (m) { _resolvedSlug = m[1]; return _resolvedSlug; }
  }

  try {
    const slug = await new Promise((resolve) => {
      chrome.runtime.sendMessage({type: 'MAX_EXPORT_RESOLVE_SLUG', numericSlug: urlSlug}, (resp) => {
        resolve(resp?.ok ? resp.slug : null);
      });
    });
    if (slug) { _resolvedSlug = slug; return slug; }
  } catch(e) {}

  _resolvedSlug = urlSlug;
  return urlSlug;
}

const wsMessages = new Map();
const slugMap = new Map();

(function initWSInterception() {
  window.addEventListener('message', function(e) {
    if (!e.data) return;
    if (e.data.type === 'MAX_EXPORT_WS_MSG') {
      if (e.data.id && !wsMessages.has(e.data.id)) {
        wsMessages.set(e.data.id, {
          id: e.data.id,
          text: e.data.text || '',
          time: e.data.time || 0,
          views: e.data.views || 0,
          reactions: e.data.reactions || 0,
          msgType: e.data.msgType || ''
        });
      }
    }
    if (e.data.type === 'MAX_EXPORT_SLUG_MAP') {
      if (e.data.slug && e.data.id) {
        slugMap.set(String(e.data.id), e.data.slug);
      }
    }
  });

  chrome.runtime.sendMessage({type: 'MAX_EXPORT_INJECT_WS'});
})();

(function checkPendingExport() {
  const pending = sessionStorage.getItem('max_export_pending');
  if (!pending) return;
  sessionStorage.removeItem('max_export_pending');

  const params = JSON.parse(pending);

  (async () => {
    const panel = ensurePanel();
    panel.style.display = 'block';
    panel.querySelector('#max-exporter-stop').style.display = 'block';
    setProgress('Перезагрузка... ожидание WS...');

    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      if (document.querySelector(SEL_HISTORY) &&
          document.querySelector(SEL_ITEM)) break;
    }

    let prevWs = 0;
    let stable = 0;
    while (stable < 3) {
      await sleep(1000);
      setProgress(`Ожидание WS... захвачено: ${wsMessages.size}`);
      if (wsMessages.size === prevWs) {
        stable++;
      } else {
        stable = 0;
        prevWs = wsMessages.size;
      }
    }

    RUNNING = true;
    doExport(params).catch(e => {
      setProgress('Ошибка: ' + e.message);
      RUNNING = false;
    });
  })();
})();

function ensurePanel(){
  let el = document.getElementById('max-exporter-panel');
  if(el) return el;
  el = document.createElement('div');
  el.id = 'max-exporter-panel';
  el.innerHTML = `
    <div style="font-weight:700;margin-bottom:6px;">MAX Export</div>
    <div class="muted">Экспорт сообщений: целевое количество + сортировка по времени.</div>
    <div id="max-exporter-progress" class="mono" style="margin-top:8px;">Готов.</div>
    <button id="max-exporter-stop" style="display:none;">Стоп</button>
    <button id="max-exporter-close-panel" style="display:none;">Закрыть</button>
  `;
  document.documentElement.appendChild(el);
  el.querySelector('#max-exporter-stop').addEventListener('click', ()=>{ SHOULD_STOP = true; });
  el.querySelector('#max-exporter-close-panel').addEventListener('click', ()=>{ el.style.display = 'none'; });
  return el;
}
function setProgress(t){
  ensurePanel().querySelector('#max-exporter-progress').textContent = t;
}

function parseInputDate(dateStr) {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;
  return date;
}

function formatWsTime(epochMs) {
  if (!epochMs) return '';
  const d = new Date(epochMs);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}.${month}.${year} ${hours}:${minutes}`;
}

function csvSafe(v){
  let s = v == null ? '' : String(v);
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return '"' + s.replace(/"/g, '""') + '"';
}

function toExcelCsv(rows){
  const header = ['datetime','post_link','text','links','views','reactions_total'];
  const lines = [];
  lines.push(header.map(csvSafe).join(';'));
  for(const r of rows){
    lines.push([
      csvSafe(r.datetime || ''),
      csvSafe(r.post_link || ''),
      csvSafe(r.text || ''),
      csvSafe((r.links || []).join(' ')),
      csvSafe(r.views ?? ''),
      csvSafe(r.reactions_total ?? '')
    ].join(';'));
  }
  return '\uFEFF' + lines.join('\r\n');
}

function downloadViaBackground(blob, filename){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    chrome.runtime.sendMessage({type:'MAX_EXPORT_DOWNLOAD', url, filename}, (resp) => {
      URL.revokeObjectURL(url);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!resp?.ok) {
        reject(new Error(resp?.error || 'Download failed'));
      } else {
        resolve(resp);
      }
    });
  });
}

function validateRequiredElements(){
  return !!(document.querySelector(SEL_HISTORY) && document.querySelector(SEL_ITEM));
}

function getScrollable() {
  const history = document.querySelector(SEL_HISTORY);
  if (!history) return null;
  let el = history.querySelector('.scrollable');
  if (el) return el;
  for (const child of history.querySelectorAll('*')) {
    if (child.scrollHeight > child.clientHeight + 1) {
      const style = getComputedStyle(child);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay') return child;
    }
  }
  return null;
}

function scrollChatToTop() {
  const scrollable = getScrollable();
  if (scrollable) {
    scrollable.scrollTop = 0;
    scrollable.dispatchEvent(new Event('scroll', { bubbles: true }));
  }
}

function scrollChatToBottom() {
  const scrollable = getScrollable();
  if (scrollable) {
    scrollable.scrollTop = scrollable.scrollHeight;
    scrollable.dispatchEvent(new Event('scroll', { bubbles: true }));
  }
}

function getMinWsTimeAfter(skipCount) {
  let idx = 0;
  let minT = Infinity;
  for (const m of wsMessages.values()) {
    if (idx >= skipCount && m.time > 0 && m.time < minT) minT = m.time;
    idx++;
  }
  return minT < Infinity ? minT : 0;
}

function getDomMessages() {
  const msgs = [];
  const history = document.querySelector(SEL_HISTORY);
  if (!history) return msgs;
  history.querySelectorAll(SEL_ITEM).forEach(node => {
    const bubble = node.querySelector(SEL_BUBBLE);
    let text = '';
    if (bubble) {
      const textEl = bubble.querySelector(SEL_TEXT);
      text = textEl ? textEl.innerText : bubble.innerText;
    }
    text = (text || '').replace(/\u00A0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length > 2) msgs.push(text);
  });
  return msgs;
}

function cleanText(text) {
  return (text || '').replace(/[^\p{L}\p{N}]/gu, ' ').replace(/\s+/g, ' ').trim().substring(0, 150).toLowerCase();
}

function exportPosts(params) {
  sessionStorage.setItem('max_export_pending', JSON.stringify(params));
  location.reload();
}

async function doExport(params) {
  const {maxScrolls, delayMs, format, startDate, endDate, startDateSet, endDateSet, paginationEnabled, paginationRows} = params;

  if(!validateRequiredElements()){
    setProgress('Ошибка: не найдены элементы чата на странице');
    return;
  }

  SHOULD_STOP = false;

  const parsedStartDate = parseInputDate(startDate);
  const parsedEndDate = parseInputDate(endDate);
  const startMs = parsedStartDate ? parsedStartDate.getTime() : 0;
  const endMs = parsedEndDate ? parsedEndDate.getTime() + 86400000 : Infinity;
  const useDateRange = !!(startDateSet && parsedStartDate) || !!(endDateSet && parsedEndDate);

  const effectiveMaxScrolls = useDateRange ? 9999 : Math.min(maxScrolls, 500);
  let stableRounds = 0;
  let prevDomCount = 0;

  setProgress(`Скролл... WS до скролла: ${wsMessages.size}`);
  const wsCountBeforeScroll = wsMessages.size;

  scrollChatToBottom();
  await sleep(800);

  function reachedStartDate() {
    const wsMin = getMinWsTimeAfter(wsCountBeforeScroll);
    return wsMin > 0 && wsMin < startMs;
  }

  for(let i = 1; i <= effectiveMaxScrolls; i++){
    if(SHOULD_STOP) break;

    if(useDateRange && reachedStartDate()) {
      const wsMin = getMinWsTimeAfter(wsCountBeforeScroll);
      setProgress(`Дата начала достигнута (${formatWsTime(wsMin)}). WS: ${wsMessages.size}`);
      break;
    }

    scrollChatToTop();
    await sleep(delayMs || 500);

    if(useDateRange && reachedStartDate()) {
      const wsMin = getMinWsTimeAfter(wsCountBeforeScroll);
      setProgress(`Дата начала достигнута (${formatWsTime(wsMin)}). WS: ${wsMessages.size}`);
      break;
    }

    const history = document.querySelector(SEL_HISTORY);
    const curDomCount = history ? history.querySelectorAll(SEL_ITEM).length : 0;

    if(curDomCount === prevDomCount) {
      stableRounds++;
    } else {
      stableRounds = 0;
      prevDomCount = curDomCount;
    }

    setProgress(`Шаг ${i}/${effectiveMaxScrolls} | WS: ${wsMessages.size} | DOM: ${curDomCount}`);

    if(!useDateRange && stableRounds >= 12) break;
    if(useDateRange && stableRounds >= 20) break;
  }

  await sleep(1000);

  const slug = await findChannelSlug();

  const wsByText = new Map();
  for (const m of wsMessages.values()) {
    if (!m.text || m.text.length === 0) continue;
    const key = cleanText(m.text);
    if (!wsByText.has(key)) wsByText.set(key, m);
  }

  const domMsgs = getDomMessages();
  const seen = new Set();
  let results = [];

  for (const domText of domMsgs) {
    const dc = cleanText(domText);
    if (seen.has(dc)) continue;
    seen.add(dc);

    const ws = wsByText.get(dc);
    if (ws) {
      results.push({
        time: ws.time,
        id: ws.id,
        text: domText,
        views: ws.views || 0,
        reactions: ws.reactions || 0
      });
    }
  }

  if(useDateRange) {
    results = results.filter(m => m.time >= startMs && m.time <= endMs);
  }

  results.sort((a, b) => a.time - b.time);

  const out = results.map(m => ({
    datetime: m.time ? formatWsTime(m.time) : '',
    post_link: m.id ? `https://max.ru/${slug}/${numericIdToUrlId(m.id)}` : '',
    text: m.text,
    links: [],
    views: m.views || '',
    reactions_total: m.reactions || ''
  }));

  try {
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    const chunkSize = (paginationEnabled && paginationRows > 0) ? paginationRows : out.length;
    const totalParts = Math.ceil(out.length / chunkSize);

    for (let part = 0; part < totalParts; part++) {
      const chunk = out.slice(part * chunkSize, (part + 1) * chunkSize);
      const suffix = totalParts > 1 ? `_part${part + 1}of${totalParts}` : '';

      if(format === 'json'){
        const blob = new Blob([JSON.stringify(chunk, null, 2)], {type:'application/json'});
        await downloadViaBackground(blob, `max_${slug}_${ts}${suffix}.json`);
      } else {
        const csv = toExcelCsv(chunk);
        const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
        await downloadViaBackground(blob, `max_${slug}_${ts}${suffix}.csv`);
      }
    }

    const partInfo = totalParts > 1 ? ` в ${totalParts} файлах (${chunkSize} строк/файл)` : '';
    setProgress(`Готово.
${format.toUpperCase()}: ${out.length} сообщений${partInfo}
Файл должен был начать скачиваться.`);
  } catch (e) {
    setProgress(`Ошибка скачивания:\n${e.message}`);
  } finally {
    RUNNING = false;
    ensurePanel().querySelector('#max-exporter-stop').style.display = 'none';
    ensurePanel().querySelector('#max-exporter-close-panel').style.display = 'block';
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  if(msg?.type === 'MAX_EXPORT_START'){
    if(RUNNING){
      sendResponse({ok:false, error:'Уже запущено'});
      return true;
    }
    RUNNING = true;
    sendResponse({ok:true});
    exportPosts(msg);
    return true;
  }
  if(msg?.type === 'MAX_EXPORT_STOP'){
    SHOULD_STOP = true;
    sendResponse({ok:true});
    return true;
  }
});
