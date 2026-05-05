let RUNNING = false;
let SHOULD_STOP = false;

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

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

function normalizeText(t){
  return (t || '')
    .replace(/\u00A0/g,' ')
    .replace(/[ \t]+\n/g,'\n')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
}

// Функция для преобразования даты ввода в дату для сравнения
function parseInputDate(dateStr) {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;
  return date;
}

// Функция для извлечения даты из элемента сообщения или текста капсулы
function extractDateFromNode(node) {
  let capsuleText = null;
  
  if (typeof node === 'string') {
    capsuleText = node;
  } else {
    const capsule = node.querySelector('span.capsule.svelte-3850xr');
    if (capsule) capsuleText = capsule.textContent;
  }
  
  if (!capsuleText) return null;
  
  const text = capsuleText.trim();
  const now = new Date();
  
  if (text === 'Сегодня') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  
  if (text === 'Вчера') {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate());
  }
  
  const months = {
    'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3,
    'мая': 4, 'июня': 5, 'июля': 6, 'августа': 7,
    'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11
  };
  
  const match = text.match(/(\d+)\s+(\S+)\s+(\d+)/);
  if (match) {
    const day = parseInt(match[1], 10);
    const monthName = match[2].toLowerCase();
    const year = parseInt(match[3], 10);
    const month = months[monthName];
    
    if (month !== undefined && !isNaN(day) && !isNaN(year)) {
      return new Date(year, month, day);
    }
  }
  
  return null;
}

