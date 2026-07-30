// Bandmate · Place search proxy (Vercel serverless function)
//
// Powers hotel + venue name autocomplete with automatic address / phone
// fill-in. The Google API key stays SERVER-SIDE here — never in index.html,
// which is public and would get the key scraped and billed.
//
// Two actions:
//   POST { action:'search',  kind:'hotel'|'venue', query, city } → predictions
//   POST { action:'details', placeId }                          → full record
//
// Auth: requires a valid Supabase access token so randoms can't hammer the
// endpoint and burn the Google quota. Same verification pattern as
// stripe-portal.js.
//
// Env vars required (Vercel → Project Settings → Environment Variables):
//   GOOGLE_PLACES_KEY          (Google Cloud → Places API (New) key)
//   SUPABASE_URL               (already set for stripe-portal)
//   SUPABASE_SERVICE_ROLE_KEY  (already set for stripe-portal)
//
// GRACEFUL DEGRADE: if GOOGLE_PLACES_KEY isn't set, this returns
// { configured:false, results:[] } with HTTP 200 — the client silently falls
// back to its local history + Supabase cache. So deploying this before the
// key exists breaks nothing.

const { createClient } = require('@supabase/supabase-js');

const PLACES_BASE = 'https://places.googleapis.com/v1';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const googleKey = process.env.GOOGLE_PLACES_KEY;
  const supaUrl = process.env.SUPABASE_URL;
  const supaServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Not configured yet → tell the client politely so it uses local data.
  if (!googleKey) {
    res.status(200).json({ configured: false, results: [] });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  // ── Verify the caller has a real Bandmate session ────────────────────
  const accessToken = (body.supabaseAccessToken || '').toString();
  if (!accessToken) { res.status(401).json({ error: 'Missing session' }); return; }
  if (supaUrl && supaServiceKey) {
    try {
      const supa = createClient(supaUrl, supaServiceKey, { auth: { persistSession: false } });
      const { data, error } = await supa.auth.getUser(accessToken);
      if (error || !data?.user) { res.status(401).json({ error: 'Invalid session' }); return; }
    } catch (e) {
      console.error('[place-search] session verify threw:', e);
      res.status(401).json({ error: 'Could not verify session' }); return;
    }
  }

  const action = (body.action || 'search').toString();

  try {
    if (action === 'details') {
      const placeId = (body.placeId || '').toString().trim();
      if (!placeId) { res.status(400).json({ error: 'Missing placeId' }); return; }
      const fields = [
        'id', 'displayName', 'formattedAddress', 'shortFormattedAddress',
        'internationalPhoneNumber', 'nationalPhoneNumber', 'websiteUri',
        'addressComponents', 'location',
      ].join(',');
      const r = await fetch(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}`, {
        headers: { 'X-Goog-Api-Key': googleKey, 'X-Goog-FieldMask': fields },
      });
      const j = await r.json();
      if (!r.ok) {
        console.error('[place-search] details error:', j?.error?.message || r.status);
        res.status(502).json({ error: j?.error?.message || 'Lookup failed' }); return;
      }
      res.status(200).json({ configured: true, place: normalizeDetails(j) });
      return;
    }

    // ── search ─────────────────────────────────────────────────────────
    const query = (body.query || '').toString().trim();
    const kind = (body.kind || 'hotel').toString();
    const city = (body.city || '').toString().trim();
    if (query.length < 2) { res.status(200).json({ configured: true, results: [] }); return; }

    // Bias the text query with the city so "Estrel" in a Berlin date finds
    // the Berlin property, not a same-named place elsewhere.
    //
    // BUT don't duplicate it: many curated venue names already END in the
    // city ("Fillmore Auditorium Denver"), and asking Google for
    // "Fillmore Auditorium Denver Denver, CO" returns poor or no results.
    // Only append the city when the query doesn't already mention it.
    const cityWord = city.split(',')[0].trim();          // "Denver, CO" → "Denver"
    const qLower = query.toLowerCase();
    const needsCity = cityWord && !qLower.includes(cityWord.toLowerCase());
    const parts = [query];
    if (kind === 'hotel' && !/\bhotel\b/i.test(query)) parts.push('hotel');
    if (needsCity) parts.push(city);
    const textQuery = parts.join(' ').replace(/\s+/g, ' ').trim();
    const payload = { textQuery, maxResultCount: 8 };
    // 'lodging' narrows hotels hard. Venues are wildly varied (theaters,
    // clubs, arenas, festival grounds) so we leave those unrestricted.
    if (kind === 'hotel') payload.includedType = 'lodging';

    const r = await fetch(`${PLACES_BASE}/places:searchText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': googleKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.shortFormattedAddress',
      },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok) {
      console.error('[place-search] search error:', j?.error?.message || r.status);
      res.status(502).json({ error: j?.error?.message || 'Search failed' }); return;
    }
    const results = (j.places || []).map(p => ({
      placeId: p.id || '',
      name: (p.displayName && p.displayName.text) || '',
      address: p.formattedAddress || p.shortFormattedAddress || '',
    })).filter(x => x.name);
    res.status(200).json({ configured: true, results });
  } catch (err) {
    console.error('[place-search] handler error:', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
};

// Flatten a Places (New) detail record into the shape the app stores.
function normalizeDetails(p) {
  const comp = (types) => {
    const c = (p.addressComponents || []).find(x => (x.types || []).some(t => types.includes(t)));
    return c ? (c.longText || c.shortText || '') : '';
  };
  return {
    placeId: p.id || '',
    name: (p.displayName && p.displayName.text) || '',
    address: p.formattedAddress || p.shortFormattedAddress || '',
    phone: p.internationalPhoneNumber || p.nationalPhoneNumber || '',
    website: p.websiteUri || '',
    city: comp(['locality', 'postal_town']) || comp(['administrative_area_level_2']),
    state: comp(['administrative_area_level_1']),
    country: comp(['country']),
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
  };
}
