// /api/fuel — Güncel akaryakıt fiyatları (Türkiye ortalaması, tüm illerin ortalaması)
// Vercel sunucu fonksiyonu. Sonuç 6 saat önbelleğe alınır → kaynaklara günde en fazla ~4 istek.
// Kaynaklar (anahtarsız, herkese açık):
//   1) Opet fiyat servisi  → benzin + motorin (tüm iller tek istekte)
//   2) Petrol Ofisi sayfası → LPG (otogaz) ve benzin yedeği
//   3) ucuzyakitbul.com.tr → son çare
//   4) data/fuel-fallback.json → elle yazılan yedek

const FALLBACK = require('../data/fuel-fallback.json');

const BOUNDS = { benzin: [30, 300], motorin: [30, 300], lpg: [10, 150] };
const isValid = (k, v) => typeof v === 'number' && isFinite(v) && v >= BOUNDS[k][0] && v <= BOUNDS[k][1];
const round2 = v => Math.round(v * 100) / 100;
const mean = a => a.length ? round2(a.reduce((s, x) => s + x, 0) / a.length) : null;

const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'accept-language': 'tr-TR,tr;q=0.9,en;q=0.5',
};

async function getText(url, { ms = 9000, headers = {} } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { ...BROWSER_HEADERS, ...headers } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } catch (e) {
    throw new Error(e && e.name === 'AbortError' ? 'zaman aşımı' : (e && e.message) || 'hata');
  } finally { clearTimeout(t); }
}

// ── Kaynak 1: Opet ─────────────────────────────────────────────
// Yanıt: [{ provinceName, districtName, prices:[{ productName, amount, productCode }] }]
// A100 = Kurşunsuz Benzin 95. Motorin ürünleri (A121 UltraForce / A128 EcoForce): en düşük olan standart motorindir.
function parseOpet(body) {
  const arr = JSON.parse(body);
  if (!Array.isArray(arr)) throw new Error('beklenmeyen biçim');
  const seen = new Set(), benzin = [], motorin = [];
  for (const d of arr) {
    const prov = d && d.provinceName;
    if (!prov || seen.has(prov)) continue; // il başına ilk ilçe
    let b = null, m = [];
    for (const p of (d.prices || [])) {
      const v = typeof p.amount === 'number' ? p.amount : parseFloat(p.amount);
      if (!(v > 0)) continue;
      const name = String(p.productName || '').toLocaleLowerCase('tr');
      if (p.productCode === 'A100' || /kur[sş]unsuz benzin 95/.test(name)) b = b ?? v;
      else if (p.productCode === 'A121' || p.productCode === 'A128' || /^motorin/.test(name)) m.push(v);
    }
    if (b != null && m.length) { seen.add(prov); benzin.push(b); motorin.push(Math.min(...m)); }
  }
  if (!benzin.length) throw new Error('fiyat bulunamadı');
  return { prices: { benzin: mean(benzin), motorin: mean(motorin) }, count: benzin.length };
}
async function fromOpet() {
  const body = await getText('https://api.opet.com.tr/api/fuelprices/allprices', {
    headers: { accept: 'application/json, text/plain, */*', origin: 'https://www.opet.com.tr', referer: 'https://www.opet.com.tr/' },
  });
  const r = parseOpet(body);
  return { name: `Opet (${r.count} il ort.)`, prices: r.prices };
}

