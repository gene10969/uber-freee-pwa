const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const DB_NAME = 'uber-freee-tax-pwa';
const STORE = 'records';
let db;
let deferredPrompt;

function yen(n){ return `¥${Number(n||0).toLocaleString('ja-JP')}`; }
function today(){ return new Date().toISOString().slice(0,10); }
function uid(){ return `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2600); }
function toISODate(y,m,d){ return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }

function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,1);
    req.onupgradeneeded=()=>req.result.createObjectStore(STORE,{keyPath:'id'});
    req.onsuccess=()=>{db=req.result; resolve(db)};
    req.onerror=()=>reject(req.error);
  });
}
function tx(mode='readonly'){ return db.transaction(STORE,mode).objectStore(STORE); }
function getAll(){ return new Promise((resolve)=>{ const r=tx().getAll(); r.onsuccess=()=>resolve(r.result||[]); }); }
function put(record){ return new Promise((resolve)=>{ const r=tx('readwrite').put(record); r.onsuccess=()=>resolve(); }); }
function clearDB(){ return new Promise((resolve)=>{ const r=tx('readwrite').clear(); r.onsuccess=()=>resolve(); }); }
function deleteRecord(id){ return new Promise((resolve)=>{ const r=tx('readwrite').delete(id); r.onsuccess=()=>resolve(); }); }
async function cleanupBrokenUber(){ const records=await getAll(); const bad=records.filter(r=>r.source==='UberEats PDF' && (!Number(r.amount) || Number(r.amount)<=0)); for(const r of bad) await deleteRecord(r.id); if(bad.length) toast(`${bad.length}件の0円Uber取込データを自動削除しました`); }

async function saveMany(records){ for(const r of records) await put(r); await render(); }

function parseAmount(str){
  if(!str) return 0;
  const m=String(str).replace(/[￥¥,\s]/g,'').match(/-?\d+/);
  return m ? Number(m[0]) : 0;
}
function pick(pattern,text){ const m=text.match(pattern); return m ? m[1] : ''; }
function normalizePdfText(text){
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[¥￥]\s+/g, '￥')
    .replace(/\s+/g, ' ')
    .trim();
}
function parseJapanesePeriod(text){
  const t = normalizePdfText(text);
  const m = t.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日[\s\S]{0,80}?[-–—－〜~][\s\S]{0,80}?(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if(!m) return {from:'',to:'',year:new Date().getFullYear(), ok:false};
  return {from:toISODate(m[1],m[2],m[3]), to:toISODate(m[4],m[5],m[6]), year:Number(m[4]), ok:true};
}
function yenAfterLabel(text, label, mode='first'){
  const t = normalizePdfText(text);
  const re = new RegExp(label + '[^￥¥-]{0,80}[-]?[￥¥]\\s*([0-9][0-9,]*)', 'g');
  const vals = [];
  let m;
  while((m = re.exec(t)) !== null) vals.push(parseAmount(m[1]));
  if(!vals.length) return 0;
  return mode === 'last' ? vals[vals.length - 1] : vals[0];
}
function parseUberSummary(text){
  const t = normalizePdfText(text);
  const detailStart = t.indexOf('売り上げ の明細');
  const detail = detailStart >= 0 ? t.slice(detailStart, detailStart + 800) : t;
  const sales = yenAfterLabel(detail, '売り上げ', 'last') || yenAfterLabel(t, '最終残高', 'last');
  const fee = yenAfterLabel(detail, '配送料', 'first');
  const quest = yenAfterLabel(detail, 'クエスト', 'first');
  const tip = yenAfterLabel(detail, 'チップ', 'first');
  const payout = yenAfterLabel(t, '銀行口座に振り込まれました', 'first') || yenAfterLabel(t, '銀行口座に振込済み', 'first') || 0;
  return {sales, fee, quest, tip, payout};
}

async function readPdfText(file){
  if(!window.pdfjsLib) throw new Error('PDF解析ライブラリを読み込めませんでした。ネット接続を確認してください。');
  pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const data=await file.arrayBuffer();
  const pdf=await pdfjsLib.getDocument({data}).promise;
  let full='';
  for(let i=1;i<=pdf.numPages;i++){
    const page=await pdf.getPage(i);
    const content=await page.getTextContent();
    full += content.items.map(it=>it.str).join(' ') + '\n';
  }
  return full;
}

function parseUberPdf(text,fileName){
  const period=parseJapanesePeriod(text);
  const {sales, fee, quest, tip, payout}=parseUberSummary(text);
  if(!period.ok) throw new Error('明細期間を読み取れませんでした。UberEatsの週次明細PDFか確認してください。');
  if(!sales || sales <= 0) throw new Error('売上金額を読み取れませんでした。PDFの文字情報が取得できていない可能性があります。');
  return [{
    id: `uber-${period.from}-${period.to}-${sales}`, type:'income', source:'UberEats PDF', date:period.to, amount:sales,
    partner:'Uber Eats', account:'売上高', tax:'課税売上10%',
    memo:`${period.from}〜${period.to} UberEats売上 / 配送料 ${yen(fee)} / クエスト ${yen(quest)} / チップ ${yen(tip)} / 振込 ${yen(payout)}`,
    details:{fileName, period, fee, quest, tip, payout}, createdAt:new Date().toISOString()
  }];
}

async function handleUberPDF(e){
  const files=[...e.target.files]; if(!files.length) return;
  $('#uberPreview').innerHTML='<div class="item">PDFを解析中...</div>';
  const records=[];
  for(const file of files){
    try{ records.push(...parseUberPdf(await readPdfText(file), file.name)); }
    catch(err){ $('#uberPreview').innerHTML=`<div class="item">${file.name}<br>${err.message}</div>`; return; }
  }
  await saveMany(records);
  $('#uberPreview').innerHTML=records.map(r=>`<div class="item"><div class="item-row"><b>${r.date}</b><b>${yen(r.amount)}</b></div><span>${r.memo}</span></div>`).join('');
  toast('UberEats明細を保存しました');
}

async function imageToDataUrl(file){ return new Promise((res)=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.readAsDataURL(file); }); }
async function handleReceiptImage(e){
  const file=e.target.files[0]; if(!file) return;
  const url=await imageToDataUrl(file);
  $('#receiptPreview').innerHTML=`<img src="${url}" alt="レシート画像"><p class="muted">画像を保存しました。OCR補助を実行中です。</p>`;
  $('#expenseDate').value ||= today();
  try{
    if(window.Tesseract){
      const result=await Tesseract.recognize(url,'jpn+eng');
      const text=result.data.text || '';
      const amounts=[...text.matchAll(/[￥¥]?\s*([0-9]{2,3}(?:,[0-9]{3})+|[0-9]{3,})/g)].map(m=>parseAmount(m[1])).filter(n=>n>0);
      if(amounts.length) $('#expenseAmount').value=Math.max(...amounts);
      const lines=text.split('\n').map(s=>s.trim()).filter(Boolean);
      if(lines[0] && !$('#expenseVendor').value) $('#expenseVendor').value=lines[0].slice(0,30);
      $('#expenseMemo').value = `画像保存: ${file.name}`;
    }
  }catch(err){ $('#expenseMemo').value = `画像保存: ${file.name} / OCR未反映`; }
}

async function handleExpenseSubmit(e){
  e.preventDefault();
  const r={id:uid(),type:'expense',source:'manual/receipt',date:$('#expenseDate').value,partner:$('#expenseVendor').value,amount:Number($('#expenseAmount').value),account:$('#expenseCategory').value,tax:'課税仕入10%',memo:$('#expenseMemo').value,createdAt:new Date().toISOString()};
  await put(r); e.target.reset(); $('#expenseDate').value=today(); $('#receiptPreview').innerHTML=''; await render(); toast('経費を保存しました');
}

function parseCSV(text){
  const rows=[]; let row=[],cur='',q=false;
  for(let i=0;i<text.length;i++){ const c=text[i],n=text[i+1]; if(c==='"'&&q&&n==='"'){cur+='"';i++;} else if(c==='"'){q=!q;} else if(c===','&&!q){row.push(cur);cur='';} else if((c==='\n'||c==='\r')&&!q){ if(cur||row.length){row.push(cur);rows.push(row);row=[];cur='';} if(c==='\r'&&n==='\n')i++; } else cur+=c; }
  if(cur||row.length){row.push(cur);rows.push(row);} return rows;
}
function normalizeDate(v){
  v=String(v||'').trim();
  let m=v.match(/(20\d{2})[\/.-](\d{1,2})[\/.-](\d{1,2})/); if(m) return toISODate(m[1],m[2],m[3]);
  m=v.match(/(\d{1,2})[\/.-](\d{1,2})/); if(m) return toISODate(new Date().getFullYear(),m[1],m[2]);
  return today();
}
async function handleCardCSV(e){
  const file=e.target.files[0]; if(!file) return;
  const text=await file.text(); const rows=parseCSV(text).filter(r=>r.some(c=>String(c).trim()));
  const header=rows[0].map(h=>String(h).trim());
  const data=rows.slice(1);
  const dateIdx=header.findIndex(h=>/日付|利用日|ご利用日|取引日/.test(h));
  const memoIdx=header.findIndex(h=>/内容|摘要|加盟店|利用店|明細|支払先/.test(h));
  const amountIdx=header.findIndex(h=>/金額|利用額|支払額|請求額/.test(h));
  const records=data.map(r=>({id:uid(),type:'expense',source:'credit-card-csv',date:normalizeDate(r[dateIdx>=0?dateIdx:0]),partner:(r[memoIdx>=0?memoIdx:1]||'クレジットカード利用').trim(),amount:Math.abs(parseAmount(r[amountIdx>=0?amountIdx:r.length-1])),account:'未分類',tax:'対象外/確認',memo:`クレカ明細CSV: ${file.name}`,createdAt:new Date().toISOString()})).filter(r=>r.amount>0);
  await saveMany(records);
  $('#cardPreview').innerHTML=`<div class="item"><b>${records.length}件を取り込みました</b><span>必要に応じてfreee側で勘定科目を調整してください。</span></div>`;
  toast('クレカCSVを保存しました');
}
async function handleCardImage(e){
  const file=e.target.files[0]; if(!file) return;
  const url=await imageToDataUrl(file);
  const r={id:uid(),type:'expense',source:'credit-card-image',date:today(),partner:'クレカ明細スクショ',amount:0,account:'未分類',tax:'対象外/確認',memo:`スクショ保存: ${file.name}`,image:url,createdAt:new Date().toISOString()};
  await put(r); await render(); $('#cardPreview').innerHTML='<div class="item">スクショを保存しました。金額は後で手入力してください。</div>'; toast('スクショを保存しました');
}

function freeeRows(records){
  return [['発生日','収支区分','勘定科目','取引先','金額','摘要','税区分','メモ'],...records.map(r=>[r.date,r.type==='income'?'収入':'支出',r.account||'',r.partner||'',r.amount,r.memo||'',r.tax||'',r.source||''])];
}
function csvEscape(v){ v=String(v??''); return /[",\n]/.test(v)?`"${v.replaceAll('"','""')}"`:v; }
function download(name, text, type='text/csv;charset=utf-8'){ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([text],{type})); a.download=name; a.click(); URL.revokeObjectURL(a.href); }
async function exportFreee(){
  const from=$('#exportFrom').value || '0000-01-01', to=$('#exportTo').value || '9999-12-31';
  const records=(await getAll()).filter(r=>r.date>=from&&r.date<=to&&Number(r.amount)>0).sort((a,b)=>a.date.localeCompare(b.date));
  const csv='\ufeff'+freeeRows(records).map(row=>row.map(csvEscape).join(',')).join('\n');
  download(`freee_import_${from}_${to}.csv`,csv); toast('CSVを出力しました');
}
async function exportBackup(){ download(`uber_freee_backup_${today()}.json`, JSON.stringify(await getAll(),null,2), 'application/json'); }
async function restoreBackup(e){
  const file=e.target.files[0]; if(!file) return;
  const data=JSON.parse(await file.text());
  if(!Array.isArray(data)) return toast('復元できない形式です');
  await saveMany(data); toast('バックアップを復元しました');
}

