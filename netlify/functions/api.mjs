// ETS2 Crowd Tracker API — Netlify Function (TruckersMP + HaulMP)
import CITIES from './cities.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const BOUNDS = { x0: -96000, x1: 80000, y0: -122000, y1: 86000 };
const TRUCKY = { 'Simulation 1': 'sim1', 'Simulation 2': 'sim2', 'Arcade': 'arc1', 'ProMods': 'eupromods1', 'ProMods Arcade': 'eupromodsarc', '[US] Simulation': 'arc2', '[Asia] Simulation': 'sgpsim' };
const mem = new Map(); // warm-instance cache

let errs = []; // per-request diagnostics, returned only when data comes back empty
async function getJSON(url, ms = 7000) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
    if (r.ok) return await r.json();
    errs.push({ url, status: r.status, body: (await r.text()).slice(0, 200) });
    return null;
  } catch (e) { errs.push({ url, error: String(e?.message || e) }); return null; }
}
async function cached(key, ttl, fn, isEmpty) {
  const c = mem.get(key);
  if (c && Date.now() - c.t < ttl * 1000) return c.v;
  const v = await fn(); if (!isEmpty(v)) mem.set(key, { t: Date.now(), v }); return v;
}

// ---- servers ----
async function tmpServers() {
  const k = await getJSON('https://truckersmp.krashnz.com/servers');
  let list = [];
  if (k && !k.error) {
    list = k.servers.filter(s => s.game === 'ets2' && s.status).map(s => {
      const name = s.name.replace(/^ETS2 - /, '');
      return { id: String(s.map), name, players: s.players, trucky: TRUCKY[name] || null };
    });
  } else {
    const t = await getJSON('https://api.truckyapp.com/v2/truckersmp/servers');
    list = (t?.response?.servers || []).filter(s => s.game === 'ETS2' && s.online)
      .map(s => ({ id: String(s.mapid), name: s.name, players: s.players, trucky: TRUCKY[s.name] || null }));
  }
  return list;
}
async function haulServers() {
  const h = await getJSON('https://map.haulmp.com/api/servers');
  return (h || []).filter(s => s.online).map(s => ({ id: s.id, name: s.name, players: s.players }));
}

// ---- positions ----
async function tmpPositions(mapId) {
  const n = 4, dx = (BOUNDS.x1 - BOUNDS.x0) / n, dy = (BOUNDS.y1 - BOUNDS.y0) / n, urls = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++)
    urls.push(`https://tracker.ets2map.com/v3/area?x1=${Math.round(BOUNDS.x0 + i * dx)}&y1=${Math.round(BOUNDS.y0 + j * dy)}&x2=${Math.round(BOUNDS.x0 + (i + 1) * dx)}&y2=${Math.round(BOUNDS.y0 + (j + 1) * dy)}&server=${mapId}`);
  const res = await Promise.all(urls.map(u => getJSON(u, 6500)));
  const seen = new Map();
  res.forEach(r => (r?.Data || []).forEach(p => seen.set(p.MpId ?? p.ID ?? Math.random(), [p.X, p.Y])));
  const pts = [...seen.values()];
  pts.updatedAt = pts.length ? Date.now() : null;
  return pts;
}
async function haulPositions(server) {
  const d = await getJSON('https://map.haulmp.com/api/live' + (server === 'europe1' ? '' : '?server=' + encodeURIComponent(server)));
  const pts = (d?.players || []).map(p => [p.x, p.z]);
  pts.updatedAt = d?.updatedAt || null; // HaulMP's own snapshot time
  return pts;
}

// ---- grouping: near a city => city, else road between the 2 nearest cities ----
function group(points) {
  const cities = new Map(), roads = new Map();
  for (const [x, y] of points) {
    let a = null, b = null, da = Infinity, db = Infinity;
    for (const c of CITIES) {
      const d = (c.x - x) ** 2 + (c.y - y) ** 2;
      if (d < da) { b = a; db = da; a = c; da = d; } else if (d < db) { b = c; db = d; }
    }
    if (!a) continue;
    if (Math.sqrt(da) < 1600) {
      const e = cities.get(a.n) || { name: a.n, country: a.c, players: 0, x: a.x, y: a.y };
      e.players++; cities.set(a.n, e);
    } else if (b) {
      const [p, q] = [a, b].sort((m, k) => m.n.localeCompare(k.n));
      const key = p.n + '|' + q.n;
      const e = roads.get(key) || { from: p.n, fromC: p.c, to: q.n, toC: q.c, players: 0, x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      e.players++; roads.set(key, e);
    }
  }
  const sort = m => [...m.values()].sort((a, b) => b.players - a.players).slice(0, 25);
  return { roads: sort(roads), cities: sort(cities), roadTotal: roads.size };
}

async function hotspots(net, server, tsrv) {
  const pts = net === 'haul' ? await haulPositions(server) : await tmpPositions(server);
  if (pts.length) {
    const g = group(pts);
    return { source: 'live', tracked: pts.length, ...g, points: pts.map(([x, y]) => [Math.round(x), Math.round(y)]), sourceUpdated: pts.updatedAt, time: Date.now() };
  }
  // No live positions -> report offline honestly (no stale/cached fallback data)
  return { source: 'offline', tracked: 0, roads: [], cities: [], points: [], sourceUpdated: null, time: Date.now() };
}

export default async (req) => {
  const u = new URL(req.url);
  const action = u.searchParams.get('action') || 'servers';
  const net = u.searchParams.get('net') === 'haul' ? 'haul' : 'tmp';
  const server = (u.searchParams.get('server') || (net === 'haul' ? 'europe1' : '2')).replace(/[^a-zA-Z0-9_-]/g, '');
  const tsrv = (u.searchParams.get('trucky') || '').replace(/[^a-z0-9_]/g, '');
  let body; errs = [];
  if (action === 'servers') {
    const list = await cached('srv_' + net, 25, () => net === 'haul' ? haulServers() : tmpServers(), v => !v.length);
    list.sort((a, b) => b.players - a.players);
    body = { net, servers: list, total: list.reduce((s, x) => s + x.players, 0) };
    if (!list.length) body.debug = errs;
  } else if (action === 'hotspots') {
    body = await cached(`hot_${net}_${server}_${tsrv}`, 20, () => hotspots(net, server, tsrv), v => v.source !== 'live');
    if (body.source !== 'live') body = { ...body, debug: errs };
  } else if (action === 'cities') {
    body = CITIES;
  } else body = { error: 'bad action' };
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=15',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=20, stale-while-revalidate=40',
      'Netlify-Vary': 'query',
    },
  });
};

export const config = { path: "/api" };
