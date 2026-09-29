// Bandmate · Tour calendar feed (Vercel serverless function)
//
//   GET /api/calendar?t=<token>   →  text/calendar (iCalendar / .ics)
//
// A tour manager's private calendar link (Tools → Calendar). Google, Apple and
// Outlook subscribe to it and re-fetch it on their own schedule, so the tour
// stays current in their calendar without anyone exporting anything:
//   • every date as an all-day event (show / travel / day off …, city, venue)
//   • schedule items and the day's key times (load-in, doors, set …)
//   • flights and ground moves
//   • hotel check-ins and check-outs
//
// Times in Bandmate are wall-clock local to where they happen. Each one is
// placed in its zone (api/_tz.js — the app's own zone logic; flights use each
// airport's zone from the flight lookup cache when it has one) and written in
// UTC, so every calendar shows the right moment wherever it is viewed. A time
// whose zone can't be worked out is written as "floating" (same clock time
// everywhere), exactly as Bandmate itself would show it.
//
// Access: the token maps to (person, tour) in public.calendar_feeds
// (patch-059). On every fetch the person must still own or co-manage the tour
// and the link must not have been reset — otherwise 404.
//
// Env (already set for the other functions): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require('@supabase/supabase-js');
const { dateTz, TZ_CITY, tzOk } = require('./_tz');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.status(405).send('Method not allowed'); return; }
  const token = String((req.query && req.query.t) || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(token)) { res.status(404).send('Calendar not found'); return; }

  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { res.status(503).send('Calendar is not configured'); return; }
  const supa = createClient(url, key, { auth: { persistSession: false } });

  try {
    const { data: feed } = await supa.from('calendar_feeds')
      .select('user_id, tour_id, revoked_at').eq('token', token).maybeSingle();
    if (!feed || feed.revoked_at) { res.status(404).send('This calendar link is no longer active'); return; }

    const { data: tour } = await supa.from('tours')
      .select('id, name, artist, owner_id, manager_ids, crew').eq('id', feed.tour_id).maybeSingle();
    const managers = (tour && Array.isArray(tour.manager_ids)) ? tour.manager_ids.map(String) : [];
    if (!tour || (tour.owner_id !== feed.user_id && !managers.includes(String(feed.user_id)))) {
      res.status(404).send('This calendar link is no longer active'); return;
    }

    const { data: dates } = await supa.from('dates').select('*').eq('tour_id', tour.id).order('date', { ascending: true });
    const flightZones = await loadFlightZones(supa, dates || []);
    const ics = buildCalendar(tour, dates || [], flightZones);

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="bandmate-tour.ics"');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200).send(req.method === 'HEAD' ? '' : ics);
  } catch (e) {
    console.error('[calendar] failed:', e);
    res.status(500).send('Could not build the calendar');
  }
};

// ── Flights: each airport's zone, from the lookup cache (patch-044) ──────
const flightKey = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function loadFlightZones(supa, dates) {
  const wanted = [];
  dates.forEach(d => (d.travel || []).forEach(t => {
    if (t && t.type === 'flight' && t.flightNumber) wanted.push(flightKey(t.flightNumber));
  }));
  const out = {};
  if (!wanted.length) return out;
  try {
    const { data } = await supa.from('flight_cache').select('flight, flight_date, payload').in('flight', [...new Set(wanted)]);
    (data || []).forEach(r => {
      const leg = Array.isArray(r.payload) ? r.payload[0] : null;
      if (leg) out[r.flight + '|' + r.flight_date] = {
        dep: tzOk((leg.departure && leg.departure.timeZone) || ''),
        arr: tzOk((leg.arrival && leg.arrival.timeZone) || ''),
      };
    });
  } catch (e) { /* no cache table — fall back to the cities */ }
  return out;
}

// ── Time handling ─────────────────────────────────────────────────────────
// "15:30", "3:30 PM", "3pm" → "15:30" (or '' when it isn't a time).
function hhmm(v) {
  const m = String(v || '').trim().toLowerCase().replace(/\s+/g, '').replace(/\./g, '').match(/^(\d{1,2})(?::(\d{2}))?(am|pm|a|p)?$/);
  if (!m || (!m[2] && !m[3])) return '';            // a bare number isn't a time
  let h = +m[1];
  const mi = m[2] ? +m[2] : 0, ap = (m[3] || '').charAt(0);
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  if (h > 23 || mi > 59) return '';
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmtCache = {};
function partsIn(z, ms) {
  const f = fmtCache[z] || (fmtCache[z] = new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }));
  const o = {}; f.formatToParts(new Date(ms)).forEach(p => { o[p.type] = p.value; });
  return Date.UTC(+o.year, +o.month - 1, +o.day, (+o.hour) % 24, +o.minute);
}
// A wall-clock time in zone z → { utc: true, ms } ; no zone → floating.
function moment(dateIso, time, z) {
  const [y, mo, d] = dateIso.split('-').map(Number), [H, M] = time.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, H, M);
  if (!z) return { floating: true, ms: wall };
  let guess = wall;
  for (let i = 0; i < 3; i++) guess -= (partsIn(z, guess) - wall);
  return { floating: false, ms: guess };
}
const stamp = m => {
  const s = new Date(m.ms).toISOString().replace(/[-:]/g, '').slice(0, 15);   // YYYYMMDDTHHMMSS
  return m.floating ? s : s + 'Z';
};
const dayStamp = iso => iso.replace(/-/g, '');

