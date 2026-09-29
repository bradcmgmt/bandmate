// Bandmate · time zone helpers for the server (shared by api/calendar.js).
//
// A COPY of the zone logic in index.html (_TZ_* tables, _tzSplitUS, _tzOk,
// _dateTz): a date's zone from its state / province, country, city and venue
// pin. If index.html's copy changes, update this one to match.
// Files starting with "_" in /api are not deployed as endpoints.

const _TZ_US = { AL:'America/Chicago', AK:'America/Anchorage', AZ:'America/Phoenix', AR:'America/Chicago', CA:'America/Los_Angeles', CO:'America/Denver',
  CT:'America/New_York', DE:'America/New_York', DC:'America/New_York', FL:'America/New_York', GA:'America/New_York', HI:'Pacific/Honolulu', ID:'America/Boise',
  IL:'America/Chicago', IN:'America/Indiana/Indianapolis', IA:'America/Chicago', KS:'America/Chicago', KY:'America/New_York', LA:'America/Chicago', ME:'America/New_York',
  MD:'America/New_York', MA:'America/New_York', MI:'America/Detroit', MN:'America/Chicago', MS:'America/Chicago', MO:'America/Chicago', MT:'America/Denver',
  NE:'America/Chicago', NV:'America/Los_Angeles', NH:'America/New_York', NJ:'America/New_York', NM:'America/Denver', NY:'America/New_York', NC:'America/New_York',
  ND:'America/Chicago', OH:'America/New_York', OK:'America/Chicago', OR:'America/Los_Angeles', PA:'America/New_York', RI:'America/New_York', SC:'America/New_York',
  SD:'America/Chicago', TN:'America/Chicago', TX:'America/Chicago', UT:'America/Denver', VT:'America/New_York', VA:'America/New_York', WA:'America/Los_Angeles',
  WV:'America/New_York', WI:'America/Chicago', WY:'America/Denver', PR:'America/Puerto_Rico' };
const _TZ_CA = { BC:'America/Vancouver', AB:'America/Edmonton', SK:'America/Regina', MB:'America/Winnipeg', ON:'America/Toronto', QC:'America/Toronto',
  NB:'America/Moncton', NS:'America/Halifax', PE:'America/Halifax', NL:'America/St_Johns', YT:'America/Whitehorse', NT:'America/Yellowknife', NU:'America/Iqaluit' };
const _TZ_AU = { NSW:'Australia/Sydney', ACT:'Australia/Sydney', VIC:'Australia/Melbourne', QLD:'Australia/Brisbane', SA:'Australia/Adelaide',
  WA:'Australia/Perth', TAS:'Australia/Hobart', NT:'Australia/Darwin' };
const _TZ_STATE_NAMES = { alabama:'AL', alaska:'AK', arizona:'AZ', arkansas:'AR', california:'CA', colorado:'CO', connecticut:'CT', delaware:'DE',
  'district of columbia':'DC', florida:'FL', georgia:'GA', hawaii:'HI', idaho:'ID', illinois:'IL', indiana:'IN', iowa:'IA', kansas:'KS', kentucky:'KY',
  louisiana:'LA', maine:'ME', maryland:'MD', massachusetts:'MA', michigan:'MI', minnesota:'MN', mississippi:'MS', missouri:'MO', montana:'MT', nebraska:'NE',
  nevada:'NV', 'new hampshire':'NH', 'new jersey':'NJ', 'new mexico':'NM', 'new york':'NY', 'north carolina':'NC', 'north dakota':'ND', ohio:'OH', oklahoma:'OK',
  oregon:'OR', pennsylvania:'PA', 'rhode island':'RI', 'south carolina':'SC', 'south dakota':'SD', tennessee:'TN', texas:'TX', utah:'UT', vermont:'VT',
  virginia:'VA', washington:'WA', 'west virginia':'WV', wisconsin:'WI', wyoming:'WY', 'puerto rico':'PR',
  'british columbia':'BC', alberta:'AB', saskatchewan:'SK', manitoba:'MB', ontario:'ON', quebec:'QC', 'québec':'QC', 'new brunswick':'NB', 'nova scotia':'NS',
  'prince edward island':'PE', 'newfoundland and labrador':'NL', newfoundland:'NL', yukon:'YT', 'northwest territories':'NT', nunavut:'NU',
  'new south wales':'NSW', 'australian capital territory':'ACT', victoria:'VIC', queensland:'QLD', 'south australia':'SA', 'western australia':'WA',
  tasmania:'TAS', 'northern territory':'NT' };
