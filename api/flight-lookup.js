// Bandmate · Flight lookup proxy (Vercel serverless function)
//
// Fills a flight's times, airports and cities from its flight number and
// date, using AeroDataBox on RapidAPI. The key stays SERVER-SIDE here, never
// in index.html (which is public).
//
//   POST { flight:'AA 3192', date:'2026-09-24', supabaseAccessToken }
//     → { configured:true, flight:'AA 3192', date, cached, flights:[leg, …] }
//
// A leg is { number, airline, status, aircraft, departure, arrival } where
// departure / arrival = { iata, airport, city, country, timeZone, date, time,
// terminal, gate }. `time` is HH:MM, local to that airport.
//
// Auth: requires a valid Supabase access token, so nobody outside the app
// can spend the lookup quota. Same verification as place-search.js.
//
// Cache: results are kept in public.flight_cache (patch-044), keyed by flight
// and date, so looking the same flight up again costs nothing. If that table
// doesn't exist yet the lookup still works; it just isn't cached.
//
// Env vars (Vercel → Settings → Environment Variables):
//   AERODATABOX_KEY            (RapidAPI → My Apps → default-application → Authorization)
//   SUPABASE_URL               (already set for stripe-portal)
//   SUPABASE_SERVICE_ROLE_KEY  (already set for stripe-portal)
//
// GRACEFUL DEGRADE: without AERODATABOX_KEY this returns { configured:false }
// with HTTP 200, and the app hides its Look up button.

const { createClient } = require('@supabase/supabase-js');

const HOST = 'aerodatabox.p.rapidapi.com';
// Schedules for far-off flights barely move; close to departure they do.
const CACHE_FAR_MS = 24 * 3600 * 1000;
const CACHE_NEAR_MS = 2 * 3600 * 1000;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const apiKey = process.env.AERODATABOX_KEY;
  if (!apiKey) { res.status(200).json({ configured: false, flights: [] }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  // ── Verify the caller has a real Bandmate session ────────────────────
  const supaUrl = process.env.SUPABASE_URL;
  const supaServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const accessToken = (body.supabaseAccessToken || '').toString();
  if (!accessToken) { res.status(401).json({ error: 'session', message: 'Sign in to look up flights.' }); return; }
  let supa = null;
  if (supaUrl && supaServiceKey) {
    try {
      supa = createClient(supaUrl, supaServiceKey, { auth: { persistSession: false } });
      const { data, error } = await supa.auth.getUser(accessToken);
      if (error || !data?.user) { res.status(401).json({ error: 'session', message: 'Your session expired. Sign in again to look up flights.' }); return; }
    } catch (e) {
      console.error('[flight-lookup] session verify threw:', e);
      res.status(401).json({ error: 'session', message: 'Could not verify your session.' }); return;
    }
  }

  // ── Validate input ────────────────────────────────────────────────────
  // Airline designator: two characters (letters, or one letter + one digit
  // like B6 / 9W, never two digits) or three letters (ICAO), then 1–4 digits
  // with an optional letter suffix.
  const compact = (body.flight || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = compact.match(/^((?:[A-Z]{2}|[A-Z]\d|\d[A-Z])|[A-Z]{3})(\d{1,4}[A-Z]?)$/);
  if (!m) {
    res.status(400).json({ error: 'format', message: 'Enter the airline code and flight number, e.g. AA 3192.' }); return;
  }
  const flightKey = m[1] + m[2];
  const display = m[1] + ' ' + m[2];
  const date = (body.date || '').toString().trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'date', message: 'This travel item needs a valid date before a flight can be looked up.' }); return;
  }

  // ── Cache ────────────────────────────────────────────────────────────
  const daysAway = Math.abs(Date.parse(date + 'T12:00:00Z') - Date.now()) / (24 * 3600 * 1000);
  const ttl = daysAway > 3 ? CACHE_FAR_MS : CACHE_NEAR_MS;
  if (supa) {
    try {
      const { data, error } = await supa.from('flight_cache')
        .select('payload, fetched_at').eq('flight', flightKey).eq('flight_date', date).maybeSingle();
      if (!error && data && Date.now() - Date.parse(data.fetched_at) < ttl) {
        res.status(200).json({ configured: true, flight: display, date, cached: true, flights: data.payload || [] });
        return;
      }
    } catch (e) { /* no cache table yet — look it up live */ }
  }

  // ── Live lookup ──────────────────────────────────────────────────────
  try {
    const url = `https://${HOST}/flights/number/${encodeURIComponent(flightKey)}/${date}` +
      '?withAircraftImage=false&withLocation=false&dateLocalRole=Departure';
    const r = await fetch(url, { headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': HOST } });

    let flights = [];
    if (r.status === 204 || r.status === 404) {
      flights = [];                                  // no such flight departing that day
    } else if (r.status === 401 || r.status === 403) {
      console.error('[flight-lookup] provider refused the key:', r.status);
      res.status(502).json({ error: 'key', message: "Flight lookup isn't set up correctly (the key or subscription was refused)." }); return;
    } else if (r.status === 429) {
      res.status(429).json({ error: 'quota', message: 'Flight lookups are used up for now. Fill this one in by hand.' }); return;
    } else if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error('[flight-lookup] provider error:', r.status, text.slice(0, 300));
      res.status(502).json({ error: 'provider', message: 'The flight service had a problem. Try again, or fill the fields in by hand.' }); return;
    } else {
      const j = await r.json().catch(() => null);
      const list = Array.isArray(j) ? j : (j && Array.isArray(j.items) ? j.items : []);
      flights = list.map(normalizeLeg).filter(l => l.departure.time || l.arrival.time);
      // A passenger flight beats a cargo operation sharing the number.
      const pax = flights.filter(l => !l.isCargo);
      if (pax.length) flights = pax;
      flights.sort((a, b) => (a.departure.time || '').localeCompare(b.departure.time || ''));
    }

    if (supa) {
      try {
        await supa.from('flight_cache').upsert(
          { flight: flightKey, flight_date: date, payload: flights, fetched_at: new Date().toISOString() },
          { onConflict: 'flight,flight_date' });
      } catch (e) { /* caching is best-effort */ }
    }
    res.status(200).json({ configured: true, flight: display, date, cached: false, flights });
  } catch (err) {
    console.error('[flight-lookup] handler error:', err);
    res.status(500).json({ error: 'failed', message: 'Lookup failed. Try again, or fill the fields in by hand.' });
  }
};

