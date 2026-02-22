const $ = (sel) => document.querySelector(sel);

const store = {
  session: null,           // {userId,userName,role,token}
  catalog: null,           // { productsBySku:Map, skuByBarcode:Map, products:Array }
  drafts: { add: [], out: [] }, // local drafts
};

const LS_KEYS = {
  session: 'stock.session.v1',
  catalog: 'stock.catalog.v1',
  catalogTs: 'stock.catalog.ts.v1',
  draftAdd: 'stock.draft.add.v1',
  draftOut: 'stock.draft.out.v1',
};

init();

async function init() {
  loadSession();
  loadDrafts();
  wireTopbar();

  // Simple router
  window.addEventListener('popstate', render);
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (!a) return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
  });

  await ensureCatalogLoaded();
  render();
}

function wireTopbar() {
  $('#logoutBtn').addEventListener('click', () => {
    clearSession();
    clearDrafts();
    render();
  });
}

function navigate(path) {
  history.pushState({}, '', path);
  render();
}

function render() {
  const app = $('#app');
  const path = location.pathname;

  updateUserBadge();

  if (!store.session) {
    app.innerHTML = loginView();
    bindLogin();
    return;
  }

  if (path.endsWith('/add')) {
    app.innerHTML = addOutView({ mode: 'add' });
    bindAddOut({ mode: 'add' });
    return;
  }
  if (path.endsWith('/out')) {
    app.innerHTML = addOutView({ mode: 'out' });
    bindAddOut({ mode: 'out' });
    return;
  }
  if (path.endsWith('/status')) {
    app.innerHTML = statusView();
    bindStatus();
    return;
  }

  // default: dashboard
  app.innerHTML = dashboardView();
  bindDashboard();
}

function updateUserBadge() {
  const b = $('#userBadge');
  if (!store.session) { b.textContent = ''; return; }
  b.textContent = `${store.session.userName} · ${store.session.role}`;
}

// ---------- SESSION ----------
function loadSession() {
  try {
    const s = localStorage.getItem(LS_KEYS.session);
    store.session = s ? JSON.parse(s) : null;
  } catch { store.session = null; }
}
function saveSession() {
  localStorage.setItem(LS_KEYS.session, JSON.stringify(store.session));
}
function clearSession() {
  store.session = null;
  localStorage.removeItem(LS_KEYS.session);
}

function loadDrafts() {
  try { store.drafts.add = JSON.parse(localStorage.getItem(LS_KEYS.draftAdd) || '[]'); } catch { store.drafts.add = []; }
  try { store.drafts.out = JSON.parse(localStorage.getItem(LS_KEYS.draftOut) || '[]'); } catch { store.drafts.out = []; }
}
function saveDrafts() {
  localStorage.setItem(LS_KEYS.draftAdd, JSON.stringify(store.drafts.add));
  localStorage.setItem(LS_KEYS.draftOut, JSON.stringify(store.drafts.out));
}
function clearDrafts() {
  store.drafts = { add: [], out: [] };
  localStorage.removeItem(LS_KEYS.draftAdd);
  localStorage.removeItem(LS_KEYS.draftOut);
}

// ---------- CATALOG ----------
async function ensureCatalogLoaded() {
  // load cached
  const cached = localStorage.getItem(LS_KEYS.catalog);
  const ts = Number(localStorage.getItem(LS_KEYS.catalogTs) || '0');
  if (cached) {
    try {
      const obj = JSON.parse(cached);
      store.catalog = reviveCatalog(obj);
      // refresh in background if older than 30 min
      if (Date.now() - ts > 30 * 60 * 1000) refreshCatalog().catch(() => {});
      return;
    } catch {}
  }
  await refreshCatalog();
}

async function refreshCatalog() {
  const [productsCsv, barcodesCsv] = await Promise.all([
    fetchText(window.CONFIG.PRODUCTS_CSV),
    fetchText(window.CONFIG.BARCODES_CSV),
  ]);

  const products = parseCsv(productsCsv);
  const barcodes = parseCsv(barcodesCsv);

  const productsBySku = new Map();
  for (const p of products) {
    const sku = String(p['מק"ט'] || '').trim();
    if (!sku) continue;
    productsBySku.set(sku, p);
  }

  const skuByBarcode = new Map();
  for (const b of barcodes) {
    const code = String(b['ברקוד'] || '').trim();
    const sku = String(b['מק"ט מוצר'] || '').trim();
    if (!code || !sku) continue;
    skuByBarcode.set(code, sku);
  }

  store.catalog = { products, productsBySku, skuByBarcode };
  persistCatalog();
}

