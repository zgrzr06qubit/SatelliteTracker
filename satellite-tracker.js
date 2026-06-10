/*
 * <satellite-tracker> — a self-contained Web Component that shows the live
 * location of an Earth-orbiting satellite on a 2D world map or a 3D globe,
 * and predicts the next passes over the visitor's location.
 *
 * Defaults to tracking D-Orbit's "ION SCV Astounding Alexandra", the carrier
 * hosting the payload, but it can track any object in the public catalog.
 *
 * Orbital data (TLE) is fetched at runtime from CelesTrak in the visitor's
 * browser and propagated client-side with satellite.js (SGP4). No build step
 * and no server are required — drop the script on a page and add the tag:
 *
 *   <script type="module" src="satellite-tracker.js"></script>
 *   <satellite-tracker satellite-name="Astounding Alexandra"></satellite-tracker>
 *
 * Attributes (all optional):
 *   satellite-name   Name (substring) to look up on CelesTrak. Default: "Astounding Alexandra".
 *   norad-id         NORAD catalog number. Takes precedence over satellite-name when set.
 *   tle-line1        Manual TLE line 1. Use with tle-line2 to skip the network entirely.
 *   tle-line2        Manual TLE line 2.
 *   label            Display name shown in the UI. Defaults to the name from the TLE.
 *   view             Initial view: "map" or "globe". Default: "map".
 *   update-interval  Position refresh in ms. Default: 1000.
 *   show-footprint   "true"/"false". Coverage circle. Default: true.
 *   show-track       "true"/"false". Ground track for one orbit. Default: true.
 *   show-terminator  "true"/"false". Day/night shading. Default: true.
 *   show-passes      "true"/"false". Next-pass predictor panel. Default: true.
 *   observer-lat     Preset observer latitude (deg) for pass prediction.
 *   observer-lon     Preset observer longitude (deg) for pass prediction.
 *   min-elevation    Minimum elevation (deg) counted as a visible pass. Default: 10.
 *   pass-count       Number of upcoming passes to list. Default: 3.
 *   units            "metric" or "imperial". Default: metric.
 *   proxy            Optional URL prefix prepended to the CelesTrak request (CORS fallback).
 */

const SATELLITE_JS = 'https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js';
const TOPOJSON_JS = 'https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/dist/topojson-client.min.js';
const D3_GEO_ESM = 'https://cdn.jsdelivr.net/npm/d3-geo@3/+esm';
const LAND_TOPOJSON = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json';

const EARTH_RADIUS_KM = 6371;
const TLE_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // re-fetch elements at most every 2h
const DEG = Math.PI / 180;

// Shared viewBox for both projections (a 2:1 frame; the globe sits centred in it).
const VB_W = 1000;
const VB_H = 500;
const GLOBE_CX = VB_W / 2;
const GLOBE_CY = VB_H / 2;
const GLOBE_R = 225;

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

// Shared promise caches so multiple widgets on a page load each dependency once.
const scriptPromises = new Map();
let landPromise = null;

function loadScript(url) {
  if (scriptPromises.has(url)) return scriptPromises.get(url);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load ' + url));
    document.head.appendChild(s);
  });
  scriptPromises.set(url, p);
  return p;
}

// Load d3-geo as an ES module (not a global UMD script). Dynamic import avoids
// clashing with any existing `d3` global on the host page and bundles d3-geo's
// own dependencies, so `geoOrthographic` & co. are always present.
let d3Promise = null;
function loadD3() {
  if (!d3Promise) d3Promise = import(/* @vite-ignore */ D3_GEO_ESM);
  return d3Promise;
}