// A place's zone from a city string ("Toronto, ON", "Los Angeles (LAX)").
function cityZone(s) {
  const raw = String(s || '').replace(/\s*\([A-Z]{3}\)\s*/, '').trim();
  if (!raw) return '';
  const [city, region] = raw.split(',').map(x => (x || '').trim());
  return dateTz({ city, state: region || '' }) || tzOk(TZ_CITY[city.toLowerCase()] || '');
}

// ── iCalendar text ────────────────────────────────────────────────────────
const esc = s => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const strip = s => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
// Fold to 75 octets per line (RFC 5545 §3.1).
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = []; let cur = '', len = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (len + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; len = 0; }
    cur += ch; len += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const STATUS = { show: 'Show', travel: 'Travel day', off: 'Day off', rehearsal: 'Rehearsal', press: 'Press' };
const nice = s => String(s || '').replace(/^./, c => c.toUpperCase());

function buildCalendar(tour, dates, flightZones) {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const calName = [tour.artist, tour.name].filter(Boolean).join(' · ') || 'Tour';
  const crewName = id => { const c = (tour.crew || []).find(x => x && x.id === id); return c ? c.name : ''; };
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bandmate//Tour calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + esc(calName + ' · Bandmate'), 'X-WR-CALDESC:' + esc('Dates, schedule, travel and hotels from Bandmate. Edit them in Bandmate — this calendar follows.'),
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  const ev = (uid, props) => {
    L.push('BEGIN:VEVENT', 'UID:' + uid + '@bandmate.art', 'DTSTAMP:' + now);
    props.forEach(p => { if (p) L.push(p); });
    L.push('END:VEVENT');
  };
  const timed = (startM, endM) => ['DTSTART:' + stamp(startM), 'DTEND:' + stamp(endM)];
  const allDay = iso => ['DTSTART;VALUE=DATE:' + dayStamp(iso), 'DTEND;VALUE=DATE:' + dayStamp(addDays(iso, 1))];
  const txt = (k, v) => v ? k + ':' + esc(v) : '';

  const seenStays = new Set();
  dates.forEach(d => {
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) return;
    const z = dateTz({ city: d.city, state: d.state, country: d.country, venueLat: d.venue_lat, venueLng: d.venue_lng });
    const place = [d.venue, d.venue_address, [d.city, d.state].filter(Boolean).join(', ')].filter(Boolean).join(', ');
    const status = d.status || 'show';

    // The day itself
    const keyTimes = [['Load-in', d.load_in], ['Soundcheck', d.soundcheck], ['Doors', d.doors], ['Set', d.showtime], ['Curfew', d.curfew]]
      .map(([k, v]) => [k, hhmm(v)]).filter(([, v]) => v);
    const dayTitle = `${STATUS[status] || nice(status)}${d.city ? ' · ' + d.city : ''}${(status === 'show' || status === 'press' || status === 'rehearsal') && d.venue ? ' — ' + d.venue : ''}`;
    const dayDesc = [keyTimes.length ? keyTimes.map(([k, v]) => `${k} ${v}`).join(' · ') + ' (local time)' : '', strip(d.day_notes).slice(0, 1500)]
      .filter(Boolean).join('\n\n');
    ev('day-' + d.id, [...allDay(d.date), txt('SUMMARY', dayTitle), txt('LOCATION', place), txt('DESCRIPTION', dayDesc), 'TRANSP:TRANSPARENT']);

    // Schedule items
    const sched = Array.isArray(d.schedule) ? d.schedule : [];
    sched.forEach(s => {
      if (!s || !s.id || !s.what) return;
      const on = s.nextDay ? addDays(d.date, 1) : d.date;
      const title = s.what + (s.pending ? ' (pending)' : '');
      const who = [...(Array.isArray(s.groups) ? s.groups.filter(g => g && g !== 'All') : []),
                   ...(Array.isArray(s.individuals) ? s.individuals.map(crewName).filter(Boolean) : [])];
      const desc = [who.length ? 'For: ' + who.join(', ') : 'For: everyone', strip(s.notes)].filter(Boolean).join('\n');
      if (s.allDay) { ev('s-' + s.id, [...allDay(on), txt('SUMMARY', title), txt('LOCATION', place), txt('DESCRIPTION', desc), 'TRANSP:TRANSPARENT']); return; }
      const t = hhmm(s.time); if (!t) return;
      const start = moment(on, t, z);
      const et = hhmm(s.endTime);
      let end = et ? moment(on, et, z) : { floating: start.floating, ms: start.ms + 30 * 60e3 };
      if (end.ms <= start.ms) end = et ? { floating: end.floating, ms: end.ms + 864e5 } : { floating: start.floating, ms: start.ms + 30 * 60e3 };
      ev('s-' + s.id, [...timed(start, end), txt('SUMMARY', title), txt('LOCATION', place), txt('DESCRIPTION', desc)]);
    });

    // Key times the schedule doesn't already carry
    keyTimes.forEach(([k, v]) => {
      const re = new RegExp(k === 'Set' ? '\\bset\\b|show' : k.replace('-', '.?'), 'i');
      const covered = sched.some(s => s && !s.allDay && hhmm(s.time) === v && re.test(s.what || ''));
      if (covered) return;
      const start = moment(d.date, v, z);
      ev('k-' + d.id + '-' + k.toLowerCase(), [...timed(start, { floating: start.floating, ms: start.ms + 30 * 60e3 }),
        txt('SUMMARY', k + (d.city ? ' · ' + d.city : '')), txt('LOCATION', place)]);
    });

    // Travel
    (Array.isArray(d.travel) ? d.travel : []).forEach(t => {
      if (!t || !t.id) return;
      const isFlight = t.type === 'flight';
      const from = String(t.fromCity || ''), to = String(t.toCity || '');
      const code = s => (String(s).match(/\(([A-Z]{3})\)/) || [])[1] || String(s).split(',')[0].trim();
      const route = from || to ? ` · ${code(from) || '?'} → ${code(to) || '?'}` : '';
      const title = isFlight ? `Flight ${t.flightNumber || ''}`.trim() + route
        : `${nice(t.type || 'Travel')}${t.description ? ' · ' + t.description : route}`;
      const pax = [...(Array.isArray(t.individuals) ? t.individuals.map(crewName).filter(Boolean) : []),
                   ...(t.person ? [t.person] : [])];
      const desc = [pax.length ? 'Passengers: ' + pax.join(', ') : '', t.conf ? 'Confirmation: ' + t.conf : '', strip(t.notes)].filter(Boolean).join('\n');
      if (t.allDay || !hhmm(t.time)) {
        if (t.allDay) ev('t-' + t.id, [...allDay(d.date), txt('SUMMARY', title), txt('DESCRIPTION', desc), 'TRANSP:TRANSPARENT']);
        return;
      }
      const fz = isFlight ? (flightZones[flightKey(t.flightNumber) + '|' + d.date] || {}) : {};
      const depZ = fz.dep || cityZone(from) || z;
      const arrZ = fz.arr || cityZone(to) || depZ;
      const start = moment(d.date, hhmm(t.time), depZ);
      let end;
      const at = hhmm(t.arriveTime);
      if (at) { end = moment(d.date, at, arrZ); if (end.ms <= start.ms) end = { floating: end.floating, ms: end.ms + 864e5 }; }
      else end = { floating: start.floating, ms: start.ms + (isFlight ? 2 : 1) * 3600e3 };
      ev('t-' + t.id, [...timed(start, end), txt('SUMMARY', title), txt('LOCATION', from ? 'From ' + from : ''), txt('DESCRIPTION', desc)]);
    });

    // Hotels (a stay is stored once, on its check-in date)
    const stays = Array.isArray(d.hotels) && d.hotels.length ? d.hotels : (d.hotel && d.hotel.name ? [Object.assign({ id: 'legacy-' + d.id }, d.hotel)] : []);
    stays.forEach(h => {
      if (!h || !h.name) return;
      const id = h.id || ('h-' + d.id + '-' + h.name);
      if (seenStays.has(id)) return; seenStays.add(id);
      const hz = dateTz({ city: h.city, state: h.state, country: h.country }) || z;
      const addr = [h.address, [h.city, h.state].filter(Boolean).join(', ')].filter(Boolean).join(', ');
      const desc = [h.conf ? 'Confirmation: ' + h.conf : '', h.phone ? 'Phone: ' + h.phone : ''].filter(Boolean).join('\n');
      const inDate = /^\d{4}-\d{2}-\d{2}$/.test(h.checkInDate || '') ? h.checkInDate : d.date;
      let outDate = /^\d{4}-\d{2}-\d{2}$/.test(h.checkOutDate || '') ? h.checkOutDate : addDays(inDate, 1);
      if (outDate <= inDate) outDate = addDays(inDate, 1);     // same-day out = a one-night stay, as the app reads it
      [['in', 'Check in', inDate, h.checkIn], ['out', 'Check out', outDate, h.checkOut]].forEach(([k, label, on, time]) => {
        const t = hhmm(time);
        const when = t ? (() => { const s = moment(on, t, hz); return timed(s, { floating: s.floating, ms: s.ms + 30 * 60e3 }); })() : allDay(on);
        ev('h' + k + '-' + id, [...when, txt('SUMMARY', `${label} · ${h.name}`), txt('LOCATION', addr), txt('DESCRIPTION', desc), t ? '' : 'TRANSP:TRANSPARENT']);
      });
    });
  });

  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}

module.exports.buildCalendar = buildCalendar;
module.exports.hhmm = hhmm;
module.exports.moment = moment;