const _TZ_COUNTRY = { GB:'Europe/London', UK:'Europe/London', 'UNITED KINGDOM':'Europe/London', ENGLAND:'Europe/London', SCOTLAND:'Europe/London', WALES:'Europe/London',
  'NORTHERN IRELAND':'Europe/London', IE:'Europe/Dublin', IRELAND:'Europe/Dublin', FR:'Europe/Paris', FRANCE:'Europe/Paris', DE:'Europe/Berlin', GERMANY:'Europe/Berlin',
  DEUTSCHLAND:'Europe/Berlin', NL:'Europe/Amsterdam', NETHERLANDS:'Europe/Amsterdam', HOLLAND:'Europe/Amsterdam', BE:'Europe/Brussels', BELGIUM:'Europe/Brussels',
  LU:'Europe/Luxembourg', LUXEMBOURG:'Europe/Luxembourg', CH:'Europe/Zurich', SWITZERLAND:'Europe/Zurich', AT:'Europe/Vienna', AUSTRIA:'Europe/Vienna',
  IT:'Europe/Rome', ITALY:'Europe/Rome', ES:'Europe/Madrid', SPAIN:'Europe/Madrid', PT:'Europe/Lisbon', PORTUGAL:'Europe/Lisbon', DK:'Europe/Copenhagen',
  DENMARK:'Europe/Copenhagen', NO:'Europe/Oslo', NORWAY:'Europe/Oslo', SE:'Europe/Stockholm', SWEDEN:'Europe/Stockholm', FI:'Europe/Helsinki', FINLAND:'Europe/Helsinki',
  IS:'Atlantic/Reykjavik', ICELAND:'Atlantic/Reykjavik', PL:'Europe/Warsaw', POLAND:'Europe/Warsaw', CZ:'Europe/Prague', CZECHIA:'Europe/Prague',
  'CZECH REPUBLIC':'Europe/Prague', SK:'Europe/Bratislava', SLOVAKIA:'Europe/Bratislava', HU:'Europe/Budapest', HUNGARY:'Europe/Budapest', GR:'Europe/Athens',
  GREECE:'Europe/Athens', HR:'Europe/Zagreb', CROATIA:'Europe/Zagreb', SI:'Europe/Ljubljana', SLOVENIA:'Europe/Ljubljana', RS:'Europe/Belgrade', SERBIA:'Europe/Belgrade',
  RO:'Europe/Bucharest', ROMANIA:'Europe/Bucharest', BG:'Europe/Sofia', BULGARIA:'Europe/Sofia', EE:'Europe/Tallinn', ESTONIA:'Europe/Tallinn', LV:'Europe/Riga',
  LATVIA:'Europe/Riga', LT:'Europe/Vilnius', LITHUANIA:'Europe/Vilnius', UA:'Europe/Kiev', UKRAINE:'Europe/Kiev', TR:'Europe/Istanbul', TURKEY:'Europe/Istanbul',
  IL:'Asia/Jerusalem', ISRAEL:'Asia/Jerusalem', AE:'Asia/Dubai', UAE:'Asia/Dubai', 'UNITED ARAB EMIRATES':'Asia/Dubai', JP:'Asia/Tokyo', JAPAN:'Asia/Tokyo',
  KR:'Asia/Seoul', 'SOUTH KOREA':'Asia/Seoul', KOREA:'Asia/Seoul', CN:'Asia/Shanghai', CHINA:'Asia/Shanghai', HK:'Asia/Hong_Kong', 'HONG KONG':'Asia/Hong_Kong',
  TW:'Asia/Taipei', TAIWAN:'Asia/Taipei', SG:'Asia/Singapore', SINGAPORE:'Asia/Singapore', PH:'Asia/Manila', PHILIPPINES:'Asia/Manila', TH:'Asia/Bangkok',
  THAILAND:'Asia/Bangkok', IN:'Asia/Kolkata', INDIA:'Asia/Kolkata', NZ:'Pacific/Auckland', 'NEW ZEALAND':'Pacific/Auckland', ZA:'Africa/Johannesburg',
  'SOUTH AFRICA':'Africa/Johannesburg', AR:'America/Argentina/Buenos_Aires', ARGENTINA:'America/Argentina/Buenos_Aires', CL:'America/Santiago', CHILE:'America/Santiago',
  CO:'America/Bogota', COLOMBIA:'America/Bogota', PE:'America/Lima', PERU:'America/Lima', UY:'America/Montevideo', URUGUAY:'America/Montevideo',
  CR:'America/Costa_Rica', 'COSTA RICA':'America/Costa_Rica', PA:'America/Panama', PANAMA:'America/Panama', GT:'America/Guatemala', GUATEMALA:'America/Guatemala',
  JM:'America/Jamaica', JAMAICA:'America/Jamaica', DO:'America/Santo_Domingo', 'DOMINICAN REPUBLIC':'America/Santo_Domingo', PR:'America/Puerto_Rico',
  'PUERTO RICO':'America/Puerto_Rico', MX:'America/Mexico_City', MEXICO:'America/Mexico_City', 'MÉXICO':'America/Mexico_City', BR:'America/Sao_Paulo',
  BRAZIL:'America/Sao_Paulo', BRASIL:'America/Sao_Paulo', RU:'Europe/Moscow', RUSSIA:'Europe/Moscow', ID:'Asia/Jakarta', INDONESIA:'Asia/Jakarta',
  MY:'Asia/Kuala_Lumpur', MALAYSIA:'Asia/Kuala_Lumpur', VN:'Asia/Ho_Chi_Minh', VIETNAM:'Asia/Ho_Chi_Minh', EG:'Africa/Cairo', EGYPT:'Africa/Cairo',
  MA:'Africa/Casablanca', MOROCCO:'Africa/Casablanca', NG:'Africa/Lagos', NIGERIA:'Africa/Lagos', KE:'Africa/Nairobi', KENYA:'Africa/Nairobi' };