function persistCatalog() {
  // serialize maps
  const obj = {
    products: store.catalog.products,
    productsBySku: Array.from(store.catalog.productsBySku.entries()),
    skuByBarcode: Array.from(store.catalog.skuByBarcode.entries()),
  };
  localStorage.setItem(LS_KEYS.catalog, JSON.stringify(obj));
  localStorage.setItem(LS_KEYS.catalogTs, String(Date.now()));
}

function reviveCatalog(obj) {
  return {
    products: obj.products || [],
    productsBySku: new Map(obj.productsBySku || []),
    skuByBarcode: new Map(obj.skuByBarcode || []),
  };
}

async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('Fetch failed: ' + url);
  return await res.text();
}

// Minimal CSV parser with quotes support
function parseCsv(text) {
  const rows = [];
  let i = 0, field = '', row = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { rows.push(row); row = []; };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { inQuotes = false; i++; continue; }
      field += c; i++; continue;
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { pushField(); i++; continue; }
      if (c === '\n') { pushField(); pushRow(); i++; continue; }
      if (c === '\r') { i++; continue; }
      field += c; i++; continue;
    }
  }
  pushField();
  if (row.length > 1 || row[0] !== '') pushRow();

  const headers = rows.shift().map(h => String(h).trim());
  return rows
    .filter(r => r.some(x => String(x).trim() !== ''))
    .map(r => {
      const o = {};
      headers.forEach((h, idx) => o[h] = r[idx] ?? '');
      return o;
    });
}

// ---------- API ----------
async function apiPost(payload) {
  const res = await fetch(window.CONFIG.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'API error');
  return data;
}

async function apiGet(params) {
  const url = new URL(window.CONFIG.API_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), { cache: 'no-store' });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'API error');
  return data;
}

// ---------- VIEWS ----------
function loginView() {
  return `
    <section class="card">
      <div class="h1">כניסה</div>
      <div class="row">
        <div class="col">
          <label>ID משתמש</label>
          <input id="loginUserId" class="input" placeholder="לדוגמה: 123" autocomplete="off"/>
        </div>
        <div class="col">
          <label>קוד</label>
          <input id="loginCode" class="input" placeholder="••••" type="password" inputmode="numeric" autocomplete="off"/>
        </div>
      </div>
      <div class="row" style="margin-top:10px">
        <button id="loginBtn" class="btn btn-primary">התחבר</button>
        <span id="loginErr" class="small"></span>
      </div>
      <div class="small" style="margin-top:8px">טיפ: סורק בלוטוס יפעל במסכים הבאים בשדה הברקוד.</div>
    </section>
  `;
}

function dashboardView() {
  const ts = Number(localStorage.getItem(LS_KEYS.catalogTs) || '0');
  const ageMin = ts ? Math.round((Date.now() - ts) / 60000) : null;

  return `
    <section class="card">
      <div class="h1">תפריט</div>
      <div class="row">
        <a class="btn btn-primary" data-link href="/stock/add">הוספה למלאי</a>
        <a class="btn btn-primary" data-link href="/stock/out">הוצאה מהמלאי</a>
        <a class="btn btn-primary" data-link href="/stock/status">מצב מוצר</a>
      </div>
      <div class="row" style="margin-top:10px">
        <span class="pill">קטלוג עודכן לפני: ${ageMin === null ? 'לא ידוע' : `${ageMin} דק׳`}</span>
        <button id="refreshCatalogBtn" class="btn">רענון קטלוג</button>
      </div>
    </section>

    <section class="card">
      <div class="h1">מוצרים (פילטרים + מיון)</div>

      <div class="row">
        <div class="col">
          <label>חיפוש (שם/מק"ט)</label>
          <input id="q" class="input" placeholder="הקלד..." />
        </div>
        <div class="col">
          <label>מותג</label>
          <select id="brand" class="input"><option value="">הכול</option></select>
        </div>
        <div class="col">
          <label>ספק</label>
          <select id="vendor" class="input"><option value="">הכול</option></select>
        </div>
        <div class="col">
          <label>פסח</label>
          <select id="pesach" class="input">
            <option value="">הכול</option>
            <option value="כן">כן</option>
            <option value="לא">לא</option>
          </select>
        </div>
        <div class="col">
          <label>מיון</label>
          <select id="sort" class="input">
            <option value="name_asc">שם (א-ת)</option>
            <option value="name_desc">שם (ת-א)</option>
            <option value="stock_desc">מלאי (גבוה->נמוך)</option>
            <option value="stock_asc">מלאי (נמוך->גבוה)</option>
          </select>
        </div>
      </div>

      <div style="overflow:auto;margin-top:10px">
        <table class="table" id="productsTable">
          <thead>
            <tr>
              <th>תמונה</th><th>מק"ט</th><th>שם</th><th>סה"כ</th><th>מותג</th><th>ספק</th><th>פסח</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </section>
  `;
}

