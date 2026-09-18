// Bandmate · Routing proxy (Vercel serverless function)
//
// Backs the Routing tool: hotels near a venue, and real drive times between
// points. Both Google calls run here so the key stays SERVER-SIDE — it is the
// same GOOGLE_PLACES_KEY that place-search.js uses, so nothing new to set.
//
// Two actions:
//   POST { action:'hotels', lat, lng, radius, supabaseAccessToken }
//     → { configured:true, cached, fetchedAt, routes, results:[hotel, …] }
//       hotel = { placeId, name, address, lat, lng, rating, reviews,
//                 priceLevel (1-4 or null), website, phone, mapsUrl, type,
//                 driveMin, driveMi }           (drive* null without Routes)
//
//   POST { action:'drive', from:{lat,lng}, to:{lat,lng}, supabaseAccessToken }
//     → { configured:true, cached, routes:true, minutes, miles }
//       or { configured:true, routes:false } when the Routes API isn't
//       enabled on the key yet — the app then keeps its own estimate.
//
// Routes API: enable "Routes API" in the same Google Cloud project as the
// Places key and allow it on the key's API restrictions. Until then every
// drive lookup answers routes:false and hotels come back without drive times;
// the app labels them as estimates. Nothing breaks either way.
//
// Auth: requires a valid Supabase access token, same as the other proxies,
// so nobody outside the app can spend the quota.
//
// Cache: public.routing_cache (patch-050), shared by everyone. Hotel searches
// stay fresh 30 days, drive times 60 — hotels open and close, roads don't
// move. A hotel search cached before Routes was enabled gets its drive times
// filled in on the next request without another Places call.
//
// GRACEFUL DEGRADE: without GOOGLE_PLACES_KEY this returns { configured:false }
// with HTTP 200 and the app says so instead of showing an empty shortlist.

const { createClient } = require('@supabase/supabase-js');

const PLACES_NEARBY  = 'https://places.googleapis.com/v1/places:searchNearby';
const ROUTES_MATRIX  = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const DAY = 24 * 60 * 60 * 1000;
const HOTELS_TTL = 30 * DAY;
const DRIVE_TTL  = 60 * DAY;