// Local wall-clock "YYYY-MM-DD HH:MM" from a provider time. Current responses
// nest { utc, local }; older ones used a flat *Local string. Only the LOCAL
// value is used: a UTC time would put the wrong hour in the form.
function localTime(t) {
  const s = typeof t === 'string' ? t : (t && t.local) || '';
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
  return m ? { date: m[1], time: `${m[2]}:${m[3]}` } : { date: '', time: '' };
}

function normalizeMovement(x) {
  x = x || {};
  const a = x.airport || {};
  const sched = localTime(x.scheduledTime || x.scheduledTimeLocal);
  const revised = localTime(x.revisedTime || x.revisedTimeLocal);
  return {
    iata: a.iata || '',
    icao: a.icao || '',
    airport: a.shortName || a.name || '',
    city: a.municipalityName || '',
    country: a.countryCode || '',
    timeZone: a.timeZone || '',
    date: sched.date || revised.date,
    time: sched.time || revised.time,
    revisedTime: revised.time,
    terminal: x.terminal || '',
    gate: x.gate || '',
  };
}

function normalizeLeg(f) {
  f = f || {};
  return {
    number: (f.number || '').toString().trim(),
    airline: (f.airline && f.airline.name) || '',
    airlineIata: (f.airline && f.airline.iata) || '',
    status: f.status || '',
    codeshare: f.codeshareStatus || '',
    isCargo: !!f.isCargo,
    aircraft: (f.aircraft && f.aircraft.model) || '',
    departure: normalizeMovement(f.departure),
    arrival: normalizeMovement(f.arrival),
  };
}