// Cities that often appear without a state or country on a routing sheet.
const _TZ_CITY = { london:'Europe/London', manchester:'Europe/London', birmingham:'Europe/London', glasgow:'Europe/London', leeds:'Europe/London', bristol:'Europe/London',
  nottingham:'Europe/London', liverpool:'Europe/London', edinburgh:'Europe/London', cardiff:'Europe/London', belfast:'Europe/London', dublin:'Europe/Dublin',
  paris:'Europe/Paris', lyon:'Europe/Paris', berlin:'Europe/Berlin', hamburg:'Europe/Berlin', cologne:'Europe/Berlin', 'köln':'Europe/Berlin', munich:'Europe/Berlin',
  'münchen':'Europe/Berlin', frankfurt:'Europe/Berlin', amsterdam:'Europe/Amsterdam', utrecht:'Europe/Amsterdam', brussels:'Europe/Brussels', antwerp:'Europe/Brussels',
  madrid:'Europe/Madrid', barcelona:'Europe/Madrid', lisbon:'Europe/Lisbon', milan:'Europe/Rome', rome:'Europe/Rome', zurich:'Europe/Zurich', 'zürich':'Europe/Zurich',
  vienna:'Europe/Vienna', prague:'Europe/Prague', warsaw:'Europe/Warsaw', copenhagen:'Europe/Copenhagen', stockholm:'Europe/Stockholm', oslo:'Europe/Oslo',
  helsinki:'Europe/Helsinki', tokyo:'Asia/Tokyo', osaka:'Asia/Tokyo', seoul:'Asia/Seoul', sydney:'Australia/Sydney', melbourne:'Australia/Melbourne',
  brisbane:'Australia/Brisbane', perth:'Australia/Perth', adelaide:'Australia/Adelaide', auckland:'Pacific/Auckland', wellington:'Pacific/Auckland',
  'mexico city':'America/Mexico_City', 'ciudad de méxico':'America/Mexico_City', monterrey:'America/Monterrey', guadalajara:'America/Mexico_City',
  'são paulo':'America/Sao_Paulo', 'sao paulo':'America/Sao_Paulo', 'rio de janeiro':'America/Sao_Paulo', 'buenos aires':'America/Argentina/Buenos_Aires',
  santiago:'America/Santiago', 'bogotá':'America/Bogota', bogota:'America/Bogota', lima:'America/Lima', toronto:'America/Toronto', montreal:'America/Toronto',
  'montréal':'America/Toronto', ottawa:'America/Toronto', vancouver:'America/Vancouver', calgary:'America/Edmonton', edmonton:'America/Edmonton',
  winnipeg:'America/Winnipeg', halifax:'America/Halifax' };