// Lodging types that are never a tour hotel.
const SKIP_TYPES = new Set(['campground', 'rv_park', 'hostel', 'private_guest_room']);
const PRICE = {
  PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

// Why the most recent Routes call didn't answer, e.g. '403 · Routes API has
// not been used in project … before or it is disabled'. Surfaced as
// `routesError` on responses where routes is false, so enabling the API can
// be verified from the app instead of from the Vercel logs. Never includes
// the key: Google's error text doesn't carry it, and we cap the length.
let lastRoutesError = '';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const googleKey = process.env.GOOGLE_PLACES_KEY;
  if (!googleKey) { res.status(200).json({ configured: false }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  // ── Verify the caller has a real Bandmate session ────────────────────
  const supaUrl = process.env.SUPABASE_URL;
  const supaServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const accessToken = (body.supabaseAccessToken || '').toString();
  if (!accessToken) { res.status(401).json({ error: 'Missing session' }); return; }
  let supa = null;
  if (supaUrl && supaServiceKey) {
    try {
      supa = createClient(supaUrl, supaServiceKey, { auth: { persistSession: false } });
      const { data, error } = await supa.auth.getUser(accessToken);
      if (error || !data?.user) { res.status(401).json({ error: 'Invalid session' }); return; }
    } catch (e) {
      console.error('[routing] session verify threw:', e);
      res.status(401).json({ error: 'Could not verify session' }); return;
    }
  }

  const ctx = { googleKey, supa };
  const action = (body.action || 'hotels').toString();
  try {
    if (action === 'hotels') { await hotels(ctx, body, res); return; }
    if (action === 'drive')  { await drive(ctx, body, res);  return; }
    res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('[routing] handler error:', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
};

// ── hotels ────────────────────────────────────────────────────────────
async function hotels(ctx, body, res) {
  const lat = num(body.lat), lng = num(body.lng);
  if (lat == null || lng == null) { res.status(400).json({ error: 'Missing coordinates' }); return; }
  const radius = Math.min(30000, Math.max(1000, Math.round(num(body.radius) || 8000)));
  const key = `${lat.toFixed(3)},${lng.toFixed(3)},${radius}`;

  const cached = await cacheGet(ctx, 'hotels', key, HOTELS_TTL);
  if (cached && Array.isArray(cached.payload.results)) {
    let payload = cached.payload;
    // Routes may have been enabled since this search was cached — fill the
    // drive times in without spending another Places call.
    if (!payload.routes && payload.results.length) {
      const matrix = await routeMatrix(ctx, { lat, lng }, payload.results);
      if (matrix) {
        payload = { ...payload, routes: true, results: attachDrive(payload.results, matrix) };
        await cachePut(ctx, 'hotels', key, payload);
      }
    }
    res.status(200).json({ configured: true, cached: true, fetchedAt: cached.fetched_at, routes: !!payload.routes, routesError: payload.routes ? undefined : lastRoutesError, results: payload.results });
    return;
  }

  const fieldMask = [
    'places.id', 'places.displayName', 'places.formattedAddress', 'places.location',
    'places.rating', 'places.userRatingCount', 'places.priceLevel',
    'places.websiteUri', 'places.nationalPhoneNumber', 'places.internationalPhoneNumber',
    'places.googleMapsUri', 'places.primaryType',
  ].join(',');
  const r = await fetch(PLACES_NEARBY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': ctx.googleKey, 'X-Goog-FieldMask': fieldMask },
    body: JSON.stringify({
      includedTypes: ['lodging'],
      maxResultCount: 20,
      rankPreference: 'POPULARITY',
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
    }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    console.error('[routing] nearby error:', j?.error?.message || r.status);
    res.status(502).json({ error: j?.error?.message || 'Hotel search failed' }); return;
  }
  let results = (j?.places || []).map(normalizeHotel).filter(h => h.name && h.lat != null && !SKIP_TYPES.has(h.type));

  const matrix = await routeMatrix(ctx, { lat, lng }, results);
  const routes = !!matrix;
  if (matrix) results = attachDrive(results, matrix);

  const payload = { routes, results };
  await cachePut(ctx, 'hotels', key, payload);
  res.status(200).json({ configured: true, cached: false, fetchedAt: new Date().toISOString(), routes, routesError: routes ? undefined : lastRoutesError, results });
}

// ── drive ─────────────────────────────────────────────────────────────
async function drive(ctx, body, res) {
  const from = point(body.from), to = point(body.to);
  if (!from || !to) { res.status(400).json({ error: 'Missing coordinates' }); return; }
  const key = `${from.lat.toFixed(3)},${from.lng.toFixed(3)}>${to.lat.toFixed(3)},${to.lng.toFixed(3)}`;

  const cached = await cacheGet(ctx, 'drive', key, DRIVE_TTL);
  if (cached && cached.payload.routes) {
    res.status(200).json({ configured: true, cached: true, routes: true, minutes: cached.payload.minutes, miles: cached.payload.miles });
    return;
  }
  const matrix = await routeMatrix(ctx, from, [to]);
  if (!matrix || !matrix[0] || matrix[0].minutes == null) {
    res.status(200).json({ configured: true, cached: false, routes: false, routesError: lastRoutesError || (matrix ? 'no route between those points' : '') });
    return;
  }
  const payload = { routes: true, minutes: matrix[0].minutes, miles: matrix[0].miles };
  await cachePut(ctx, 'drive', key, payload);
  res.status(200).json({ configured: true, cached: false, routes: true, minutes: payload.minutes, miles: payload.miles });
}

// ── Google Routes: one origin → many destinations ────────────────────
// Returns an array aligned with `dests` of { minutes, miles } (either may be
// null for an unreachable pair), or null when the Routes API isn't enabled
// on this key / project. Anything else that fails also returns null — the
// app has an estimate to fall back on, so a Routes hiccup must never take a
// hotel search down with it.
async function routeMatrix(ctx, origin, dests) {
  if (!dests.length) return [];
  try {
    const r = await fetch(ROUTES_MATRIX, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': ctx.googleKey,
        'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,distanceMeters,status,condition',
      },
      body: JSON.stringify({
        origins: [{ waypoint: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } } }],
        destinations: dests.map(d => ({ waypoint: { location: { latLng: { latitude: d.lat, longitude: d.lng } } } })),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE',
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      let msg = '';
      try { msg = JSON.parse(text)?.error?.message || ''; } catch (e) {}
      lastRoutesError = `${r.status} · ${(msg || text || 'no detail').replace(/\s+/g, ' ').slice(0, 220)}`;
      if (r.status === 403 || /PERMISSION_DENIED|not been used|is disabled|API_KEY_SERVICE_BLOCKED/i.test(text)) {
        console.warn('[routing] Routes API not enabled for this key:', lastRoutesError);
      } else {
        console.error('[routing] routes error:', lastRoutesError);
      }
      return null;
    }
    const rows = await r.json().catch(() => null);
    if (!Array.isArray(rows)) { lastRoutesError = 'unexpected response shape'; return null; }
    lastRoutesError = '';
    const out = dests.map(() => ({ minutes: null, miles: null }));
    rows.forEach(el => {
      const i = el.destinationIndex;
      if (i == null || !out[i]) return;
      if (el.condition && el.condition !== 'ROUTE_EXISTS') return;
      const secs = parseFloat(String(el.duration || '').replace(/s$/, ''));
      if (isFinite(secs)) out[i].minutes = Math.round(secs / 60);
      if (isFinite(el.distanceMeters)) out[i].miles = Math.round(el.distanceMeters / 1609.344 * 10) / 10;
    });
    return out;
  } catch (e) {
    lastRoutesError = 'threw · ' + String(e && e.message || e).slice(0, 200);
    console.error('[routing] routes threw:', e);
    return null;
  }
}

function attachDrive(results, matrix) {
  return results.map((h, i) => ({ ...h, driveMin: matrix[i] ? matrix[i].minutes : null, driveMi: matrix[i] ? matrix[i].miles : null }));
}

function normalizeHotel(p) {
  return {
    placeId: p.id || '',
    name: (p.displayName && p.displayName.text) || '',
    address: p.formattedAddress || '',
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    rating: typeof p.rating === 'number' ? p.rating : null,
    reviews: p.userRatingCount || 0,
    priceLevel: PRICE[p.priceLevel] ?? null,
    website: p.websiteUri || '',
    phone: p.internationalPhoneNumber || p.nationalPhoneNumber || '',
    mapsUrl: p.googleMapsUri || '',
    type: p.primaryType || '',
    driveMin: null,
    driveMi: null,
  };
}

// ── cache ─────────────────────────────────────────────────────────────
async function cacheGet(ctx, kind, key, ttl) {
  if (!ctx.supa) return null;
  try {
    const { data, error } = await ctx.supa.from('routing_cache')
      .select('payload, fetched_at').eq('kind', kind).eq('key', key).maybeSingle();
    if (error || !data) return null;
    if (Date.now() - Date.parse(data.fetched_at) > ttl) return null;
    return data;
  } catch (e) { return null; }   // no cache table yet — look it up live
}
async function cachePut(ctx, kind, key, payload) {
  if (!ctx.supa) return;
  try {
    await ctx.supa.from('routing_cache').upsert(
      { kind, key, payload, fetched_at: new Date().toISOString() },
      { onConflict: 'kind,key' });
  } catch (e) { /* caching is best-effort */ }
}

function num(v) { const n = typeof v === 'number' ? v : parseFloat(v); return isFinite(n) ? n : null; }
function point(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = num(p.lat), lng = num(p.lng);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}