function addOutView({ mode }) {
  const title = mode === 'add' ? 'הוספה למלאי' : 'הוצאה מהמלאי';
  const actionLabel = mode === 'add' ? 'הוסף למלאי' : 'הוצא מהמלאי';
  const draftCount = (mode === 'add' ? store.drafts.add : store.drafts.out).length;

  return `
    <section class="card">
      <div class="h1">${title}</div>

      <div class="row">
        <div class="col">
          <label>ברקוד</label>
          <input id="barcodeInput" class="input" placeholder="סרוק / הקלד" autocomplete="off"/>
          <div class="small">סריקה תבצע חיפוש אוטומטי. ידני: לחץ חיפוש.</div>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-end">
          <button id="findBtn" class="btn">חיפוש</button>
          <button id="summaryBtn" class="btn btn-ghost">סיכום (${draftCount})</button>
          <a class="btn btn-ghost" data-link href="/stock">לתפריט</a>
        </div>
      </div>

      <div id="productPane" class="card" style="display:none"></div>
    </section>

    <section id="summaryPane" class="card" style="display:none"></section>
  `;
}

function statusView() {
  return `
    <section class="card">
      <div class="h1">מצב מוצר</div>
      <div class="row">
        <div class="col">
          <label>ברקוד</label>
          <input id="statusBarcode" class="input" placeholder="סרוק / הקלד" autocomplete="off"/>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-end">
          <button id="statusFind" class="btn">חיפוש</button>
          <a class="btn btn-ghost" data-link href="/stock">לתפריט</a>
        </div>
      </div>
      <div id="statusOut" class="card" style="display:none"></div>
    </section>
  `;
}