// Функция для форматирования даты в строку
function formatDate(date) {
  if (!date || !(date instanceof Date) || isNaN(date.getTime())) {
    return null;
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${day}.${month}.${year}`;
}

function dateOnly(d){
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Проверяет, является ли текст содержимым сообщения
function looksLikePostText(text){
  if(!text || text.length < 2) return false;
  
  // Исключаем служебные сообщения
  const bad = [
    'Канал создан',
    'Канал закрепил',
    'включить уведомления',
    'непрочитанных чата',
    'теперь в max',
    'напишите что-нибудь',
    'новые сообщения',
    'поиск',
    'все чаты',
    'все каналы',
    'загружено',
    'загрузка',
    'MAX Export',
    'Экспорт сообщений'
  ];
  
  const t = text.toLowerCase();
  return !bad.some(x => t.includes(x));
}

// Собирает все кандидаты - элементы сообщений
function collectCandidates(){
  const candidates = [];
  const seenNodes = new Set();
  
  // Находим контейнер с историей сообщений
  const historyContainer = document.querySelector('div.history.svelte-1prjz03');
  if(!historyContainer) {
    console.log('MAX Export: Контейнер history.svelte-1prjz03 не найден');
    return candidates;
  }
  
  // Ищем сообщения ТОЛЬКО внутри контейнера history
  historyContainer.querySelectorAll('div.item.svelte-rg2upy').forEach(n => {
    if(!seenNodes.has(n)) {
      seenNodes.add(n);
      candidates.push(n);
    }
  });
  
  return candidates;
}

function extractPostFromNode(node, extractedDate){
  // Проверяем, что это сообщение
  if(!node.classList.contains('item') || !node.classList.contains('svelte-rg2upy')) {
    return null;
  }
  
  // Исключаем блоки с названием канала
  if(node.querySelector('div.wrapper.wrapper--group.svelte-51ce9l')) {
    return null;
  }
  
  // Исключаем блоки с закрепленным сообщением
  if(node.querySelector('div.container.svelte-fxkkld')) {
    return null;
  }
  
  // Проверяем, является ли это кружком (short video)
  const isCircle = node.querySelector('div.videoMessage');
  
  const nodeDate = extractedDate !== undefined ? extractedDate : extractDateFromNode(node);
  
  let text = '';
  
  if(isCircle) {
    // Это кружок - текст = "Кружок"
    text = 'Кружок';
  } else {
    // Извлекаем текст сообщения - ищем внутри bubble
    // Структура: div.bubble > span.text или просто текст внутри bubble
    const bubble = node.querySelector('div.bubble.svelte-1htnb3l');
    if(bubble) {
      const textEl = bubble.querySelector('span.text.svelte-1htnb3l');
      if(textEl) {
        text = normalizeText(textEl.innerText);
      } else {
        // Фоллбек - текст напрямую внутри bubble (может быть с Svelte комментариями)
        text = normalizeText(bubble.innerText);
      }
    }
    
    // Если не нашли в bubble, пробуем весь элемент
    if(!text) {
      const textEl = node.querySelector('span.text.svelte-1htnb3l');
      if(textEl) {
        text = normalizeText(textEl.innerText);
      } else {
        text = normalizeText(node.innerText);
      }
    }
  }
  
  // Удаляем время длительности из текста (для кружков)
  if(isCircle) {
    const timeEl = node.querySelector('div.time.svelte-2z8dlw');
    if(timeEl) {
      const timeText = timeEl.textContent;
      if(timeText) {
        text = text.replace(timeText, '').trim();
      }
    }
  }
  
  // Проверяем, является ли текст содержимым сообщения
  if(!isCircle && !looksLikePostText(text)) {
    console.log('MAX Export: Filtered text:', text.substring(0, 50));
    return null;
  }
  
  // Извлекаем реакции: ищем все элементы счетчиков внутри элемента
  let reactions = null;
  const counterElements = node.querySelectorAll('[class*="counter svelte-"]');
  let total = 0;
  let hasReactions = false;
  counterElements.forEach(c => {
    const counterText = (c.textContent || '').replace(/\u00A0/g, ' ').trim();
    const numMatch = counterText.match(/^(\d+)$/);
    if(numMatch) {
      const n = parseInt(numMatch[1], 10);
      if(Number.isFinite(n) && n >= 0) {
        total += n;
        hasReactions = true;
      }
    }
  });
  if(hasReactions) reactions = total;
  
  // Извлекаем просмотры и время из мета-блока
  // Для кружков: div.meta.svelte-2z8dlw, для обычных: span.meta.svelte-1htnb3l
  const metaEl = node.querySelector('div.meta.svelte-2z8dlw, span.meta.svelte-1htnb3l');
  let views = null;
  let datetime = '';
  
  if(metaEl) {
    // Ищем просмотры - ищем любой span с class containing "views" и svelte-
    const viewsSpan = metaEl.querySelector('[class*="views svelte-"]');
    if(viewsSpan) {
      // Извлекаем текст просмотров (например "16,3K" или "1.2M")
      const viewsText = viewsSpan.textContent || '';
      const viewsNumMatch = viewsText.match(/([\d.,]+\s*[kкmм]?)/i);
      if(viewsNumMatch) {
        // Сохраняем оригинальный текст вместо парсинга в число
        views = viewsNumMatch[1].trim();
      }
    }
    
    // Ищем время - ищем текст вида HH:MM
    const metaText = metaEl.textContent || '';
    const timeMatch = metaText.match(/(\d{1,2}:\d{2})/);
    if(timeMatch) {
      const time = timeMatch[1];
      // Формируем дату-время: если есть информация о дате - добавляем её
      const formattedDate = formatDate(nodeDate);
      if (formattedDate) {
        datetime = `${formattedDate} ${time}`;
      } else {
        datetime = time;
      }
    }
  }
  
  const links = Array.from(node.querySelectorAll('a[href]'))
    .map(a=>a.href)
    .filter(h=>h && !h.startsWith('javascript:'));
  
  // Извлекаем медиа из блока <div class="media svelte-1htnb3l">
  const images = [];
  const mediaEl = node.querySelector('div.media.svelte-1htnb3l');
  if(mediaEl) {
    // Ищем все изображения внутри медиа-блока
    mediaEl.querySelectorAll('img[src]').forEach(img => {
      if(img.src) images.push(img.src);
    });
    // Ищем ссылки на изображения/видео
    mediaEl.querySelectorAll('a[href]').forEach(a => {
      const href = a.href;
      if(href && !href.startsWith('javascript:') && 
         (href.match(/\.(jpg|jpeg|png|gif|webp|mp4|webm)/i) || href.includes('media') || href.includes('image'))) {
        images.push(href);
      }
    });
  }
  // Также ищем img в остальной части сообщения (если не в медиа-блоке)
  node.querySelectorAll('img[src]').forEach(img => {
    if(img.src && !images.includes(img.src)) {
      images.push(img.src);
    }
  });
  
  return {
    datetime,
    text: text,
    links: Array.from(new Set(links)),
    views,
    reactions_total: reactions
  };
}

function postKey(p){
  const prefix = (p.text || '').slice(0, 200);
  return [p.datetime || '', prefix].join('|');
}

function csvSafe(v){
  let s = v == null ? '' : String(v);
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return '"' + s.replace(/"/g, '""') + '"';
}

function toExcelCsv(rows){
  const header = ['datetime','text','links','views','reactions_total'];
  const lines = [];
  lines.push(header.map(csvSafe).join(';'));
  for(const r of rows){
    lines.push([
      csvSafe(r.datetime || ''),
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

// Валидация: проверяем наличие необходимых элементов на странице
function validateRequiredElements(){
  const requiredSelectors = [
    { selector: 'div.history.svelte-1prjz03', name: 'История сообщений (div.history.svelte-1prjz03)' },
    { selector: 'div.item.svelte-rg2upy', name: 'Элемент сообщения (div.item.svelte-rg2upy)' }
  ];
  
  const missing = [];
  for(const {selector, name} of requiredSelectors){
    if(!document.querySelector(selector)){
      missing.push(name);
    }
  }
  
  if(missing.length > 0){
    console.warn('MAX Export: Отсутствуют необходимые элементы на странице:', missing);
  }
  
  return missing;
}

function showElementValidationError(missingElements){
  const el = ensurePanel();
  el.innerHTML = `
    <div style="font-weight:700;margin-bottom:6px;">MAX Export</div>
    <div class="muted" style="color: #dc3545; margin-bottom: 10px;">
      ⚠️ Не удалось найти необходимые элементы на странице.<br>
      Вероятно, структура сайта изменилась.<br>
      Пожалуйста, свяжитесь с нами для обновления:<br>
      <a href="mailto:cto@a-rg.com" style="color: #0d6efd;">cto@a-rg.com</a>
    </div>
    <div class="mono" style="font-size: 11px; margin-bottom: 10px;">
      Отсутствуют элементы:<br>
      ${missingElements.map(e => '• ' + e).join('<br>')}
    </div>
    <button id="max-exporter-close-error" style="">Закрыть</button>
  `;
  el.querySelector('#max-exporter-close-error').addEventListener('click', ()=>{ el.style.display = 'none'; });
}

function getScrollable() {
  const history = document.querySelector('div.history.svelte-1prjz03');
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
  const history = document.querySelector('div.history.svelte-1prjz03');
  if (history) {
    const firstItem = history.querySelector('div.item.svelte-rg2upy');
    if (firstItem) firstItem.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  window.scrollTo(0, 0);
}

function scrollChatToBottom() {
  const scrollable = getScrollable();
  if (scrollable) {
    scrollable.scrollTop = scrollable.scrollHeight;
    scrollable.dispatchEvent(new Event('scroll', { bubbles: true }));
  }
  const history = document.querySelector('div.history.svelte-1prjz03');
  if (history) {
    const items = history.querySelectorAll('div.item.svelte-rg2upy');
    if (items.length) items[items.length - 1].scrollIntoView({ block: 'end', behavior: 'instant' });
  }
  window.scrollTo(0, document.body.scrollHeight);
}

async function exportPosts({maxScrolls, delayMs, format, startDate, endDate}){
  // Всегда показываем панель при старте экспорта
  const panel = ensurePanel();
  panel.style.display = 'block';
  
  // Проверяем наличие необходимых элементов на странице
  const missingElements = validateRequiredElements();
  if(missingElements.length > 0){
    showElementValidationError(missingElements);
    return;
  }
  
  RUNNING = true;
  SHOULD_STOP = false;
  panel.querySelector('#max-exporter-stop').style.display = 'block';
  panel.querySelector('#max-exporter-close-panel').style.display = 'none';
  
  const seen = new Set();
  const out = [];
  let stableRounds = 0;
  let searchStableRounds = 0;
  let prevCandidateCount = 0;
  
  // Парсим даты
  const parsedStartDate = parseInputDate(startDate);
  const parsedEndDate = parseInputDate(endDate);
  const startDateOnly = parsedStartDate ? dateOnly(parsedStartDate) : null;
  const endDateOnly = parsedEndDate ? dateOnly(parsedEndDate) : null;
  
  // Флаг: режим фильтрации по датам (активен если указана хотя бы одна дата)
  const useDateRange = !!parsedStartDate || !!parsedEndDate;
  
  // Флаг: начали ли мы сбор (после прокрутки к startDate)
  // Если нет startDate - сразу начинаем сбор (режим только с endDate)
  let startedCollecting = !parsedStartDate;
  
  setProgress(`Собрано: 0`);
  
  // Прокручиваем в самый низ, чтобы начать с новых сообщений
  scrollChatToBottom();
  await sleep(1000);
  
  const effectiveMaxScrolls = parsedStartDate ? 9999 : maxScrolls;
  
  for(let i=1; i<=effectiveMaxScrolls; i++){
    if(SHOULD_STOP) break;
    
    if(useDateRange && !startedCollecting && parsedStartDate){
      const candidates = collectCandidates();
      let foundStartDate = false;
      let hasAnyDate = false;
      
      for(const node of candidates){
        const nodeDate = extractDateFromNode(node);
        if(nodeDate){
          hasAnyDate = true;
          if(dateOnly(nodeDate).getTime() < startDateOnly.getTime()){
            foundStartDate = true;
            break;
          }
        }
      }
      
      if(foundStartDate){
        startedCollecting = true;
        setProgress(`Указанная дата найдена. Начинаем сбор сообщений.`);
      } else {
        scrollChatToTop();
        await sleep(delayMs || 500);
        
        if(hasAnyDate){
          if(candidates.length === prevCandidateCount) {
            searchStableRounds++;
          } else {
            searchStableRounds = 0;
            prevCandidateCount = candidates.length;
          }
          
          if(searchStableRounds >= 10) {
            startedCollecting = true;
            setProgress(`Все сообщения новее начальной даты. Начинаем сбор...`);
          } else {
            setProgress(`Поиск даты (загрузка старых сообщений)`);
            continue;
          }
        } else {
          setProgress(`Поиск даты: ${i}/${effectiveMaxScrolls}`);
          continue;
        }
      }
    } else if(!parsedStartDate) {
      scrollChatToTop();
      await sleep(delayMs || 500);
    }
    
    // Сбор сообщений
    let added = 0;
    const allItems = collectCandidates();
    
    // Текущая дата (из последней найденной капсулы)
    let currentDate = null;
    
    for(let idx = 0; idx < allItems.length; idx++){
      const node = allItems[idx];
      
      // Проверяем, есть ли в этом элементе капсула с датой
      const capsule = node.querySelector('span.capsule.svelte-3850xr');
      if(capsule && useDateRange && parsedStartDate){
        const capsuleDate = extractDateFromNode(capsule.textContent);
        if(capsuleDate){
          if(dateOnly(capsuleDate).getTime() < startDateOnly.getTime()){
            currentDate = capsuleDate;
            continue;
          }
          currentDate = capsuleDate;
        }
      }
      
      // Обновляем текущую дату из узла, если она есть (для сообщений без капсулы, но после неё)
      const nodeDate = extractDateFromNode(node);
      if(nodeDate) {
        currentDate = nodeDate;
      }
      
      const p = extractPostFromNode(node, nodeDate);
      if(!p) continue;
      
      // Обновляем datetime, если есть текущая дата
      if (currentDate && p.datetime) {
        const formattedDate = formatDate(currentDate);
        if (formattedDate) {
          // Проверяем, не начинается ли datetime уже с даты (чтобы избежать дублирования)
          const datePattern = /^\d{2}\.\d{2}\.\d{4}\s/;
          if (!datePattern.test(p.datetime)) {
            // Заменяем время на дату+время
            p.datetime = `${formattedDate} ${p.datetime}`;
          }
        }
      }
      
      // Фильтрация по диапазону дат через datetime
      if(useDateRange && p.datetime){
        const dtMatch = p.datetime.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
        if(dtMatch){
          const msgDateOnly = new Date(parseInt(dtMatch[3]), parseInt(dtMatch[2]) - 1, parseInt(dtMatch[1]));
          if(startDateOnly && msgDateOnly.getTime() < startDateOnly.getTime()){
            continue;
          }
          if(endDateOnly && msgDateOnly.getTime() > endDateOnly.getTime()){
            continue;
          }
        }
      }
      
      const key = postKey(p);
      if(seen.has(key)) continue;
      seen.add(key);
      out.push(p);
      added++;
    }
    
    // Проверяем, появились ли новые сообщения
    if(added === 0) {
      stableRounds++;
    } else {
      stableRounds = 0;
    }
    
    // Формируем статус
    let statusText = `Шаг ${i}/${effectiveMaxScrolls}`;
    if(useDateRange && startedCollecting){
      statusText += ` (по датам)`;
    } else if(useDateRange){
      statusText += ` (поиск даты)`;
    }
    statusText += `\nСобрано: ${out.length}\n+ на шаге: ${added}`;
    setProgress(statusText);
    
    // Если в режиме дат и найдена конечная дата - проверяем, можно ли остановиться
    if(useDateRange && startedCollecting && parsedEndDate && added === 0 && stableRounds >= 3){
      // Дождались конца чата или прокрутили достаточно
      setProgress(`Достигнут конец диапазона дат.\nСобрано: ${out.length} сообщений`);
      break;
    }
    
    // Если долго нет новых сообщений - останавливаемся (только если не в режиме дат или уже начали сбор)
    if(!useDateRange && stableRounds >= 12) {
      setProgress(`Достигнут конец чата.\nСобрано: ${out.length} сообщений`);
      break;
    }
    
    // В режиме дат продолжаем прокрутку пока не найдем все сообщения (или не кончится чат)
    if(useDateRange && stableRounds >= 15) {
      setProgress(`Достигнут конец чата.\nСобрано: ${out.length} сообщений`);
      break;
    }
  }

  // Сортируем сообщения по времени (от старых к новым)
  out.sort((a, b) => {
    if(!a.datetime && !b.datetime) return 0;
    if(!a.datetime) return 1;
    if(!b.datetime) return -1;
    
    // Извлекаем дату из строки datetime (формат дд.мм.гггг чч:мм или чч:мм)
    const dateTimeA = a.datetime.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    const dateTimeB = b.datetime.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    
    // Если обе даты есть, сортируем по гггг.мм.дд
    if(dateTimeA && dateTimeB) {
      const sortKeyA = `${dateTimeA[3]}${dateTimeA[2]}${dateTimeA[1]}`; // ггггммдд
      const sortKeyB = `${dateTimeB[3]}${dateTimeB[2]}${dateTimeB[1]}`;
      return sortKeyA.localeCompare(sortKeyB);
    }
    
    // Если нет полной даты, используем исходную сортировку
    return a.datetime.localeCompare(b.datetime);
  });
  
  try {
    const channelSlug = location.pathname.split('/').filter(Boolean)[0] || 'channel';
    const ts = new Date().toISOString().replace(/[:.]/g,'-');

    if(format === 'json'){
      const blob = new Blob([JSON.stringify(out, null, 2)], {type:'application/json'});
      await downloadViaBackground(blob, `max_${channelSlug}_${ts}.json`);
      setProgress(`Готово.
JSON: ${out.length} сообщений
Файл должен был начать скачиваться.`);
    } else {
      const csv = toExcelCsv(out);
      const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
      await downloadViaBackground(blob, `max_${channelSlug}_${ts}.csv`);
      setProgress(`Готово.
CSV: ${out.length} сообщений
Файл должен был начать скачиваться.`);
    }
  } catch (e) {
    setProgress(`Ошибка скачивания:\n${e.message}`);
  } finally {
    RUNNING = false;
    panel.querySelector('#max-exporter-stop').style.display = 'none';
    panel.querySelector('#max-exporter-close-panel').style.display = 'block';
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  if(msg?.type === 'MAX_EXPORT_START'){
    if(RUNNING){
      sendResponse({ok:false, error:'Уже запущено'});
      return true;
    }
    exportPosts(msg).catch(e=>{
      setProgress('Ошибка: ' + (e?.message || String(e)));
      RUNNING = false;
      ensurePanel().querySelector('#max-exporter-stop').style.display = 'none';
      ensurePanel().querySelector('#max-exporter-close-panel').style.display = 'block';
    });
    sendResponse({ok:true});
    return true;
  }
  if(msg?.type === 'MAX_EXPORT_STOP'){
    SHOULD_STOP = true;
    sendResponse({ok:true});
    return true;
  }
});