async function render(){
  const records=(await getAll()).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const years=[...new Set(records.map(r=>(r.date||'').slice(0,4)).filter(Boolean))].sort().reverse();
  const yf=$('#yearFilter'); const current=yf.value || years[0] || String(new Date().getFullYear());
  yf.innerHTML=years.map(y=>`<option ${y===current?'selected':''}>${y}</option>`).join('') || `<option>${current}</option>`;
  const year=current;
  const filtered=records.filter(r=>(r.date||'').startsWith(year));
  const income=filtered.filter(r=>r.type==='income').reduce((s,r)=>s+Number(r.amount||0),0);
  const exp=filtered.filter(r=>r.type==='expense').reduce((s,r)=>s+Number(r.amount||0),0);
  $('#yearTotal').textContent=yen(income); $('#yearExpense').textContent=yen(exp); $('#yearProfit').textContent=yen(income-exp);
  const months={};
  filtered.forEach(r=>{ const m=(r.date||'').slice(0,7); months[m]??={income:0,expense:0,count:0}; months[m][r.type]+=Number(r.amount||0); months[m].count++; });
  $('#monthlyList').innerHTML=Object.entries(months).sort((a,b)=>b[0].localeCompare(a[0])).map(([m,v])=>`<div class="item"><div class="item-row"><b>${m}</b><b>${yen(v.income-v.expense)}</b></div><span>売上 ${yen(v.income)} / 経費 ${yen(v.expense)} / ${v.count}件</span></div>`).join('') || '<div class="item">まだデータがありません</div>';
  $('#recentList').innerHTML=records.slice(0,10).map(itemHTML).join('') || '<div class="item">まだデータがありません</div>';
  $('#allRecords').innerHTML=records.map(itemHTML).join('') || '<div class="item">まだデータがありません</div>';
}
function itemHTML(r){ return `<div class="item"><div class="item-row"><b>${r.date} ${r.type==='income'?'収入':'支出'}</b><b>${yen(r.amount)}</b></div><span>${r.partner||''} / ${r.account||''}</span><small>${r.memo||''}</small></div>`; }