// ── Kaynak 2: Petrol Ofisi (HTML tablo) ───────────────────────
function parsePetrolOfisi(html) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(m => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(c => c[1]));
  const header = rows.find(cells => cells.some(c => /otogaz/i.test(c)));
  if (!header) throw new Error('tablo başlığı bulunamadı');
  const h = header.map(c => c.replace(/<[^>]+>/g, ' ').toLowerCase());
  const gi = h.findIndex(x => /95|benzin/.test(x));
  const li = h.findIndex(x => /otogaz/.test(x));
  if (li < 0) throw new Error('otogaz sütunu yok');
  const grab = (cell) => {
    const m = cell && /class="with-tax"[^>]*>\s*([0-9]+(?:[.,][0-9]+)?)/.exec(cell);
    const v = m ? parseFloat(m[1].replace(',', '.')) : NaN;
    return v > 0 ? v : null;
  };
  const benzin = [], lpg = [];
  for (const cells of rows) {
    const b = gi >= 0 ? grab(cells[gi]) : null;
    const l = grab(cells[li]);
    if (b != null) benzin.push(b);
    // Sütun kayarsa yanlış değeri LPG sanmamak için benzinle oranını doğrula
    if (l != null && (b == null || (l >= b * 0.25 && l <= b * 0.8))) lpg.push(l);
  }
  if (!lpg.length) throw new Error('otogaz fiyatı bulunamadı');
  return { prices: { lpg: mean(lpg), ...(benzin.length ? { benzin: mean(benzin) } : {}) }, count: lpg.length };
}
async function fromPetrolOfisi() {
  const html = await getText('https://www.petrolofisi.com.tr/akaryakit-fiyatlari', { headers: { accept: 'text/html' } });
  const r = parsePetrolOfisi(html);
  return { name: `Petrol Ofisi (${r.count} il ort.)`, prices: r.prices };
}

// ── Kaynak 3: ucuzyakitbul (son çare) ─────────────────────────
async function fromUcuzYakitBul() {
  const j = JSON.parse(await getText('https://ucuzyakitbul.com.tr/api/prices/national', { headers: { accept: 'application/json' } }));
  const prices = {};
  for (const p of (j.prices || [])) {
    const s = String(p.fuelType || '').toLocaleLowerCase('tr');
    const k = /lpg|otogaz/.test(s) ? 'lpg' : /motorin/.test(s) ? 'motorin' : /benzin/.test(s) ? 'benzin' : null;
    const v = typeof p.price === 'number' ? p.price : parseFloat(p.price);
    if (k && !(k in prices)) prices[k] = v;
  }
  return { name: 'ucuzyakitbul.com.tr', prices };
}

async function collect() {
  const today = new Date().toISOString().slice(0, 10);
  const out = { prices: {}, dates: {}, sources: {}, fallback: [], errors: [] };
  const take = (r) => {
    for (const k of Object.keys(BOUNDS)) {
      const v = r.prices[k];
      if (!(k in out.prices) && isValid(k, v)) { out.prices[k] = v; out.dates[k] = today; out.sources[k] = r.name; }
    }
  };
  const done = () => Object.keys(BOUNDS).every(k => k in out.prices);

  // 1 ve 2 paralel; sonra gerekirse 3
  const first = await Promise.allSettled([fromOpet(), fromPetrolOfisi()]);
  first.forEach((s, i) => {
    const label = ['Opet', 'PetrolOfisi'][i];
    if (s.status === 'fulfilled') take(s.value); else out.errors.push(`${label}: ${s.reason && s.reason.message}`);
  });
  if (!done()) {
    try { take(await fromUcuzYakitBul()); } catch (e) { out.errors.push('ucuzyakitbul: ' + (e && e.message)); }
  }
  for (const k of Object.keys(BOUNDS)) {
    if (!(k in out.prices)) {
      out.prices[k] = FALLBACK.prices[k]; out.dates[k] = FALLBACK.updated;
      out.sources[k] = 'yedek değer'; out.fallback.push(k);
    }
  }
  out.fetchedAt = new Date().toISOString();
  return out;
}

module.exports = async (req, res) => {
  const data = await collect();
  const ttl = data.fallback.length === 3 ? 300 : data.fallback.length ? 1800 : 21600;
  res.setHeader('Cache-Control', `public, s-maxage=${ttl}, stale-while-revalidate=86400`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json(data);
};
module.exports._collect = collect;
module.exports._parseOpet = parseOpet;
module.exports._parsePetrolOfisi = parsePetrolOfisi;