// ---------- BINDERS ----------
function bindLogin() {
  $('#logoutBtn').style.display = 'none';
  $('#userBadge').textContent = '';
  $('#loginBtn').addEventListener('click', doLogin);
  $('#loginCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('#loginUserId').focus();

  async function doLogin() {
    const userId = $('#loginUserId').value.trim();
    const code = $('#loginCode').value.trim();
    $('#loginErr').textContent = '...';

    try {
      const data = await apiPost({ action: 'auth_login', userId, code });
      store.session = { userId: data.userId, userName: data.userName, role: data.role, token: data.token };
      saveSession();
      $('#logoutBtn').style.display = '';
      navigate('/stock');
    } catch (err) {
      $('#loginErr').textContent = 'שגיאה: ' + err.message;
    }
  }
}

function bindDashboard() {
  $('#logoutBtn').style.display = '';
  $('#refreshCatalogBtn').addEventListener('click', async () => {
    $('#refreshCatalogBtn').textContent = 'מרענן...';
    try {
      await refreshCatalog();
      render();
    } finally {
      $('#refreshCatalogBtn').textContent = 'רענון קטלוג';
    }
  });

  // fill filters
  const brands = uniq(store.catalog.products.map(p => String(p['מותג'] || '').trim()).filter(Boolean));
  const vendors = uniq(store.catalog.products.map(p => String(p['ספק'] || '').trim()).filter(Boolean));
  fillSelect($('#brand'), brands);
  fillSelect($('#vendor'), vendors);

  const apply = () => {
    const q = ($('#q').value || '').trim();
    const brand = $('#brand').value;
    const vendor = $('#vendor').value;
    const pesach = $('#pesach').value;
    const sort = $('#sort').value;
    const rows = filterAndSortProducts({ q, brand, vendor, pesach, sort });
    renderProductsTable(rows);
  };

  ['q','brand','vendor','pesach','sort'].forEach(id => {
    const el = $('#'+id);
    el.addEventListener('input', apply);
    el.addEventListener('change', apply);
  });

  apply();
}

function filterAndSortProducts({ q, brand, vendor, pesach, sort }) {
  let rows = store.catalog.products.slice();

  if (q) {
    const ql = q.toLowerCase();
    rows = rows.filter(p => {
      const name = String(p['שם מוצר'] || '').toLowerCase();
      const sku = String(p['מק"ט'] || '').toLowerCase();
      return name.includes(ql) || sku.includes(ql);
    });
  }
  if (brand) rows = rows.filter(p => String(p['מותג'] || '').trim() === brand);
  if (vendor) rows = rows.filter(p => String(p['ספק'] || '').trim() === vendor);

  if (pesach) {
    rows = rows.filter(p => {
      const v = String(p['פסח'] || '').trim();
      // normalize common values
      if (pesach === 'כן') return v === 'כן' || v === 'true' || v === '1';
      if (pesach === 'לא') return v === 'לא' || v === '' || v === 'false' || v === '0';
      return true;
    });
  }

  const stockNum = (p) => Number(String(p['סה"כ במלאי'] || '0').replace(',', '.')) || 0;
  const nameVal = (p) => String(p['שם מוצר'] || '');

  rows.sort((a,b) => {
    switch (sort) {
      case 'name_desc': return nameVal(b).localeCompare(nameVal(a), 'he');
      case 'stock_desc': return stockNum(b) - stockNum(a);
      case 'stock_asc': return stockNum(a) - stockNum(b);
      default: return nameVal(a).localeCompare(nameVal(b), 'he');
    }
  });

  return rows;
}

function renderProductsTable(rows) {
  const tbody = $('#productsTable tbody');
  tbody.innerHTML = rows.slice(0, 2000).map(p => {
    const img = String(p['תמונה'] || '').trim();
    const sku = String(p['מק"ט'] || '').trim();
    const name = String(p['שם מוצר'] || '').trim();
    const stock = String(p['סה"כ במלאי'] || '').trim();
    const brand = String(p['מותג'] || '').trim();
    const vendor = String(p['ספק'] || '').trim();
    const pesach = String(p['פסח'] || '').trim();
    return `
      <tr>
        <td>${img ? `<img class="thumb" src="${escapeHtml(img)}" alt=""/>` : ''}</td>
        <td><span class="kbd">${escapeHtml(sku)}</span></td>
        <td>${escapeHtml(name)}</td>
        <td>${escapeHtml(stock)}</td>
        <td>${escapeHtml(brand)}</td>
        <td>${escapeHtml(vendor)}</td>
        <td>${escapeHtml(pesach)}</td>
      </tr>
    `;
  }).join('');
}

function bindAddOut({ mode }) {
  $('#logoutBtn').style.display = '';

  const input = $('#barcodeInput');
  const findBtn = $('#findBtn');
  const summaryBtn = $('#summaryBtn');
  const productPane = $('#productPane');
  const summaryPane = $('#summaryPane');

  // Heuristic: barcode scanners type fast then Enter
  let lastTs = 0;
  let buffer = '';

  input.addEventListener('keydown', (e) => {
    const now = Date.now();
    if (now - lastTs > 80) buffer = ''; // reset if slow typing
    lastTs = now;

    if (e.key === 'Enter') {
      e.preventDefault();
      doFind();
      return;
    }
    // build buffer
    if (e.key.length === 1) buffer += e.key;
  });

  findBtn.addEventListener('click', doFind);
  summaryBtn.addEventListener('click', toggleSummary);

  function findSkuByBarcodeLocal(barcode) {
    return store.catalog.skuByBarcode.get(barcode) || '';
  }

  function doFind() {
    const code = input.value.trim();
    if (!code) return;
    const sku = findSkuByBarcodeLocal(code);
    if (!sku) {
      productPane.style.display = '';
      productPane.innerHTML = `<div class="h1">לא נמצא</div><div class="small">ברקוד ${escapeHtml(code)} לא נמצא בטבלת ברקודים.</div>`;
      return;
    }
    const p = store.catalog.productsBySku.get(sku);
    if (!p) {
      productPane.style.display = '';
      productPane.innerHTML = `<div class="h1">בעיה</div><div class="small">נמצא מק"ט ${escapeHtml(sku)} אבל אין מוצר בטבלת מוצרים.</div>`;
      return;
    }
    renderProductAction(p, code);
  }

  function renderProductAction(p, barcode) {
    const sku = String(p['מק"ט'] || '').trim();
    const name = String(p['שם מוצר'] || '').trim();
    const img = String(p['תמונה'] || '').trim();
    const stock = Number(String(p['סה"כ במלאי'] || '0').replace(',', '.')) || 0;

    productPane.style.display = '';
    productPane.innerHTML = `
      <div class="row">
        <div style="width:70px">${img ? `<img class="thumb" src="${escapeHtml(img)}" alt=""/>` : ''}</div>
        <div class="col">
          <div class="h1">${escapeHtml(name)}</div>
          <div class="small">מק"ט: <span class="kbd">${escapeHtml(sku)}</span> · מלאי: <span class="kbd">${stock}</span></div>
        </div>
      </div>

      <div class="row" style="margin-top:10px">
        <div class="col">
          <label>כמות</label>
          <input id="qty" class="input" type="number" inputmode="numeric" min="1" value="1"/>
        </div>
        <div class="col">
          <label>הערות</label>
          <input id="notes" class="input" placeholder="אופציונלי"/>
        </div>
      </div>

      <div class="row" style="margin-top:10px">
        <button id="m10" class="btn">-10</button>
        <button id="m5" class="btn">-5</button>
        <button id="m1" class="btn">-1</button>
        <button id="p1" class="btn">+1</button>
        <button id="p5" class="btn">+5</button>
        <button id="p10" class="btn">+10</button>
        <div class="spacer"></div>
        <button id="submitMove" class="btn btn-primary">${mode === 'add' ? 'הוסף למלאי' : 'הוצא מהמלאי'}</button>
      </div>

      <div id="msg" class="small" style="margin-top:8px"></div>
    `;

    const qtyEl = $('#qty');
    const bump = (d) => {
      const v = Number(qtyEl.value || 1) || 1;
      qtyEl.value = String(Math.max(1, v + d));
      qtyEl.focus();
    };
    $('#m10').onclick = () => bump(-10);
    $('#m5').onclick = () => bump(-5);
    $('#m1').onclick = () => bump(-1);
    $('#p1').onclick = () => bump(+1);
    $('#p5').onclick = () => bump(+5);
    $('#p10').onclick = () => bump(+10);

    $('#submitMove').onclick = async () => {
      const qty = Number(qtyEl.value);
      const notes = ($('#notes').value || '').trim();
      const source = mode === 'add' ? 'כניסה' : 'יציאה';

      // minus warning (client-side)
      if (source === 'יציאה') {
        const newStock = stock - qty;
        if (newStock < 0) {
          const ok = confirm(`זה יכניס למינוס (${newStock}). להמשיך?`);
          if (!ok) return;
        }
      }

      $('#msg').textContent = 'שולח...';

      try {
        const data = await apiPost({
          action: 'movement_add',
          token: store.session.token,
          sku,
          barcode,
          qty,
          notes,
          source
        });

        // Save to draft
        const entry = { ts: Date.now(), sku, name, barcode, qty, source, notes };
        if (mode === 'add') store.drafts.add.unshift(entry);
        else store.drafts.out.unshift(entry);
        saveDrafts();

        // UX: clear + focus for next scan
        input.value = '';
        input.focus();
        $('#msg').textContent = 'בוצע ✓';
      } catch (err) {
        $('#msg').textContent = 'שגיאה: ' + err.message;
      }
    };
  }

  function toggleSummary() {
    const list = mode === 'add' ? store.drafts.add : store.drafts.out;
    summaryPane.style.display = summaryPane.style.display === 'none' ? '' : 'none';
    if (summaryPane.style.display === 'none') return;

    summaryPane.innerHTML = `
      <div class="h1">סיכום (${list.length})</div>
      <div class="small">עד שתלחץ "סיימתי" זה נשמר רק בדפדפן וניתן לראות כאן.</div>
      <div style="overflow:auto;margin-top:10px">
        <table class="table">
          <thead><tr><th>זמן</th><th>מק"ט</th><th>שם</th><th>ברקוד</th><th>כמות</th><th>מקור</th><th>הערות</th></tr></thead>
          <tbody>
            ${list.map(x => `
              <tr>
                <td>${new Date(x.ts).toLocaleString('he-IL')}</td>
                <td><span class="kbd">${escapeHtml(x.sku)}</span></td>
                <td>${escapeHtml(x.name)}</td>
                <td><span class="kbd">${escapeHtml(x.barcode)}</span></td>
                <td>${x.qty}</td>
                <td>${escapeHtml(x.source)}</td>
                <td>${escapeHtml(x.notes)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="row" style="margin-top:10px">
        <button id="finishBtn" class="btn btn-primary">סיימתי (נקה זיכרון)</button>
      </div>
    `;

    $('#finishBtn').onclick = () => {
      if (!confirm('לנקות את הסיכום מהזיכרון המקומי?')) return;
      if (mode === 'add') store.drafts.add = [];
      else store.drafts.out = [];
      saveDrafts();
      toggleSummary();
      render();
    };
  }

  input.focus();
}

function bindStatus() {
  $('#logoutBtn').style.display = '';
  const input = $('#statusBarcode');
  const btn = $('#statusFind');
  const out = $('#statusOut');

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); run(); }
  });
  btn.addEventListener('click', run);
  input.focus();

  async function run() {
    const code = input.value.trim();
    if (!code) return;

    try {
      const data = await apiGet({ action: 'product_status', token: store.session.token, barcode: code });
      const p = data.product;

      const img = String(p['תמונה'] || '').trim();
      out.style.display = '';
      out.innerHTML = `
        <div class="row">
          <div style="width:70px">${img ? `<img class="thumb" src="${escapeHtml(img)}" alt=""/>` : ''}</div>
          <div class="col">
            <div class="h1">${escapeHtml(String(p['שם מוצר'] || ''))}</div>
            <div class="small">מק"ט: <span class="kbd">${escapeHtml(String(p['מק"ט']||''))}</span></div>
          </div>
        </div>

        <div class="row" style="margin-top:10px">
          <span class="pill">מחסן: ${escapeHtml(String(p['מצב מלאי מחסן']||''))}</span>
          <span class="pill">ליקוט: ${escapeHtml(String(p['מצב מלאי ליקוט']||''))}</span>
          <span class="pill">סה"כ: ${escapeHtml(String(p['סה"כ במלאי']||''))}</span>
        </div>

        <div class="h1" style="margin-top:12px">תנועות אחרונות</div>
        <div style="overflow:auto">
          <table class="table">
            <thead><tr><th>תאריך</th><th>שעה</th><th>מקור</th><th>כמות</th><th>הערות</th><th>מדווח</th></tr></thead>
            <tbody>
              ${(data.lastMovements || []).map(m => `
                <tr>
                  <td>${fmtDate(m['תאריך דיווח'])}</td>
                  <td>${fmtTime(m['שעת דיווח'])}</td>
                  <td>${escapeHtml(String(m['מקור']||''))}</td>
                  <td>${escapeHtml(String(m['כמות']||''))}</td>
                  <td>${escapeHtml(String(m['הערות']||''))}</td>
                  <td>${escapeHtml(String(m['שם מדווח']||m['ID מדווח']||''))}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    } catch (err) {
      out.style.display = '';
      out.innerHTML = `<div class="h1">שגיאה</div><div class="small">${escapeHtml(err.message)}</div>`;
    }
  }
}

// ---------- SMALL UTILS ----------
function uniq(arr) {
  return Array.from(new Set(arr));
}
function fillSelect(sel, values) {
  values.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    sel.appendChild(opt);
  });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtDate(v) {
  try {
    if (!v) return '';
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString('he-IL');
  } catch { return String(v||''); }
}
function fmtTime(v) {
  try {
    if (!v) return '';
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleTimeString('he-IL', {hour:'2-digit', minute:'2-digit'});
  } catch { return String(v||''); }
}