function bind(){
  $$('.tab').forEach(btn=>btn.addEventListener('click',()=>{ $$('.tab,.panel').forEach(el=>el.classList.remove('active')); btn.classList.add('active'); $('#'+btn.dataset.tab).classList.add('active'); }));
  $('#uberPdfInput').addEventListener('change',handleUberPDF);
  $('#receiptInput').addEventListener('change',handleReceiptImage);
  $('#expenseForm').addEventListener('submit',handleExpenseSubmit);
  $('#cardCsvInput').addEventListener('change',handleCardCSV);
  $('#cardImageInput').addEventListener('change',handleCardImage);
  $('#exportFreeeBtn').addEventListener('click',exportFreee);
  $('#exportBackupBtn').addEventListener('click',exportBackup);
  $('#restoreInput').addEventListener('change',restoreBackup);
  $('#clearAllBtn').addEventListener('click',async()=>{ if(confirm('全データを削除しますか？')){ await clearDB(); await render(); toast('削除しました'); } });
  $('#yearFilter').addEventListener('change',render);
  window.addEventListener('beforeinstallprompt',(e)=>{ e.preventDefault(); deferredPrompt=e; $('#installBtn').classList.remove('hidden'); });
  $('#installBtn').addEventListener('click',async()=>{ if(deferredPrompt){ deferredPrompt.prompt(); deferredPrompt=null; $('#installBtn').classList.add('hidden'); } });
}

(async function init(){
  await openDB(); await cleanupBrokenUber(); bind(); $('#expenseDate').value=today(); $('#exportFrom').value=`${new Date().getFullYear()}-01-01`; $('#exportTo').value=today(); await render();
  if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
})();