// States split between two zones: the venue pin decides (without one, the
// zone most of the state is in).
function _tzSplitUS(st, lat, lng) {
  if (lng == null || lat == null) return null;
  switch (st) {
    case 'FL': return lng < -85.0 ? 'America/Chicago' : null;                             // the panhandle west of the Apalachicola
    case 'IN': return ((lat > 40.9 && lng < -86.65) || (lat < 38.3 && lng < -86.6)) ? 'America/Chicago' : null;   // the Gary / LaPorte and Evansville / Tell City corners
    case 'KY': {                                                                           // west of a stepped line: Owensboro, Bowling Green, Paducah (Louisville stays Eastern)
      const edge = lat >= 37.45 ? -86.1 : lat >= 37.15 ? -85.45 : -84.75;
      return lng < edge ? 'America/Chicago' : null;
    }
    case 'TN': {                                                                           // east of the Cumberland Plateau line: Knoxville, Chattanooga, Tri-Cities
      const edge = lat <= 35.0 ? -85.47 : lat <= 35.6 ? -85.47 + (lat - 35.0) / 0.6 * 0.37 : lat <= 36.0 ? -85.1 + (lat - 35.6) / 0.4 * 0.2 : -84.9;
      return lng > edge ? 'America/New_York' : null;
    }
    case 'MI': return (lng < -87.6 && lat > 45.0) ? 'America/Menominee' : null;             // the Upper Peninsula's Wisconsin border
    case 'TX': return lng < -104.9 ? 'America/Denver' : null;                               // El Paso
    case 'KS': return lng < -101.5 ? 'America/Denver' : null;
    case 'NE': return lng < -101.2 ? 'America/Denver' : null;                               // the panhandle
    case 'ND': return (lng < -101.3 && lat < 47.5) ? 'America/Denver' : null;
    case 'SD': return lng < -100.6 ? 'America/Denver' : null;                               // west river — Rapid City
    case 'ID': return lat > 45.6 ? 'America/Los_Angeles' : null;                            // the panhandle — Coeur d'Alene
    case 'OR': return (lng > -117.8 && lat < 44.6) ? 'America/Boise' : null;                // Ontario, Malheur County
    case 'NV': return lng > -114.1 ? 'America/Denver' : null;                               // West Wendover
  }
  return null;
}
function _tzOk(z) {
  if (!z) return '';
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; } catch (e) { return ''; }
}
function _dateTz(d) {
  if (!d) return '';
  if (d.tz) return _tzOk(d.tz);
  const lat = (typeof d.venueLat === 'number' && isFinite(d.venueLat)) ? d.venueLat : null;
  const lng = (typeof d.venueLng === 'number' && isFinite(d.venueLng)) ? d.venueLng : null;
  const rawState = String(d.state || '').trim(), rawCountry = String(d.country || '').trim().replace(/\./g, '');
  const st = (_TZ_STATE_NAMES[rawState.toLowerCase()] || rawState).toUpperCase();
  const co = rawCountry.toUpperCase();
  const isUS = /^(US|USA|UNITED STATES|UNITED STATES OF AMERICA|AMERICA)$/.test(co);
  const isCA = /^(CA|CAN|CANADA)$/.test(co), isAU = /^(AU|AUS|AUSTRALIA)$/.test(co);
  let z = '';
  if (isAU || (!co && _TZ_AU[st] && !_TZ_US[st] && !_TZ_CA[st])) z = _TZ_AU[st] || '';
  else if (isCA || (!co && _TZ_CA[st] && !_TZ_US[st])) {
    z = _TZ_CA[st] || '';
    if (st === 'ON' && lng != null && lng < -89.9) z = 'America/Winnipeg';               // Kenora and the northwest
    if (st === 'BC' && lng != null && lng > -120.1 && lat != null && lat > 55.3) z = 'America/Dawson_Creek';
  }
  else if ((isUS || !co) && _TZ_US[st]) z = _tzSplitUS(st, lat, lng) || _TZ_US[st];
  if (!z && co && !isUS && !isCA && !isAU) {
    z = _TZ_COUNTRY[co] || '';
    if (z === 'America/Mexico_City' && lng != null && lng < -114.5) z = 'America/Tijuana';
  }
  if (!z) z = _TZ_CITY[String(d.city || '').trim().toLowerCase()] || '';
  // A US date with a pin but no state: rough longitude bands beat nothing.
  if (!z && (isUS || !co) && lat != null && lng != null && lat > 24 && lat < 50 && lng > -125 && lng < -66) {
    z = lng > -86.5 ? 'America/New_York' : lng > -101.5 ? 'America/Chicago' : lng > -114.5 ? 'America/Denver' : 'America/Los_Angeles';
  }
  return _tzOk(z);
}

module.exports = { dateTz: _dateTz, TZ_CITY: _TZ_CITY, tzOk: _tzOk };
