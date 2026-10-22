// Discoduel · server logic for the daily challenge.
// Pure functions + handlers that take their storage and MusicBrainz access as arguments,
// so the same code runs on Netlify (Blobs) and in local tests (in-memory store).

export const TZ = "Europe/Brussels";
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isMbid = s => typeof s === "string" && MBID.test(s);
const clip = (s, n) => String(s ?? "").trim().slice(0, n);
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function today(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
export function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

/* read-modify-write with optimistic locking (ETag), retried on conflicts */
export async function update(store, key, fn, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const next = fn(cur ? structuredClone(cur.data) : null);
    if (next === undefined) return cur ? cur.data : null;
    const res = cur ? await store.setJSON(key, next, { onlyIfMatch: cur.etag }) : await store.setJSON(key, next, { onlyIfNew: true });
    if (res && res.modified) return next;
    await sleep(40 + Math.random() * 120 * (i + 1));
  }
  throw new Error("busy");
}

/* ---------- play statistics ---------- */
export function validatePlay(b) {
  if (!b || !isMbid(b.artist?.id)) return null;
  const seen = new Set();
  const albums = (Array.isArray(b.albums) ? b.albums : [])
    .filter(a => isMbid(a?.id) && !seen.has(a.id) && seen.add(a.id))
    .slice(0, 60)
    .map(a => ({ id: a.id, title: clip(a.title, 200) || "?", year: Number(a.year) || null }));
  if (!albums.length) return null;
  return { artist: { id: b.artist.id, name: clip(b.artist.name, 200) || "?" }, albums };
}
export function recordPlay(stats, play, date) {
  const s = stats && stats.artists ? stats : { plays: 0, artists: {} };
  const a = s.artists[play.artist.id] || (s.artists[play.artist.id] = { name: play.artist.name, plays: 0, albums: {} });
  a.name = play.artist.name; a.plays++; a.last = date; s.plays = (s.plays || 0) + 1;
  for (const al of play.albums) {
    const x = a.albums[al.id] || (a.albums[al.id] = { title: al.title, year: al.year, picks: 0 });
    x.picks++; x.title = al.title; if (al.year) x.year = al.year;
  }
  return s;
}

/* ---------- daily pick: weighted by what players actually chose ---------- */
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
export function seeded(seedText) {
  let a = hash(seedText);
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function weighted(items, w, rand) {
  const total = items.reduce((s, x) => s + w(x), 0);
  if (!(total > 0)) return null;
  let r = rand() * total;
  for (const x of items) { r -= w(x); if (r <= 0) return x; }
  return items[items.length - 1];
}
export function choose(stats, history, date, exclude = new Set(), rand = seeded("discoduel:" + date)) {
  const hist = Array.isArray(history) ? history : [];
  const usedAlbums = new Set(hist.filter(h => daysBetween(h.date, date) < 90).map(h => h.albumId));
  const recentArtists = new Set(hist.filter(h => daysBetween(h.date, date) < 3).map(h => h.artistId));
  let artists = Object.entries(stats?.artists || {}).map(([id, a]) => ({
    id, name: a.name, plays: a.plays || 0,
    albums: Object.entries(a.albums || {}).map(([aid, al]) => ({ id: aid, ...al }))
      .filter(al => !usedAlbums.has(al.id) && !exclude.has(al.id) && al.picks > 0),
  })).filter(a => a.albums.length && a.plays > 0);
  const fresh = artists.filter(a => !recentArtists.has(a.id));
  if (fresh.length) artists = fresh;
  const artist = weighted(artists, a => a.plays, rand);
  if (!artist) return null;
  const album = weighted(artist.albums, al => al.picks, rand);
  return { artist: { id: artist.id, name: artist.name, plays: artist.plays }, album: { id: album.id, title: album.title, year: album.year || null, picks: album.picks } };
}

/* ---------- MusicBrainz (server side, identified as required by their rules) ---------- */
const UA = "Discoduel/1.0 (https://github.com/lucasleonepro-cyber/discoduel)";
let mbLast = 0;
export async function mbGet(path) {
  const wait = mbLast + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  mbLast = Date.now();
  const r = await fetch("https://musicbrainz.org/ws/2/" + path + (path.includes("?") ? "&" : "?") + "fmt=json",
    { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error("MusicBrainz " + r.status);
  return r.json();
}
export const trackKey = s => String(s).toLowerCase()
  .replace(/\s*[(\[](feat|ft|with|avec)\.?[^)\]]*[)\]]/gi, "")
  .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]/gu, "");
