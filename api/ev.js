// /api/ev — Rota boyunca elektrikli araç şarj istasyonları (Open Charge Map verisi)
// Gerekli: Vercel'de OCM_API_KEY ortam değişkeni (openchargemap.org'dan ücretsiz).
// İstek: POST { points: [[lat,lng], ...] (rota, ~4 km aralıkla), dcOnly: true|false }

const OCM = 'https://api.openchargemap.io/v3/poi/';
const R = 6371;
const rad = d => d * Math.PI / 180;
function hav(a, b) {
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function pickCenters(points) {
  // Her rota noktası bir merkeze en fazla `spacing` km uzakta kalsın; daire yarıçapı spacing + 5.
  let spacing = 35;
  const total = points.reduce((s, p, i) => i ? s + hav(points[i - 1], p) : 0, 0);
  const MAX = 16;
  if (total / spacing > MAX) spacing = Math.ceil(total / MAX);
  const centers = [];
  for (const p of points) {
    if (!centers.some(c => hav(c, p) <= spacing)) centers.push(p);
  }
  return { centers, radius: Math.min(spacing + 5, 120), total };
}

function currentOf(c) {
  const id = c.CurrentTypeID ?? (c.CurrentType && c.CurrentType.ID);
  if (id === 30) return 'DC';
  if (id === 10 || id === 20) return 'AC';
  const t = String((c.CurrentType && c.CurrentType.Title) || '');
  if (/dc/i.test(t)) return 'DC';
  if (/ac/i.test(t)) return 'AC';
  const lvl = c.LevelID ?? (c.Level && c.Level.ID);
  if (lvl === 3) return 'DC';
  return (c.PowerKW || 0) > 22 ? 'DC' : 'AC';
}
function plugOf(c) {
  const t = String((c.ConnectionType && (c.ConnectionType.Title || c.ConnectionType.FormalName)) || '');
  if (/ccs|combo/i.test(t)) return 'CCS';
  if (/chademo/i.test(t)) return 'CHAdeMO';
  if (/tesla/i.test(t)) return 'Tesla';
  if (/type 2|mennekes|62196-2|type2/i.test(t)) return 'Type 2';
  if (/type 1|j1772/i.test(t)) return 'Type 1';
  return t.slice(0, 18) || 'Diğer';
}

function compact(poi, routePts, cum) {
  const ai = poi.AddressInfo || {};
  if (typeof ai.Latitude !== 'number' || typeof ai.Longitude !== 'number') return null;
  if (poi.StatusType && poi.StatusType.IsOperational === false) return null;
  const pos = [ai.Latitude, ai.Longitude];
  let best = Infinity, bi = 0;
  for (let i = 0; i < routePts.length; i++) {
    const d = hav(pos, routePts[i]);
    if (d < best) { best = d; bi = i; }
  }
  if (best > 3) return null; // yola en fazla 3 km
  const map = new Map();
  for (const c of (poi.Connections || [])) {
    const cur = currentOf(c), t = plugOf(c), kw = Math.round((c.PowerKW || 0) * 10) / 10;
    const key = cur + t + kw;
    const n = c.Quantity || 1;
    if (map.has(key)) map.get(key).n += n; else map.set(key, { t, kw, cur, n });
  }
  const conns = [...map.values()].sort((a, b) => b.kw - a.kw);
  if (!conns.length) return null;
  const op = poi.OperatorInfo && poi.OperatorInfo.Title;
  return {
    id: poi.ID,
    lat: pos[0], lng: pos[1],
    title: String(ai.Title || '').slice(0, 80),
    operator: op ? String(op).slice(0, 60) : '',
    addr: [ai.AddressLine1, ai.Town].filter(Boolean).join(', ').slice(0, 120),
    conns,
    dc: conns.some(c => c.cur === 'DC'),
    maxKw: Math.max(...conns.map(c => c.kw)),
    usage: poi.UsageCost ? String(poi.UsageCost).slice(0, 120) : '',
    routeKm: Math.round(cum[bi]),
    offKm: Math.round(best * 10) / 10,
  };
}

async function ocmQuery(key, lat, lng, radius, dcOnly) {
  const u = new URL(OCM);
  const q = {
    output: 'json', countrycode: 'TR', maxresults: '500', compact: 'false', verbose: 'false',
    latitude: lat, longitude: lng, distance: radius, distanceunit: 'KM', key,
  };
  if (dcOnly) q.levelid = '3'; // 3 = DC hızlı şarj
  Object.entries(q).forEach(([k, v]) => u.searchParams.set(k, v));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(u, { signal: ctl.signal, headers: { 'user-agent': 'YolMasraf/1.0', accept: 'application/json' } });
    if (!r.ok) throw new Error('OCM HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function build(key, points, dcOnly) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + hav(points[i - 1], points[i]));
  const { centers, radius } = pickCenters(points);
  const byId = new Map();
  let failed = 0;
  for (let i = 0; i < centers.length; i += 4) {
    const batch = centers.slice(i, i + 4);
    const res = await Promise.all(batch.map(c => ocmQuery(key, c[0], c[1], radius, dcOnly).catch(() => { failed++; return []; })));
    for (const list of res) for (const poi of (Array.isArray(list) ? list : [])) {
      if (byId.has(poi.ID)) continue;
      const s = compact(poi, points, cum);
      if (s) byId.set(poi.ID, s);
    }
  }
  const stations = [...byId.values()].sort((a, b) => a.routeKm - b.routeKm);
  return { ok: failed < centers.length, partial: failed > 0, stations, totalKm: Math.round(cum[cum.length - 1]) };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method' });
  const key = process.env.OCM_API_KEY;
  if (!key) return res.status(200).json({ ok: false, error: 'no_key', stations: [] });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const pts = body && Array.isArray(body.points) ? body.points : null;
  if (!pts || pts.length < 2 || pts.length > 1500 ||
      !pts.every(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
    return res.status(400).json({ ok: false, error: 'bad_points' });
  }
  try {
    res.status(200).json(await build(key, pts, body.dcOnly !== false));
  } catch (e) {
    res.status(200).json({ ok: false, error: 'upstream', stations: [] });
  }
};
module.exports._build = build;