// Inject the IBM Plex Mono + Inter web fonts once. Fonts loaded into the
// document apply inside the shadow DOM too, so the widget keeps its typography
// even when embedded on a site that doesn't ship these fonts.
let fontsInjected = false;
function ensureFonts() {
  if (fontsInjected || document.getElementById('sat-tracker-fonts')) return;
  fontsInjected = true;
  const pre1 = Object.assign(document.createElement('link'), { rel: 'preconnect', href: 'https://fonts.googleapis.com' });
  const pre2 = Object.assign(document.createElement('link'), { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' });
  const css = Object.assign(document.createElement('link'), {
    id: 'sat-tracker-fonts', rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=Inter:wght@400;500;600;700&display=swap',
  });
  document.head.append(pre1, pre2, css);
}

// Fetch + decode the world land outline once, shared across instances.
async function loadLand() {
  if (landPromise) return landPromise;
  landPromise = (async () => {
    await loadScript(TOPOJSON_JS);
    const res = await fetch(LAND_TOPOJSON);
    if (!res.ok) throw new Error('land topology HTTP ' + res.status);
    const topo = await res.json();
    // eslint-disable-next-line no-undef
    return topojson.feature(topo, topo.objects.land);
  })().catch((err) => {
    console.warn('[satellite-tracker] basemap unavailable:', err.message);
    return null;
  });
  return landPromise;
}

// Great-circle destination point given start, bearing and angular distance (all radians).
function destination(latRad, lonRad, bearingRad, angDistRad) {
  const lat2 = Math.asin(
    Math.sin(latRad) * Math.cos(angDistRad) +
      Math.cos(latRad) * Math.sin(angDistRad) * Math.cos(bearingRad)
  );
  const lon2 =
    lonRad +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(angDistRad) * Math.cos(latRad),
      Math.cos(angDistRad) - Math.sin(latRad) * Math.sin(lat2)
    );
  return [lat2, lon2];
}

// Approximate geographic position of the Sun (subsolar point) for terminator shading.
function subsolarPoint(date) {
  const jd = date.valueOf() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = 23.439 * DEG;
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  let lon = ra / DEG - gmst;
  lon = (((lon + 180) % 360) + 360) % 360 - 180;
  return { lat: decl / DEG, lon, decl };
}

function compass(azDeg) {
  return COMPASS[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16];
}

class SatelliteTracker extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._timer = null;
    this._satrec = null;
    this._tleName = '';
    this._noradId = '';
    this._view = 'map';
    this._land = null;        // GeoJSON land feature (lon,lat)
    this._proj = null;        // d3 projection for the current view
    this._path = null;        // d3 geoPath generator
    // globe orientation + interaction state
    this._globeLon = 0;
    this._globeLat = 20;
    this._follow = true;
    this._dragging = false;
    this._rafPending = false;
    // cached geometry (geographic), re-projected on demand
    this._satLL = null;
    this._trackLL = [];
    this._termLL = null;
    this._observer = null;
    this._passes = [];
    this._lastTrackAt = 0;
    this._lastTermAt = 0;
    this._lastPassAt = 0;
  }

  connectedCallback() {
    ensureFonts();
    this._view = (this.getAttribute('view') || 'globe').toLowerCase() === 'map' ? 'map' : 'globe';
    this._renderShell();
    this._restoreObserver();
    this._start();
  }

  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // ---- configuration ---------------------------------------------------------
  _boolAttr(name, def) {
    const v = this.getAttribute(name);
    if (v === null) return def;
    return v !== 'false' && v !== '0' && v !== 'no';
  }

  get config() {
    const bool = (name, def) => this._boolAttr(name, def);
    return {
      name: this.getAttribute('satellite-name') || 'Astounding Alexandra',
      noradId: this.getAttribute('norad-id') || '',
      tle1: this.getAttribute('tle-line1') || '',
      tle2: this.getAttribute('tle-line2') || '',
      label: this.getAttribute('label') || '',
      operator: this.getAttribute('operator') || '',
      interval: Math.max(250, parseInt(this.getAttribute('update-interval'), 10) || 1000),
      footprint: bool('show-footprint', true),
      track: bool('show-track', true),
      terminator: bool('show-terminator', true),
      passes: bool('show-passes', true),
      minElevation: parseFloat(this.getAttribute('min-elevation')) || 10,
      passCount: Math.max(1, parseInt(this.getAttribute('pass-count'), 10) || 3),
      imperial: (this.getAttribute('units') || 'metric').toLowerCase() === 'imperial',
      proxy: this.getAttribute('proxy') || '',
    };
  }

  // ---- lifecycle -------------------------------------------------------------
  async _start() {
    const cfg = this.config;
    try {
      this._setStatus('loading', 'Loading orbital data…');
      const [land, , d3lib] = await Promise.all([loadLand(), loadScript(SATELLITE_JS), loadD3()]);
      this._d3 = d3lib;
      this._land = land;
      this._makeProjection();
      this._drawBasemap();

      const { name, l1, l2, noradId } = await this._resolveTle(cfg);
      // eslint-disable-next-line no-undef
      this._satrec = satellite.twoline2satrec(l1, l2);
      this._tleName = name;
      this._noradId = noradId;
      this._epoch = this._epochDate(this._satrec);

      // preset observer from attributes
      const oLat = parseFloat(this.getAttribute('observer-lat'));
      const oLon = parseFloat(this.getAttribute('observer-lon'));
      if (!this._observer && Number.isFinite(oLat) && Number.isFinite(oLon)) {
        this._observer = { lat: oLat, lon: oLon, alt: 0, label: 'Preset location' };
      }
      this._refreshObserverUI();

      this._tick();
      this._timer = setInterval(() => this._tick(), cfg.interval);
      this._setStatus('live', 'Live');
    } catch (err) {
      console.error('[satellite-tracker]', err);
      this._setStatus('error', err.message || 'Failed to load tracker');
    }
  }

  async _resolveTle(cfg) {
    if (cfg.tle1 && cfg.tle2) {
      return { name: cfg.label || cfg.name, l1: cfg.tle1.trim(), l2: cfg.tle2.trim(), noradId: cfg.noradId };
    }
    const query = cfg.noradId
      ? `CATNR=${encodeURIComponent(cfg.noradId)}`
      : `NAME=${encodeURIComponent(cfg.name)}`;
    const celestrak = `https://celestrak.org/NORAD/elements/gp.php?${query}&FORMAT=TLE`;
    const cacheKey = 'sat-tracker:' + query;

    // 1) Serve a fresh-enough cached copy if we have one.
    const cached = this._readCache(cacheKey);
    if (cached) {
      const picked = this._pickEntry(cached.entries, cfg.name);
      if (picked) return cfg.label ? { ...picked, name: cfg.label } : picked;
    }

    // 2) Try, in order: a custom proxy, CelesTrak directly, then public CORS
    //    proxies. CelesTrak does not send CORS headers, so a direct browser
    //    request usually fails on a deployed site — the proxies make it work
    //    with no backend of your own.
    const candidates = [];
    if (cfg.proxy) candidates.push(cfg.proxy + celestrak);
    candidates.push(celestrak);
    candidates.push('https://corsproxy.io/?url=' + encodeURIComponent(celestrak));
    candidates.push('https://api.allorigins.win/raw?url=' + encodeURIComponent(celestrak));

    let entries = null, lastErr = null;
    for (const url of candidates) {
      try {
        const res = await fetch(url, { mode: 'cors' });
        if (!res.ok) { lastErr = new Error('HTTP ' + res.status); continue; }
        const text = (await res.text()).trim();
        if (!text || /no gp data/i.test(text)) { lastErr = new Error('no catalog match'); continue; }
        const parsed = this._parseTle(text);
        if (parsed.length) { entries = parsed; break; }
        lastErr = new Error('unparseable response');
      } catch (err) { lastErr = err; }
    }

    if (entries) {
      this._writeCache(cacheKey, { entries });
      const picked = this._pickEntry(entries, cfg.name);
      if (picked) return cfg.label ? { ...picked, name: cfg.label } : picked;
    }

    // 3) Last resort: reuse the last good elements regardless of age — a TLE
    //    stays usable for days, so the widget keeps working through outages.
    const stale = this._readCache(cacheKey, true);
    if (stale) {
      const picked = this._pickEntry(stale.entries, cfg.name);
      if (picked) return cfg.label ? { ...picked, name: cfg.label } : picked;
    }

    if (lastErr && /match/i.test(lastErr.message)) {
      throw new Error(`No catalog match for "${cfg.noradId || cfg.name}". Check the name or NORAD id.`);
    }
    throw new Error('Could not load orbital data (network or CORS). See README for hosting the data on your own domain.');
  }

  _parseTle(text) {
    const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
    const out = [];
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].startsWith('1 ') && lines[i + 1].startsWith('2 ')) {
        const name = i > 0 && !lines[i - 1].startsWith('1 ') ? lines[i - 1].trim() : 'Unknown';
        const noradId = lines[i].slice(2, 7).trim();
        out.push({ name, l1: lines[i], l2: lines[i + 1], noradId });
      }
    }
    return out;
  }

  _pickEntry(entries, name) {
    if (!entries || !entries.length) return null;
    const wanted = name.toLowerCase();
    return entries.find((e) => e.name.toLowerCase().includes(wanted)) || entries[0];
  }

  _readCache(key, ignoreAge = false) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!ignoreAge && Date.now() - obj.t > TLE_CACHE_TTL_MS) return null;
      return obj.v;
    } catch { return null; }
  }

  _writeCache(key, value) {
    try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value })); } catch { /* ignore */ }
  }

  _epochDate(satrec) {
    const jd = satrec.jdsatepoch + (satrec.jdsatepochF || 0);
    return new Date((jd - 2440587.5) * 86400000);
  }

  // ---- projection (d3-geo) ---------------------------------------------------
  // d3-geo does proper spherical clipping, so land/graticule/track/footprint
  // render correctly on both the equirectangular map and the orthographic globe
  // (no disappearing or overlapping continents at the limb).
  _makeProjection() {
    if (!this._d3) return;
    if (this._view === 'globe') {
      // eslint-disable-next-line no-undef
      this._proj = this._d3.geoOrthographic()
        .scale(GLOBE_R).translate([GLOBE_CX, GLOBE_CY]).clipAngle(90)
        .rotate([-this._globeLon, -this._globeLat]);
    } else {
      // eslint-disable-next-line no-undef
      this._proj = this._d3.geoEquirectangular()
        .scale(VB_W / (2 * Math.PI)).translate([VB_W / 2, VB_H / 2]);
    }
    // eslint-disable-next-line no-undef
    this._path = this._d3.geoPath(this._proj);
  }

  // Keep the orthographic rotation in sync with the current globe orientation.
  _sync() {
    if (this._view === 'globe' && this._proj) this._proj.rotate([-this._globeLon, -this._globeLat]);
  }

  // Project a single [lat,lon] to screen { x, y, v(isible) }.
  _projectPoint(lat, lon) {
    const xy = this._proj([lon, lat]) || [0, 0];
    let v = true;
    if (this._view === 'globe') {
      // eslint-disable-next-line no-undef
      v = this._d3.geoDistance([lon, lat], [this._globeLon, this._globeLat]) < Math.PI / 2;
    }
    return { x: xy[0], y: xy[1], v };
  }

  // SVG path for a polyline given as [lat,lon] points.
  _line(latlon) {
    return this._path({ type: 'LineString', coordinates: latlon.map(([la, lo]) => [lo, la]) }) || '';
  }

  // ---- per-frame update ------------------------------------------------------
  _tick() {
    const now = new Date();
    // eslint-disable-next-line no-undef
    const pv = satellite.propagate(this._satrec, now);
    if (!pv || !pv.position) { this._setStatus('error', 'Propagation error (decayed orbit?)'); return; }
    // eslint-disable-next-line no-undef
    const gmst = satellite.gstime(now);
    // eslint-disable-next-line no-undef
    const geo = satellite.eciToGeodetic(pv.position, gmst);
    // eslint-disable-next-line no-undef
    const lat = satellite.degreesLat(geo.latitude);
    // eslint-disable-next-line no-undef
    const lon = satellite.degreesLong(geo.longitude);
    const alt = geo.height;
    const v = pv.velocity;
    const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);

    const cfg = this.config;
    this._satLL = [lat, lon];
    this._satAlt = alt;
    if (cfg.track && now - this._lastTrackAt > 30000) { this._trackLL = this._computeTrack(now); this._lastTrackAt = +now; }
    if (cfg.terminator && now - this._lastTermAt > 20000) { this._termLL = this._computeTerminator(now); this._lastTermAt = +now; }
    if (cfg.passes && this._observer && now - this._lastPassAt > 60000) {
      this._passes = this._predictPasses(now); this._lastPassAt = +now; this._renderPasses();
    }

    if (this._view === 'globe' && this._follow) {
      this._globeLon = lon;
      this._globeLat = Math.max(-60, Math.min(60, lat));
      this._drawBasemap();
    }
    this._redrawGeo();
    this._updateReadout({ lat, lon, alt, speed, now });
  }

  _computeTrack(now) {
    const periodMin = (2 * Math.PI) / this._satrec.no;
    const halfMs = (periodMin / 2) * 60000;
    const stepMs = (periodMin * 60000) / 180;
    const pts = [];
    for (let t = -halfMs; t <= halfMs; t += stepMs) {
      const d = new Date(+now + t);
      // eslint-disable-next-line no-undef
      const pv = satellite.propagate(this._satrec, d);
      if (!pv || !pv.position) continue;
      // eslint-disable-next-line no-undef
      const g = satellite.eciToGeodetic(pv.position, satellite.gstime(d));
      // eslint-disable-next-line no-undef
      pts.push([satellite.degreesLat(g.latitude), satellite.degreesLong(g.longitude)]);
    }
    return pts;
  }

  _computeTerminator(now) {
    const sun = subsolarPoint(now);
    return { lat: sun.lat, lon: sun.lon };
  }

  // Re-project all cached geometry into the current view.
  _redrawGeo() {
    if (!this._path) return;
    this._sync();
    const e = this._els;
    const cfg = this.config;

    // ground track
    e.track.setAttribute('d', this._trackLL.length ? this._line(this._trackLL) : '');

    // footprint (coverage area)
    //  - Globe: the true geodesic circle (looks circular under orthographic).
    //  - Map: a clean screen-space circle around the marker, since a real
    //    footprint projects to a distorted oval on an equirectangular map.
    const hasFoot = cfg.footprint && this._satLL && this._satAlt != null;
    const footDeg = hasFoot ? Math.acos(EARTH_RADIUS_KM / (EARTH_RADIUS_KM + this._satAlt)) / DEG : 0;
    if (hasFoot && this._view === 'globe') {
      // eslint-disable-next-line no-undef
      const circle = this._d3.geoCircle().center([this._satLL[1], this._satLL[0]]).radius(footDeg)();
      e.footprint.setAttribute('d', this._path(circle) || '');
      e.footring.style.display = 'none';
    } else if (hasFoot && this._view === 'map') {
      const p = this._projectPoint(this._satLL[0], this._satLL[1]);
      const r = (footDeg / 180) * VB_H;
      e.footring.setAttribute('cx', p.x.toFixed(1));
      e.footring.setAttribute('cy', p.y.toFixed(1));
      e.footring.setAttribute('r', r.toFixed(1));
      e.footring.style.display = '';
      e.footprint.setAttribute('d', '');
    } else {
      e.footprint.setAttribute('d', '');
      e.footring.style.display = 'none';
    }

    // day/night terminator: the night hemisphere is a 90°-radius circle around
    // the antisolar point — clipped correctly on both views by d3.
    if (cfg.terminator && this._termLL) {
      // eslint-disable-next-line no-undef
      const night = this._d3.geoCircle().center([this._termLL.lon + 180, -this._termLL.lat]).radius(90)();
      e.night.setAttribute('d', this._path(night) || '');
    } else {
      e.night.setAttribute('d', '');
    }

    // satellite + observer markers
    if (this._satLL) {
      const p = this._projectPoint(this._satLL[0], this._satLL[1]);
      e.sat.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
      e.sat.style.visibility = p.v ? 'visible' : 'hidden';
    }
    if (this._observer) {
      const p = this._projectPoint(this._observer.lat, this._observer.lon);
      e.observer.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
      e.observer.style.visibility = p.v ? 'visible' : 'hidden';
    } else {
      e.observer.style.visibility = 'hidden';
    }
  }

  // ---- next-pass prediction --------------------------------------------------
  _predictPasses(start) {
    const cfg = this.config;
    const obs = this._observer;
    const obsGd = { longitude: obs.lon * DEG, latitude: obs.lat * DEG, height: (obs.alt || 0) / 1000 };
    const minEl = cfg.minElevation;
    const stepS = 30;
    const horizonS = 48 * 3600;
    const out = [];
    let inPass = false, cur = null, prev = null;

    for (let s = 0; s <= horizonS; s += stepS) {
      const date = new Date(+start + s * 1000);
      // eslint-disable-next-line no-undef
      const pv = satellite.propagate(this._satrec, date);
      if (!pv || !pv.position) { prev = null; continue; }
      // eslint-disable-next-line no-undef
      const ecf = satellite.eciToEcf(pv.position, satellite.gstime(date));
      // eslint-disable-next-line no-undef
      const look = satellite.ecfToLookAngles(obsGd, ecf);
      const el = look.elevation / DEG;
      const az = ((look.azimuth / DEG) % 360 + 360) % 360;
      const sample = { date, el, az };

      if (el >= minEl) {
        if (!inPass) {
          inPass = true;
          cur = { aos: this._crossTime(prev, sample, minEl) || date, aosAz: az, maxEl: el, maxAz: az, maxTime: date };
        }
        if (el > cur.maxEl) { cur.maxEl = el; cur.maxAz = az; cur.maxTime = date; }
        cur.last = sample;
      } else if (inPass) {
        cur.los = this._crossTime(cur.last, sample, minEl) || cur.last.date;
        cur.losAz = cur.last.az;
        out.push(cur);
        inPass = false; cur = null;
        if (out.length >= cfg.passCount) break;
      }
      prev = sample;
    }
    return out;
  }

  // Linear interpolation of the time when elevation crosses `target`.
  _crossTime(a, b, target) {
    if (!a || !b || a.el === b.el) return null;
    const frac = (target - a.el) / (b.el - a.el);
    if (frac < 0 || frac > 1) return null;
    return new Date(+a.date + frac * (+b.date - +a.date));
  }

  // ---- readout ---------------------------------------------------------------
  _updateReadout({ lat, lon, alt, speed, now }) {
    const cfg = this.config;
    const f = (n, d = 2) => n.toFixed(d);
    const altDisp = cfg.imperial ? `${f(alt * 0.621371, 1)} mi` : `${f(alt, 1)} km`;
    const spdDisp = cfg.imperial ? `${f(speed * 0.621371, 2)} mi/s` : `${f(speed, 2)} km/s`;
    const periodMin = (2 * Math.PI) / this._satrec.no;
    const incl = this._satrec.inclo / DEG;

    this._els.name.textContent = this._label();
    if (cfg.operator) { this._els.operator.textContent = cfg.operator; this._els.operator.hidden = false; }
    const carrier = this._tleName && this._tleName !== this._label() ? `aboard ${this._tleName}` : '';
    this._els.norad.textContent = [this._noradId ? `NORAD ${this._noradId}` : '', carrier].filter(Boolean).join(' · ');
    this._set('lat', `${f(Math.abs(lat), 3)}° ${lat >= 0 ? 'N' : 'S'}`);
    this._set('lon', `${f(Math.abs(lon), 3)}° ${lon >= 0 ? 'E' : 'W'}`);
    this._set('alt', altDisp);
    this._set('spd', spdDisp);
    this._set('period', `${f(periodMin, 1)} min`);
    this._set('incl', `${f(incl, 2)}°`);
    this._els.epoch.textContent = this._epoch ? `Elements: ${this._ago(this._epoch)} old` : '';
    this._els.updated.textContent = `Updated ${now.toUTCString().replace('GMT', 'UTC')}`;
  }

  _label() { return this.getAttribute('label') || this._tleName || this.config.name; }

  _ago(date) {
    const s = Math.max(0, (Date.now() - date.getTime()) / 1000);
    if (s < 3600) return `${Math.round(s / 60)} min`;
    if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
    return `${(s / 86400).toFixed(1)} d`;
  }

  _set(key, value) { if (this._els[key]) this._els[key].textContent = value; }

  _setStatus(state, text) {
    if (!this._els) return;
    this._els.status.dataset.state = state;
    this._els.statusText.textContent = text;
    this._els.overlay.hidden = state === 'live';
    this._els.overlay.dataset.state = state;
    this._els.overlayMsg.textContent = text;
  }

  // ---- passes UI -------------------------------------------------------------
  _restoreObserver() {
    try {
      const raw = localStorage.getItem('sat-tracker:observer');
      if (raw) this._observer = JSON.parse(raw);
    } catch { /* ignore */ }
  }

  _saveObserver() {
    try { localStorage.setItem('sat-tracker:observer', JSON.stringify(this._observer)); } catch { /* ignore */ }
  }

  _setObserver(lat, lon, label) {
    this._observer = { lat, lon, alt: 0, label: label || `${lat.toFixed(2)}, ${lon.toFixed(2)}` };
    this._saveObserver();
    this._refreshObserverUI();
    this._lastPassAt = 0; // force recompute next tick
    if (this._satrec) { this._passes = this._predictPasses(new Date()); this._lastPassAt = Date.now(); this._renderPasses(); }
    this._redrawGeo();
  }

  _refreshObserverUI() {
    if (!this._els) return;
    if (this._observer) {
      this._els.latIn.value = this._observer.lat.toFixed(4);
      this._els.lonIn.value = this._observer.lon.toFixed(4);
      this._els.locLabel.textContent = this._observer.label || '';
    }
  }

  _renderPasses() {
    const list = this._els.passList;
    if (!this._observer) { list.innerHTML = '<div class="hint">Enter your latitude and longitude to see upcoming passes.</div>'; return; }
    if (!this._passes.length) { list.innerHTML = '<div class="hint">No passes above the horizon in the next 48 h.</div>'; return; }
    const now = Date.now();
    list.innerHTML = this._passes.map((p) => {
      const ongoing = +p.aos <= now && +p.los >= now;
      const durS = Math.round((+p.los - +p.aos) / 1000);
      const dur = `${Math.floor(durS / 60)}m ${String(durS % 60).padStart(2, '0')}s`;
      const when = ongoing ? 'Now' : this._fmtTime(p.aos);
      return `<div class="pass${ongoing ? ' now' : ''}">
        <span class="el">▲ ${Math.round(p.maxEl)}°</span>
        <span class="when">${when}</span>
        <span class="meta">${dur} · ${compass(p.aosAz)}→${compass(p.losAz)}</span>
      </div>`;
    }).join('');
  }

  _fmtTime(date) {
    const opts = { weekday: 'short', hour: '2-digit', minute: '2-digit' };
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleString([], opts);
  }

  // ---- view switching + globe interaction ------------------------------------
  _setView(view) {
    if (view === this._view) return;
    this._view = view;
    this._els.toggle.querySelectorAll('button[data-view]').forEach((b) =>
      b.classList.toggle('active', b.dataset.view === view));
    this._els.followBtn.hidden = view !== 'globe';
    this._els.oceanRect.style.display = view === 'map' ? '' : 'none';
    this._els.oceanDisc.style.display = view === 'globe' ? '' : 'none';
    this._els.stars.style.display = view === 'globe' ? '' : 'none';
    this._els.scene.setAttribute('clip-path', view === 'globe' ? 'url(#discClip)' : 'none');
    this._els.svg.style.cursor = view === 'globe' ? 'grab' : 'default';
    this._makeProjection();
    this._drawBasemap();
    this._redrawGeo();
  }

  _setFollow(on) {
    this._follow = on;
    this._els.followBtn.classList.toggle('active', on);
    if (on && this._satLL) {
      this._globeLon = this._satLL[1];
      this._globeLat = Math.max(-60, Math.min(60, this._satLL[0]));
      this._scheduleRedraw();
    }
  }

  _onPointerDown(ev) {
    if (this._view !== 'globe') return;
    this._dragging = true;
    this._follow = false;
    this._els.followBtn.classList.remove('active');
    this._dragX = ev.clientX; this._dragY = ev.clientY;
    this._els.svg.setPointerCapture(ev.pointerId);
    this._els.svg.style.cursor = 'grabbing';
  }

  _onPointerMove(ev) {
    if (!this._dragging) return;
    const dx = ev.clientX - this._dragX;
    const dy = ev.clientY - this._dragY;
    this._dragX = ev.clientX; this._dragY = ev.clientY;
    this._globeLon = (((this._globeLon - dx * 0.4) + 180) % 360 + 360) % 360 - 180;
    this._globeLat = Math.max(-89, Math.min(89, this._globeLat + dy * 0.4));
    this._scheduleRedraw();
  }

  _onPointerUp(ev) {
    this._dragging = false;
    this._els.svg.style.cursor = this._view === 'globe' ? 'grab' : 'default';
    if (ev && ev.pointerId != null) { try { this._els.svg.releasePointerCapture(ev.pointerId); } catch { /* ignore */ } }
  }

  _scheduleRedraw() {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      this._drawBasemap();
      this._redrawGeo();
    });
  }

  // ---- basemap ---------------------------------------------------------------
  _drawBasemap() {
    if (!this._path) return; // d3 not loaded yet
    this._sync();
    const g = this._els.map;
    // eslint-disable-next-line no-undef
    const grat = this._path(this._d3.geoGraticule10()) || '';
    const land = this._land ? (this._path(this._land) || '') : '';
    g.innerHTML =
      `<path class="graticule" d="${grat}"></path>` +
      (land ? `<path class="land" d="${land}"></path>` : '');
  }

  // ---- DOM scaffolding -------------------------------------------------------
  _renderShell() {
    const root = this.shadowRoot;
    const cfg = this.config;
    root.innerHTML = `
      <style>
        :host {
          display:block;
          /* Qubitrium indigo palette (#2E3192) with bright teal land for contrast */
          --bg:#0a0c24; --space:#06081a; --ocean:#161a52; --land:#3fd9c8;
          --grid:rgba(130,140,235,.22); --accent:#2dd4ff; --brand:#2E3192; --brand-light:#7a80e6;
          --track:#2dd4ff; --foot:rgba(122,176,255,.95); --obs:#34e29b;
          --text:#eef0ff; --muted:#a6abd6; --panel:rgba(14,16,52,.80);
          --font-sans:'Inter',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
          --font-mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
          font-family:var(--font-sans); color:var(--text);
        }
        .card { position:relative; background:var(--bg);
                border:1px solid rgba(122,128,230,.30);
                border-radius:16px; overflow:hidden;
                box-shadow:0 14px 50px rgba(0,0,0,.45), 0 0 0 1px rgba(56,189,248,.06) inset; }
        .mapwrap { position:relative; width:100%; aspect-ratio:2/1; touch-action:none; }
        svg { display:block; width:100%; height:100%;
              background:radial-gradient(130% 130% at 50% 28%, #0c1730 0%, var(--space) 78%); }
        .ocean-rect { fill:url(#oceanGrad); }
        .ocean-disc { filter:drop-shadow(0 0 36px rgba(80,90,220,.45)); }
        .graticule { fill:none; stroke:var(--grid); stroke-width:1; }
        .land { fill:url(#landGrad); stroke:#eafffb; stroke-width:1.1; stroke-linejoin:round;
                paint-order:stroke; }
        .night { fill:rgba(6,7,28,.5); stroke:none; }
        .track { fill:none; stroke:url(#trackGrad); stroke-width:2.6; stroke-linecap:round;
                 stroke-dasharray:1 9; opacity:.95; animation:flow 1.1s linear infinite; }
        @keyframes flow { to { stroke-dashoffset:-10; } }
        .footprint { fill:url(#footGrad); stroke:var(--foot); stroke-width:1.8;
                     stroke-dasharray:7 5; filter:drop-shadow(0 0 6px rgba(122,128,230,.6)); }
        .sat .glow { fill:var(--accent); opacity:.32; }
        .sat .halo { fill:none; stroke:var(--brand-light); stroke-width:2.5; opacity:.95; }
        .sat .edge { fill:#0a0c2e; stroke:none; }
        .sat .core { fill:#eaffff; stroke:var(--accent); stroke-width:3.5; }
        .sat .ping { fill:none; stroke:var(--accent); stroke-width:2.4; animation:ping 2.4s ease-out infinite; }
        .sat .ping2 { animation-delay:1.2s; stroke:var(--brand-light); }
        @keyframes ping { 0%{r:9;opacity:.95} 100%{r:34;opacity:0} }
        .obs .pin { fill:var(--obs); stroke:#06210f; stroke-width:1.5; }
        .obs .ring { fill:none; stroke:var(--obs); stroke-width:1.5; opacity:.6; }

        .panel { position:absolute; top:12px; left:12px; background:var(--panel);
                 backdrop-filter:blur(6px); border:1px solid rgba(148,163,184,.2);
                 border-radius:10px; padding:10px 12px; min-width:178px; font-size:13px; line-height:1.35; }
        .brandlogo { height:22px; width:auto; max-width:120px; display:block; margin-bottom:7px;
                     filter:drop-shadow(0 0 6px rgba(122,128,230,.5)); }
        .operator { display:inline-block; font-size:10px; font-weight:800; letter-spacing:1.5px;
                    text-transform:uppercase; color:#c2c5f5; background:rgba(46,49,146,.35);
                    border:1px solid rgba(122,128,230,.6); border-radius:5px; padding:2px 7px; margin-bottom:6px; }
        .panel h3 { margin:0 0 2px; font-size:16px; font-weight:600; letter-spacing:.4px;
                    font-family:var(--font-mono); }
        .norad { color:var(--muted); font-size:11px; margin-bottom:8px; }
        .grid { display:grid; grid-template-columns:auto auto; gap:2px 14px; }
        .grid .k { color:var(--muted); }
        .grid .v { text-align:right; font-variant-numeric:tabular-nums; font-weight:600; }
        .status { display:flex; align-items:center; gap:6px; margin-top:8px; font-size:11px; color:var(--muted); }
        .dot { width:8px; height:8px; border-radius:50%; background:#64748b; }
        .status[data-state="live"] .dot { background:#22c55e; box-shadow:0 0 8px #22c55e; }
        .status[data-state="error"] .dot { background:#ef4444; }
        .status[data-state="loading"] .dot { background:#f59e0b; }

        .viewtoggle { position:absolute; top:12px; right:12px; display:flex; gap:6px; }
        .viewtoggle .group { display:flex; background:var(--panel); border:1px solid rgba(148,163,184,.2);
                             border-radius:8px; overflow:hidden; backdrop-filter:blur(6px); }
        .viewtoggle button { background:none; border:0; color:var(--muted); padding:6px 12px;
                             font-size:12px; cursor:pointer; font-weight:600; }
        .viewtoggle button.active { background:var(--accent); color:#04223a; }
        .followBtn { background:var(--panel); border:1px solid rgba(148,163,184,.2); border-radius:8px;
                     color:var(--muted); padding:6px 10px; font-size:12px; cursor:pointer; backdrop-filter:blur(6px); }
        .followBtn.active { color:var(--obs); border-color:rgba(34,197,94,.5); }

        .passes { padding:10px 12px; border-top:1px solid rgba(148,163,184,.14); }
        .passhead { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:8px; }
        .passhead .title { font-weight:650; font-size:13px; }
        .passhead .spacer { flex:1; }
        .loc-inputs { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); flex-wrap:wrap; margin-bottom:8px; }
        .loc-inputs input { width:84px; background:#0b1424; border:1px solid rgba(148,163,184,.25);
                            color:var(--text); border-radius:6px; padding:4px 6px; font-size:12px; }
        .loc-inputs .setBtn { background:none; border:1px solid rgba(148,163,184,.3); color:var(--text);
                              border-radius:6px; padding:4px 9px; font-size:12px; cursor:pointer; }
        .locLabel { color:var(--obs); font-size:11px; }
        .passlist { display:flex; flex-direction:column; gap:5px; }
        .pass { display:flex; align-items:center; gap:10px; font-size:13px; padding:6px 9px;
                background:rgba(148,163,184,.07); border-radius:7px; }
        .pass.now { background:rgba(34,197,94,.14); border:1px solid rgba(34,197,94,.4); }
        .pass .el { font-weight:700; color:var(--accent); min-width:46px; }
        .pass .when { font-weight:600; min-width:88px; }
        .pass .meta { color:var(--muted); font-size:12px; }
        .hint { color:var(--muted); font-size:12px; }

        .footer { display:flex; justify-content:space-between; gap:8px; padding:7px 12px;
                  font-size:11px; color:var(--muted); border-top:1px solid rgba(148,163,184,.14); }
        .overlay { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
                   background:rgba(8,12,24,.7); font-size:14px; text-align:center; padding:20px;
                   pointer-events:none; }
        .overlay[data-state="error"] { color:#fca5a5; }
        @media (max-width:560px){
          .panel { min-width:0; left:8px; top:8px; padding:8px 10px; font-size:12px; }
          .pass .meta { display:none; }
        }
      </style>
      <div class="card">
        <div class="mapwrap" id="mapwrap">
          <svg id="svg" viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="xMidYMid slice"
               role="img" aria-label="Live satellite position">
            <defs>
              <radialGradient id="oceanGrad" cx="50%" cy="30%" r="90%">
                <stop offset="0%" stop-color="#1d2266"/><stop offset="100%" stop-color="#12153f"/>
              </radialGradient>
              <radialGradient id="discGrad" cx="38%" cy="32%" r="75%">
                <stop offset="0%" stop-color="#262c80"/><stop offset="70%" stop-color="#161a52"/>
                <stop offset="100%" stop-color="#0c0e30"/>
              </radialGradient>
              <clipPath id="discClip"><circle cx="${GLOBE_CX}" cy="${GLOBE_CY}" r="${GLOBE_R}"/></clipPath>
              <linearGradient id="landGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#6df0dd"/><stop offset="100%" stop-color="#2bbdb4"/>
              </linearGradient>
              <linearGradient id="trackGrad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stop-color="#6f74e6"/><stop offset="100%" stop-color="#2dd4ff"/>
              </linearGradient>
              <radialGradient id="footGrad" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="rgba(45,212,255,0)"/>
                <stop offset="75%" stop-color="rgba(45,212,255,.05)"/>
                <stop offset="100%" stop-color="rgba(122,176,255,.2)"/>
              </radialGradient>
              <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur stdDeviation="3.2" result="b"/>
                <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
              </filter>
              <filter id="softglow" x="-80%" y="-80%" width="260%" height="260%">
                <feGaussianBlur stdDeviation="6" result="b"/>
                <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
              </filter>
            </defs>
            <rect class="ocean-rect" id="oceanRect" x="0" y="0" width="${VB_W}" height="${VB_H}"></rect>
            <g id="stars" style="display:none"></g>
            <circle class="ocean-disc" id="oceanDisc" cx="${GLOBE_CX}" cy="${GLOBE_CY}" r="${GLOBE_R}"
                    fill="url(#discGrad)" style="display:none"></circle>
            <g id="scene" clip-path="none">
              <g id="map"></g>
              <path id="night" class="night fill"></path>
              <circle id="footring" class="footprint" style="display:none"></circle>
              <path id="footprint" class="footprint"></path>
              <path id="track" class="track" filter="url(#glow)"></path>
              <g id="observer" class="obs" style="visibility:hidden">
                <circle class="ring" r="10"></circle>
                <circle class="pin" r="4.5"></circle>
              </g>
              <g id="sat" class="sat" filter="url(#glow)">
                <circle class="ping ping2" r="8"></circle>
                <circle class="ping" r="8"></circle>
                <circle class="glow" r="18"></circle>
                <circle class="halo" r="11"></circle>
                <circle class="edge" r="8"></circle>
                <circle class="core" r="5.5"></circle>
              </g>
            </g>
          </svg>

          <div class="panel">
            <div class="operator" id="operator" hidden></div>
            <h3 id="name">Satellite</h3>
            <div class="norad" id="norad"></div>
            <div class="grid">
              <span class="k">Latitude</span><span class="v" id="lat">–</span>
              <span class="k">Longitude</span><span class="v" id="lon">–</span>
              <span class="k">Altitude</span><span class="v" id="alt">–</span>
              <span class="k">Speed</span><span class="v" id="spd">–</span>
              <span class="k">Period</span><span class="v" id="period">–</span>
              <span class="k">Inclination</span><span class="v" id="incl">–</span>
            </div>
            <div class="status" id="status" data-state="loading">
              <span class="dot"></span><span id="statusText">Starting…</span>
            </div>
          </div>

          <div class="viewtoggle" id="toggle">
            <button class="followBtn active" id="followBtn" hidden>⊙ Follow</button>
            <div class="group">
              <button data-view="map" class="active">Map</button>
              <button data-view="globe">Globe</button>
            </div>
          </div>

          <div class="overlay" id="overlay" data-state="loading"><span id="overlayMsg">Loading…</span></div>
        </div>

        <div class="passes" id="passes" ${cfg.passes ? '' : 'style="display:none"'}>
          <div class="passhead">
            <span class="title">Next passes over your location</span>
          </div>
          <div class="loc-inputs">
            <label>Lat <input id="latIn" type="number" step="0.0001" placeholder="0.0"></label>
            <label>Lon <input id="lonIn" type="number" step="0.0001" placeholder="0.0"></label>
            <button class="setBtn" id="setLoc">Set</button>
            <span class="locLabel" id="locLabel"></span>
          </div>
          <div class="passlist" id="passList">
            <div class="hint">Enter your latitude and longitude to see upcoming passes.</div>
          </div>
        </div>

        <div class="footer">
          <span id="epoch"></span><span id="updated"></span>
        </div>
      </div>
    `;

    const $ = (id) => root.getElementById(id);
    this._els = {
      svg: $('svg'), scene: $('scene'), map: $('map'), night: $('night'), track: $('track'),
      footprint: $('footprint'), footring: $('footring'), sat: $('sat'), observer: $('observer'),
      oceanRect: $('oceanRect'), oceanDisc: $('oceanDisc'), stars: $('stars'),
      operator: $('operator'), name: $('name'), norad: $('norad'), lat: $('lat'), lon: $('lon'), alt: $('alt'),
      spd: $('spd'), period: $('period'), incl: $('incl'),
      status: $('status'), statusText: $('statusText'), epoch: $('epoch'), updated: $('updated'),
      overlay: $('overlay'), overlayMsg: $('overlayMsg'),
      toggle: $('toggle'), followBtn: $('followBtn'),
      latIn: $('latIn'), lonIn: $('lonIn'), locLabel: $('locLabel'), passList: $('passList'),
    };

    // wire events
    this._els.toggle.querySelectorAll('button[data-view]').forEach((b) =>
      b.addEventListener('click', () => this._setView(b.dataset.view)));
    this._els.followBtn.addEventListener('click', () => this._setFollow(!this._follow));
    $('setLoc').addEventListener('click', () => {
      const la = parseFloat(this._els.latIn.value), lo = parseFloat(this._els.lonIn.value);
      if (Number.isFinite(la) && Number.isFinite(lo)) this._setObserver(la, lo, 'Manual location');
      else this._els.locLabel.textContent = 'Enter valid lat/lon';
    });
    const svg = this._els.svg;
    svg.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    svg.addEventListener('pointermove', (e) => this._onPointerMove(e));
    svg.addEventListener('pointerup', (e) => this._onPointerUp(e));
    svg.addEventListener('pointercancel', (e) => this._onPointerUp(e));
    svg.addEventListener('dblclick', () => { if (this._view === 'globe') this._setFollow(true); });

    // optional operator logo (from the host site)
    const logo = this.getAttribute('logo');
    if (logo) {
      const img = document.createElement('img');
      img.className = 'brandlogo';
      img.src = logo;
      img.alt = (this.getAttribute('operator') || '') + ' logo';
      img.onerror = () => img.remove();
      this._els.operator.parentElement.insertBefore(img, this._els.operator);
    }

    this._drawStars();

    // apply initial view
    if (this._view === 'globe') {
      this._els.toggle.querySelector('[data-view="globe"]').classList.add('active');
      this._els.toggle.querySelector('[data-view="map"]').classList.remove('active');
      this._els.followBtn.hidden = false;
      this._els.oceanRect.style.display = 'none';
      this._els.oceanDisc.style.display = '';
      this._els.stars.style.display = '';
      this._els.scene.setAttribute('clip-path', 'url(#discClip)');
      svg.style.cursor = 'grab';
    }
    // Draw an immediate basemap (graticule globe / map) so the view is visible
    // and interactive even before orbital data finishes loading.
    this._drawBasemap();
  }

  // A faint, static starfield shown around the globe (space backdrop).
  _drawStars() {
    let s = '';
    let seed = 1337;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 90; i++) {
      const x = (rnd() * VB_W).toFixed(1);
      const y = (rnd() * VB_H).toFixed(1);
      const r = (0.4 + rnd() * 1.2).toFixed(2);
      const o = (0.25 + rnd() * 0.6).toFixed(2);
      s += `<circle cx="${x}" cy="${y}" r="${r}" fill="#cdd9ff" opacity="${o}"/>`;
    }
    this._els.stars.innerHTML = s;
  }
}

customElements.define('satellite-tracker', SatelliteTracker);
export { SatelliteTracker };