const isVideo = m => /dvd|blu-ray|vhs|video|umd/i.test(m?.format || "");
const audioCount = r => (r.media || []).filter(m => !isVideo(m)).reduce((s, m) => s + (m["track-count"] || 0), 0);
export async function fetchTracks(rgId, get = mbGet) {
  const d = await get(`release?release-group=${rgId}&inc=media&limit=100`);
  let rels = (d.releases || []).filter(r => audioCount(r) > 0);
  const official = rels.filter(r => r.status === "Official");
  if (official.length) rels = official;
  if (!rels.length) return [];
  const freq = new Map();
  for (const r of rels) { const c = audioCount(r); freq.set(c, (freq.get(c) || 0) + 1); }
  const target = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const pick = rels.filter(r => audioCount(r) === target).sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"))[0];
  const rel = await get(`release/${pick.id}?inc=recordings`);
  const out = [], seen = new Set();
  for (const m of rel.media || []) {
    if (isVideo(m)) continue;
    for (const t of m.tracks || []) {
      const title = clip(t.title || t.recording?.title, 200), k = trackKey(title) || title;
      if (title && !seen.has(k)) { seen.add(k); out.push(title); }
    }
  }
  return out.slice(0, 60);
}

/* ---------- community results ---------- */
export function summarize(res, daily) {
  if (!res || !res.players || !daily) return { players: 0, ranking: [] };
  const ranking = daily.tracks.map((title, i) => ({ i, title, avg: (res.sum?.[i] || 0) / res.players, firsts: res.first?.[i] || 0 }))
    .sort((a, b) => a.avg - b.avg || b.firsts - a.firsts || a.i - b.i);
  return { players: res.players, ranking };
}

/* ---------- handlers ---------- */
export async function handlePlay(req, { store, now = new Date() }) {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body; try { body = await req.json(); } catch { return json({ error: "json" }, 400); }
  const play = validatePlay(body);
  if (!play) return json({ error: "invalid" }, 400);
  await update(store, "stats", s => recordPlay(s, play, today(now)));
  return json({ ok: true });
}

async function getDaily(store, date, get) {
  const key = `daily/${date}`;
  const existing = await store.get(key, { type: "json" });
  if (existing) return existing;
  const stats = await store.get("stats", { type: "json" });
  const history = (await store.get("history", { type: "json" })) || [];
  const exclude = new Set();
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = choose(stats, history, date, exclude);
    if (!c) return null;
    let tracks = [];
    try { tracks = await fetchTracks(c.album.id, get); } catch (e) { tracks = []; }
    if (tracks.length < 3) { exclude.add(c.album.id); continue; }
    const daily = { date, ...c, tracks, createdAt: Date.now() };
    const res = await store.setJSON(key, daily, { onlyIfNew: true });
    if (!res || !res.modified) return await store.get(key, { type: "json" });
    await update(store, "history", h => [...(Array.isArray(h) ? h : []), { date, albumId: c.album.id, artistId: c.artist.id }].slice(-400));
    return daily;
  }
  return null;
}

export async function handleDaily(req, { store, now = new Date(), get = mbGet }) {
  if (req.method !== "GET") return json({ error: "method" }, 405);
  const date = today(now);
  const daily = await getDaily(store, date, get);
  if (!daily) {
    const stats = await store.get("stats", { type: "json" });
    return json({ date, challenge: null, plays: stats?.plays || 0 });
  }
  const res = await store.get(`results/${date}`, { type: "json" });
  return json({ date, challenge: daily, community: summarize(res, daily) });
}

export async function handleDailyResult(req, { store, now = new Date() }) {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body; try { body = await req.json(); } catch { return json({ error: "json" }, 400); }
  const date = String(body?.date || "");
  const d = today(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || daysBetween(date, d) < 0 || daysBetween(date, d) > 1) return json({ error: "date" }, 400);
  const daily = await store.get(`daily/${date}`, { type: "json" });
  if (!daily) return json({ error: "no_daily" }, 404);
  const n = daily.tracks.length, order = Array.isArray(body.order) ? body.order.map(Number) : [];
  if (order.length !== n || new Set(order).size !== n || order.some(x => !Number.isInteger(x) || x < 0 || x >= n)) return json({ error: "order" }, 400);
  const res = await update(store, `results/${date}`, r => {
    const x = r && r.players ? r : { players: 0, sum: {}, first: {} };
    x.players++;
    order.forEach((idx, pos) => { x.sum[idx] = (x.sum[idx] || 0) + pos + 1; });
    x.first[order[0]] = (x.first[order[0]] || 0) + 1;
    return x;
  });
  return json({ ok: true, date, community: summarize(res, daily) });
}
