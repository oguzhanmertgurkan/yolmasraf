// /api/fuel — Güncel akaryakıt fiyatları (Türkiye ortalaması)
// Vercel sunucu fonksiyonu. Sonuç 6 saat önbelleğe alınır, yani kaynaklara günde en fazla ~4 istek gider.
// Sıra: 1) ucuzyakitbul.com.tr (genel uç nokta)  2) Opet  3) data/fuel-fallback.json (elle yedek)

const FALLBACK = require('../data/fuel-fallback.json');

const BOUNDS = { benzin: [30, 300], motorin: [30, 300], lpg: [10, 150] }; // saçma değerleri ele
const isValid = (k, v) => typeof v === 'number' && isFinite(v) && v >= BOUNDS[k][0] && v <= BOUNDS[k][1];

async function getJson(url, ms = 7000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { 'accept': 'application/json', 'user-agent': 'YolMasraf/1.0 (+https://yolmasraf.vercel.app)' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

function fuelKey(name) {
  const s = String(name || '').toLocaleLowerCase('tr').replace(/ı/g, 'i');
  if (/premium|eco|ultra|v-power|vpower|max|pro|kalorifer|gazyağı|fuel oil/.test(s)) return null;
  if (/lpg|otogaz/.test(s)) return 'lpg';
  if (/motorin|diesel|dizel/.test(s)) return 'motorin';
  if (/benzin|kur[sş]unsuz|95/.test(s)) return 'benzin';
  return null;
}

// Kaynak 1 — { prices:[{fuelType, price, date}] }
async function fromUcuzYakitBul() {
  const j = await getJson('https://ucuzyakitbul.com.tr/api/prices/national');
  const prices = {}, dates = {};
  for (const p of (j.prices || [])) {
    const k = fuelKey(p.fuelType);
    const v = typeof p.price === 'number' ? p.price : parseFloat(p.price);
    if (k && !(k in prices) && isValid(k, v)) { prices[k] = v; dates[k] = p.date || null; }
  }
  return { name: 'ucuzyakitbul.com.tr (Türkiye ort.)', prices, dates };
}

// Kaynak 2 — Opet (İstanbul Avrupa). Yanıt biçimi değişebilir; bu yüzden içi gezerek arıyoruz.
async function fromOpet() {
  const j = await getJson('https://api.opet.com.tr/api/fuelprices/prices?ProvinceCode=34&IncludeAllProducts=true');
  const prices = {}, dates = {};
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const name = node.productName || node.ProductName || node.name || node.fuelType || node.product;
    const raw = node.amount ?? node.Amount ?? node.price ?? node.Price ?? node.fiyat;
    const k = fuelKey(name);
    const v = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(',', '.'));
    if (k && !(k in prices) && isValid(k, v)) {
      prices[k] = v;
      dates[k] = String(node.date || node.Date || node.lastUpdate || '').slice(0, 10) || null;
    }
    Object.values(node).forEach(walk);
  })(j);
  return { name: 'Opet (İstanbul)', prices, dates };
}

async function collect() {
  const out = { prices: {}, dates: {}, sources: {}, fallback: [] };
  const attempts = [];
  for (const src of [fromUcuzYakitBul, fromOpet]) {
    if (Object.keys(BOUNDS).every(k => k in out.prices)) break;
    try {
      const r = await src();
      for (const k of Object.keys(BOUNDS)) {
        if (!(k in out.prices) && k in r.prices) {
          out.prices[k] = r.prices[k]; out.dates[k] = r.dates[k] || null; out.sources[k] = r.name;
        }
      }
    } catch (e) { attempts.push(src.name + ': ' + (e && e.message)); }
  }
  for (const k of Object.keys(BOUNDS)) {
    if (!(k in out.prices)) {
      out.prices[k] = FALLBACK.prices[k]; out.dates[k] = FALLBACK.updated;
      out.sources[k] = 'yedek değer'; out.fallback.push(k);
    }
  }
  out.errors = attempts;
  out.fetchedAt = new Date().toISOString();
  return out;
}

module.exports = async (req, res) => {
  const data = await collect();
  // Tam yedeğe düşüldüyse kısa, canlıysa uzun önbellek
  const ttl = data.fallback.length === 3 ? 300 : 21600;
  res.setHeader('Cache-Control', `public, s-maxage=${ttl}, stale-while-revalidate=86400`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json(data);
};
module.exports._collect = collect; // test için
