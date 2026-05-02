const qs = (s)=>document.querySelector(s);
function setStatus(t){ qs('#status').textContent = t; }

async function injectContentScript(tabId){
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['content.css']
  });
}

async function sendToTab(msg){
  const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
  if(!tab?.id) throw new Error('Нет активной вкладки');
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch(e) {
    if(e.message?.includes('Receiving end does not exist') ||
       e.message?.includes('Could not establish connection')) {
      await injectContentScript(tab.id);
      await new Promise(r => setTimeout(r, 100));
      return chrome.tabs.sendMessage(tab.id, msg);
    }
    throw e;
  }
}

qs('#run').addEventListener('click', async ()=>{
  try{
    qs('#run').style.display='none';
    qs('#stop').style.display='block';
    setStatus('Запуск...');
    const resp = await sendToTab({
      type:'MAX_EXPORT_START',
      maxScrolls: parseInt(qs('#maxScrolls').value || '120', 10),
      delayMs: parseInt(qs('#delayMs').value || '350', 10),
      format: qs('#format').value,
      startDate: qs('#startDate').value || null,
      endDate: qs('#endDate').value || null
    });
    if(!resp?.ok){
      setStatus('Не удалось запустить: ' + (resp?.error || 'unknown'));
      qs('#run').style.display='block';
      qs('#stop').style.display='none';
    } else {
      setStatus('Запущено. Прогресс виден на странице.');
    }
  }catch(e){
    setStatus('Ошибка: ' + e.message);
    qs('#run').style.display='block';
    qs('#stop').style.display='none';
  }
});

qs('#stop').addEventListener('click', async ()=>{
  try{
    await sendToTab({type:'MAX_EXPORT_STOP'});
    setStatus('Остановлено.');
  }catch(e){
    setStatus('Ошибка: ' + e.message);
  } finally {
    qs('#run').style.display='block';
    qs('#stop').style.display='none';
  }
});
