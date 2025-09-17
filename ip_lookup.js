const { Soup, GLib } = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const IPV4_URL = 'https://ipv4.icanhazip.com';
const GEO_POST = 'https://www.iplocation.net/get-ipdata';
const ASN_URL  = 'https://thisipcan.cyou/';

function _trim(s) { return (s || '').toString().trim(); }
function _json(txt){ try{ return txt ? JSON.parse(txt) : null; } catch(_) { return null; } }

function _encodeForm(obj) {
  const esc = GLib.uri_escape_string;
  return Object.keys(obj).map(k => `${esc(k, null, true)}=${esc(obj[k], null, true)}`).join('&');
}

function _httpGETAsync(session, url, timeoutSec=6) {
  return new Promise((resolve) => {
    try { session.timeout = timeoutSec; } catch (_) {}
    const msg = Soup.Message.new('GET', url);
    session.queue_message(msg, (_s, m) => {
      if (m && m.status_code === 200) {
        try { resolve(m.response_body.data); } catch(_) { resolve(null); }
      } else resolve(null);
    });
  });
}

function _httpPOSTFormAsync(session, url, formObj, timeoutSec=6) {
  return new Promise((resolve) => {
    try { session.timeout = timeoutSec; } catch (_) {}
    const msg = Soup.Message.new('POST', url);
    const body = _encodeForm(formObj);
    const ByteArray = imports.byteArray;
    const bytes = new GLib.Bytes(ByteArray.fromString(body));
    msg.request_headers.append('Content-Type', 'application/x-www-form-urlencoded');
    msg.request_headers.append('Accept', 'application/json, text/plain, */*');
    msg.set_request_body_from_bytes('application/x-www-form-urlencoded', bytes);
    session.queue_message(msg, (_s, m) => {
      if (m && m.status_code === 200) {
        try { resolve(m.response_body.data); } catch(_) { resolve(null); }
      } else resolve(null);
    });
  });
}

function _normalizeGeoFromIplocation(j, ip) {
  const r = (j && j.res) ? j.res : {};
  const lat = (typeof r.latitude === 'number') ? r.latitude : null;
  const lon = (typeof r.longitude === 'number') ? r.longitude : null;
  return {
    ipAddress: _trim(r.ipAddress || ip),
    countryCode: r.countryCode ? _trim(r.countryCode) : null,
    countryName: r.countryName ? _trim(r.countryName) : null,
    cityName:    r.cityName ? _trim(r.cityName) : null,
    latitude: lat,
    longitude: lon,
    isp: r.isp ? _trim(r.isp) : null,
    regionName: r.regionName ? _trim(r.regionName) : null,
    providerSource: (j && j.source) ? _trim(j.source) : 'ip2location',
  };
}

function _normalizeASN(raw) {
  const a = raw || {};
  return { hostname: a.hostname ? _trim(a.hostname) : null,
           org:      a.org ? _trim(a.org) : null,
           timezone: a.timezone ? _trim(a.timezone) : null };
}

var IpLookup = class {
  constructor({
    ipv4Url   = IPV4_URL,
    geoPostUrl = GEO_POST,
    asnUrl    = ASN_URL,
    source    = 'ip2location',
    ipv       = 4
  } = {}) {
    this._ipv4Url   = ipv4Url;
    this._geoPostUrl = geoPostUrl;
    this._asnUrl    = asnUrl;
    this._source    = source;
    this._ipv       = ipv;

    // Keep the old sync session for any legacy callers (not used after patch)
    this._session   = new Soup.SessionSync();
  }

  // New: non-blocking end-to-end fetch
  async getAllAsync({ timeoutSec = 6 } = {}) {
    const session = new Soup.Session(); // async
    const ipTxt = await _httpGETAsync(session, this._ipv4Url, timeoutSec);
    const ip = _trim(ipTxt);

    const geoTxt = await _httpPOSTFormAsync(session, this._geoPostUrl, {
      ip: ip || '',
      source: this._source,
      ipv: String(this._ipv),
    }, timeoutSec);

    const asnTxt = await _httpGETAsync(session, this._asnUrl, timeoutSec);

    const geo = _normalizeGeoFromIplocation(_json(geoTxt), ip);
    const asn = _normalizeASN(_json(asnTxt));
    return { ip, geo, asn };
  }

  // (Keep existing sync methods if you still call them elsewhere, but prefer getAllAsync)
};
