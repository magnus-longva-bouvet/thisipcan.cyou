/* ip_lookup.js — data-fetching + normalization (no UI) */

const { Soup, GLib } = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const IPV4_URL   = 'https://ipv4.icanhazip.com';
const GEO_POST   = 'https://www.iplocation.net/get-ipdata';   // form-POST
const ASN_URL    = 'https://thisipcan.cyou/';                 // unchanged (optional)

/* helpers */
function _trim(s) { return (s || '').toString().trim(); }

function _encodeForm(obj) {
    // Build application/x-www-form-urlencoded safely
    const esc = GLib.uri_escape_string;
    return Object.keys(obj)
        .map(k => `${esc(k, null, true)}=${esc(obj[k], null, true)}`)
        .join('&');
}

function _httpGET(session, url) {
    const msg = Soup.Message.new('GET', url);
    const code = session.send_message(msg);
    if (code !== 200) return null;
    try { return msg.response_body.data; } catch (_) { return null; }
}

function _httpPOSTForm(session, url, formObj) {
    const msg = Soup.Message.new('POST', url);
    const encodedBody = _encodeForm(formObj);
    msg.request_headers.append('Content-Type', 'application/x-www-form-urlencoded');
    msg.request_headers.append('Accept', 'application/json, text/plain, */*');
    const ByteArray = imports.byteArray;

    const bytes = new GLib.Bytes(ByteArray.fromString(encodedBody));
    msg.set_request_body_from_bytes('application/x-www-form-urlencoded', bytes);


    const code = session.send_message(msg);
    if (code !== 200) return null;
    try { return msg.response_body.data; } catch (_) { return null; }
}

function _json(txt) { try { return txt ? JSON.parse(txt) : null; } catch (_) { return null; } }

/* Normalizers for a stable, null-safe shape */
function _normalizeGeoFromIplocation(j, ip) {
    // Expected shape:
    // { isProxy, source, res: { ipAddress, countryCode, countryName, cityName, latitude, longitude, ... } }
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
    return {
        hostname: a.hostname ? _trim(a.hostname) : null,
        org:      a.org ? _trim(a.org) : null,
        timezone: a.timezone ? _trim(a.timezone) : null,
    };
}

var IpLookup = class {
    constructor({
        ipv4Url   = IPV4_URL,
        geoPostUrl = GEO_POST,
        asnUrl    = ASN_URL,
        source    = 'ip2location',  // iplocation.net provider name
        ipv       = 4               // 4 or 6
    } = {}) {
        this._ipv4Url   = ipv4Url;
        this._geoPostUrl = geoPostUrl;
        this._asnUrl    = asnUrl;
        this._source    = source;
        this._ipv       = ipv;
        this._session   = new Soup.SessionSync();
    }

    getExternalIPv4() {
        return _trim(_httpGET(this._session, this._ipv4Url));
    }

    getGeo(ip) {
        // iplocation.net prefers explicit ip; if empty, it may infer from client IP.
        const payload = {
            ip: ip || '',
            source: this._source,
            ipv: String(this._ipv),
        };
        const txt = _httpPOSTForm(this._session, this._geoPostUrl, payload);
        const j = _json(txt);
        if (!j) return null;
        return _normalizeGeoFromIplocation(j, ip);
    }

    getASN() {
        const txt = _httpGET(this._session, this._asnUrl);
        const j = _json(txt);
        return _normalizeASN(j);
    }

    /** Returns { ip, geo, asn } with null-safe fields. */
    getAll() {
        const ip  = this.getExternalIPv4();
        const geo = this.getGeo(ip);     // may be null on error
        const asn = this.getASN();       // optional
        return { ip, geo, asn };
    }
};
