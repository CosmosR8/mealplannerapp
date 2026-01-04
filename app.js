 (function(){
  const $ = (id) => document.getElementById(id);
  const cfg = window.MEALPLANNER_CONFIG;
  const form = $('plannerForm');
  const out = $('output');
  const groceryOut = $('groceryList');
  const statusEl = $('status');
  const btnStop = $('btnStop');
  const btnCopy = $('btnCopy');
  const btnAmazon = $('btnAmazonCart');
  const btnIngredients = $('btnIngredients');
  const modal = $('ingredientsModal');
  const btnCloseModal = $('btnCloseModal');
  const ingredientsContent = $('ingredientsContent');

  const STORAGE_KEY_PLAN = 'mealplanner_last_plan_text';
  const STORAGE_KEY_GROCERY = 'mealplanner_last_grocery';

  let abort = new AbortController();

  function setStatus(msg){ statusEl.textContent = msg || ''; }
  function escapeHtml(str){
    return (str||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function todayAsDateInputValue(){
    const d = new Date();
    const tz = new Date(d.getTime() - d.getTimezoneOffset()*60000);
    return tz.toISOString().slice(0,10);
  }

  function renderPantry(){
    const pantry = cfg.approvedPantry || {};
    const parts = [];
    for (const [section, items] of Object.entries(pantry)){
      parts.push(`<h4>${escapeHtml(section)}</h4><ul>`);
      (items||[]).forEach(it => parts.push(`<li>${escapeHtml(it)}</li>`));
      parts.push('</ul>');
    }
    ingredientsContent.innerHTML = parts.join('\n');
  }

  function amazonCartUrl(items){
    const base = 'https://www.amazon.com/gp/aws/cart/add.html';
    const params = [];
    (items||[]).forEach((it, idx) => {
      const n = idx+1;
      if (!it || !it.asin) return;
      const q = Number(it.qty || 1);
      params.push(`ASIN.${n}=${encodeURIComponent(it.asin)}`);
      params.push(`Quantity.${n}=${encodeURIComponent(String(q))}`);
    });
    params.push(`tag=${encodeURIComponent(cfg.amazonAffiliateTag || '')}`);
    return base + '?' + params.join('&');
  }

  function parseCartItemsFromText(text){
    const re = /\b(B0[0-9A-Z]{8}|B[0-9A-Z]{9})\b(?:[^\n\r]*?\b(x|qty|quantity)\s*[:]?\s*(\d+))?/gi;
    const counts = new Map();
    let m;
    while ((m = re.exec(text||''))){
      const asin = m[1].toUpperCase();
      const qty = m[3] ? parseInt(m[3],10) : 1;
      counts.set(asin, (counts.get(asin)||0) + (isFinite(qty)?qty:1));
    }
    return Array.from(counts.entries()).map(([asin, qty]) => ({asin, qty}));
  }

  async function apiFetch(path, options={}){
    const url = cfg.endpoint.replace(/\/$/, '') + path;
    const headers = { 'Content-Type':'application/json', 'api-key': cfg.apiKey, ...(options.headers||{}) };
    const res = await fetch(url, { ...options, headers, signal: abort.signal });
    if (!res.ok){
      const txt = await res.text().catch(()=> '');
      throw new Error(`API ${res.status}: ${txt || res.statusText}`);
    }
    return res.json();
  }

  async function runPlanner(userText){
    const thread = await apiFetch('/threads', { method:'POST', body: JSON.stringify({}) });
    const threadId = thread.id || thread.threadId || thread.thread_id;
    if (!threadId) throw new Error('Thread id not found');

    await apiFetch(`/threads/${encodeURIComponent(threadId)}/messages`, {
      method:'POST',
      body: JSON.stringify({ role:'user', content:[{type:'text', text:userText}] })
    });

    const run = await apiFetch(`/threads/${encodeURIComponent(threadId)}/runs`, { method:'POST', body: JSON.stringify({}) });
    const runId = run.id || run.runId || run.run_id;

    // Poll run status if supported
    const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
    for (let i=0;i<60;i++){
      if (abort.signal.aborted) throw new Error('Cancelled');
      try{
        const s = await apiFetch(`/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}`, { method:'GET' });
        const st = (s.status||s.state||'').toLowerCase();
        if (['completed','succeeded','finished'].includes(st)) break;
        if (['failed','cancelled','canceled','error'].includes(st)) throw new Error(`Run ended: ${st}`);
      }catch(e){ /* ignore if endpoint not supported */ }
      setStatus(`Working… (${i+1})`);
      await sleep(2000);
    }

    const msgs = await apiFetch(`/threads/${encodeURIComponent(threadId)}/messages`, { method:'GET' });
    const data = msgs.data || msgs.messages || [];
    const assistant = data.find(m => (m.role||'').toLowerCase()==='assistant') || data[data.length-1];
    const parts = (assistant && assistant.content) ? assistant.content : [];
    let text='';
    for (const p of parts){
      if (p.type==='text'){
        if (typeof p.text==='string') text += p.text + '\n';
        else if (p.text && typeof p.text.value==='string') text += p.text.value + '\n';
      }
    }
    text = text.trim();
    if (!text) throw new Error('No assistant text returned');
    return text;
  }

  function buildPrompt(inputs){
    const lines=[];
    lines.push(`Generate a 7-day high-protein meal plan starting on ${inputs.startDate}.`);
    lines.push(`User weight: ${inputs.weight} lbs. Target calories/day: ${inputs.calories}.`);
    lines.push(`Variety setting: ${inputs.variety}.`);
    if (inputs.allergies) lines.push(`Allergies: ${inputs.allergies}.`);
    lines.push(`Avoid items: ${inputs.avoid || 'seafood'}.`);
    lines.push('Output human-readable text only with prep time and macros per item + daily totals.');
    lines.push('Include a grocery list section at the end (human-readable).');
    if (inputs.reuse){
      const last = localStorage.getItem(STORAGE_KEY_PLAN);
      lines.push(last ? 'Reuse last week’s plan where appropriate, updating dates.' : 'Reuse requested but none stored; generate new.');
    }
    return lines.join('\n');
  }

  function splitGroceryList(text){
    const rx = /\n\s*(grocery list|shopping list|ingredients)\s*[:\-]?\s*\n/i;
    const m = rx.exec(text);
    if (!m) return {plan:text, grocery:''};
    const idx = m.index;
    return { plan: text.slice(0, idx).trim(), grocery: text.slice(idx).trim() };
  }

  function renderBlock(title, text){
    return `<div><div class="muted" style="font-size:12px;margin-bottom:6px">${escapeHtml(title)}</div><pre style="white-space:pre-wrap;margin:0">${escapeHtml(text)}</pre></div>`;
  }

  function setOutput(planText, groceryText){
    out.innerHTML = renderBlock('Meal Plan', planText);
    groceryOut.innerHTML = groceryText ? renderBlock('Grocery List', groceryText) : '<p class="muted">No grocery list section detected.</p>';
    btnCopy.disabled = false;

    const parsed = parseCartItemsFromText(groceryText || planText);
    const items = parsed.length ? parsed : (cfg.starterCartItems || []);
    btnAmazon.removeAttribute('disabled');
    btnAmazon.href = amazonCartUrl(items);

    localStorage.setItem(STORAGE_KEY_PLAN, planText);
    localStorage.setItem(STORAGE_KEY_GROCERY, groceryText || '');
  }

function validateConfig(){
  if (!cfg || !cfg.endpoint) throw new Error('Missing endpoint in config.js');
  if (!cfg.agentId) throw new Error('Missing agentId in config.js');
}

  function setGenerating(on){
    $('btnGenerate').disabled = on;
    btnStop.disabled = !on;
  }

  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    abort = new AbortController();
    setGenerating(true);
    setStatus('Starting…');
    out.innerHTML = '<p class="muted">Generating…</p>';
    groceryOut.innerHTML = '<p class="muted">Generating…</p>';
    btnCopy.disabled = true;
    btnAmazon.setAttribute('disabled','disabled');

    try{
      validateConfig();
      const inputs = {
        weight: $('weight').value,
        calories: $('calories').value,
        startDate: $('startDate').value,
        allergies: $('allergies').value.trim(),
        avoid: $('avoid').value.trim(),
        variety: $('variety').value,
        reuse: $('reuseLastWeek').checked
      };
      const prompt = buildPrompt(inputs);
      const text = await runPlanner(prompt);
      const s = splitGroceryList(text);
      setOutput(s.plan, s.grocery);
      setStatus('Done');
    }catch(err){
      console.error(err);
      out.innerHTML = `<p class="muted">Error:</p><pre style="white-space:pre-wrap">${escapeHtml(String(err.message||err))}</pre>`;
      groceryOut.innerHTML = '<p class="muted">—</p>';
      setStatus('');
    }finally{
      setGenerating(false);
    }
  });

  btnStop.addEventListener('click', ()=>{ abort.abort(); setStatus('Stopped'); setGenerating(false); });

  btnCopy.addEventListener('click', async ()=>{
    const t = (out.innerText||'').trim();
    if (!t) return;
    try{ await navigator.clipboard.writeText(t); setStatus('Copied'); setTimeout(()=>setStatus(''),1200);}catch{ setStatus('Copy failed'); }
  });

  btnIngredients.addEventListener('click', ()=>{ renderPantry(); modal.showModal?.(); });
  btnCloseModal.addEventListener('click', ()=> modal.close());

  $('startDate').value = todayAsDateInputValue();
})();
