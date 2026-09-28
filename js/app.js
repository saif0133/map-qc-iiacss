// Population Estimator — standalone static build.
//
// Ported from the Iraq Location Resolver app's population feature
// (backend/src/gis/populationRaster.ts + frontend PopulationMode), with the
// raster reading moved from the server into the browser: `geotiff.js` reads
// only the pixel window a circle's bounding box covers via HTTP range
// requests, so the ~27 MB GeoTIFF is never downloaded in full just to answer
// one query. No backend, no build step — everything here runs as plain
// ES modules the browser executes directly.

// This is a classic (non-module) script: `maplibregl` and `GeoTIFF` come from
// the UMD bundles loaded via plain <script> tags just before this one in
// index.html (js/maplibre-gl.js and js/geotiff.js), not from an import.

const RASTER_URL = 'assets/irq_pop_2026_CN_100m_R2025A_v1.tif';
const DEFAULT_RADIUS_METERS = 1000;

// The app opens on this fixed location and, per product decision, stays
// there — see the map click handler below, which shows a contact message
// instead of moving the pin.
const DEFAULT_PIN = { lat: 33.29568513055442, lng: 44.51014854506647 };
const DEFAULT_PIN_ZOOM = 14;
const CONTACT_EMAIL = 'info@iiacss.org';

const IRAQ_BOUNDS = [
  [38.7, 28.9],
  [48.7, 37.5],
];

/* ------------------------------------------------------------------ *
 * Geometry helpers (ported from backend/src/gis/geometry.ts and
 * frontend/src/utils/geoCircle.ts — same formulas, so the on-map circle and
 * the population sum agree on what "radius" means).
 * ------------------------------------------------------------------ */

const EARTH_RADIUS_M = 6_371_008.8;

function haversineMetres(lon1, lat1, lon2, lat2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function destinationPoint(lat, lon, bearingDeg, distanceM) {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;
  const angularDistance = distanceM / EARTH_RADIUS_M;
  const bearing = bearingDeg * toRad;

  const lat1 = lat * toRad;
  const lon1 = lon * toRad;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );

  return [((lon2 * toDeg + 540) % 360) - 180, lat2 * toDeg];
}

function circlePolygon(lat, lon, radiusMeters, steps = 64) {
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    ring.push(destinationPoint(lat, lon, (360 * i) / steps, radiusMeters));
  }
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: {},
  };
}

function emptyCollection() {
  return { type: 'FeatureCollection', features: [] };
}

/* ------------------------------------------------------------------ *
 * Population raster — windowed, cached reads via geotiff.js in the browser.
 * Logic mirrors backend/src/gis/populationRaster.ts exactly.
 * ------------------------------------------------------------------ */

const NODATA_THRESHOLD = -1;

class PopulationRaster {
  constructor(image, bbox, widthPx, heightPx) {
    this.image = image;
    this.bbox = bbox; // [minX, minY, maxX, maxY]
    this.widthPx = widthPx;
    this.heightPx = heightPx;
    this.cache = new Map();
  }

  static async open(url) {
    const tiff = await window.GeoTIFF.fromUrl(url);
    const image = await tiff.getImage();
    const bbox = image.getBoundingBox();
    return new PopulationRaster(image, bbox, image.getWidth(), image.getHeight());
  }

  async populationInCircle(lat, lon, radiusMeters) {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)},${Math.round(radiusMeters)}`;
    if (this.cache.has(key)) return this.cache.get(key);

    const [minX, minY, maxX, maxY] = this.bbox;

    const metresPerDegLat = 111_320;
    const metresPerDegLon = 111_320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180));
    const latPad = radiusMeters / metresPerDegLat;
    const lonPad = radiusMeters / metresPerDegLon;

    const circleMinX = lon - lonPad;
    const circleMaxX = lon + lonPad;
    const circleMinY = lat - latPad;
    const circleMaxY = lat + latPad;

    // The circle's bounding box does not even touch the raster extent.
    if (circleMaxX < minX || circleMinX > maxX || circleMaxY < minY || circleMinY > maxY) {
      this.cache.set(key, 0);
      return 0;
    }

    const clampedMinX = Math.max(circleMinX, minX);
    const clampedMaxX = Math.min(circleMaxX, maxX);
    const clampedMinY = Math.max(circleMinY, minY);
    const clampedMaxY = Math.min(circleMaxY, maxY);

    const toCol = (x) => Math.floor(((x - minX) / (maxX - minX)) * this.widthPx);
    const toRow = (y) => Math.floor(((maxY - y) / (maxY - minY)) * this.heightPx);

    const colStart = Math.max(0, toCol(clampedMinX) - 1);
    const colEnd = Math.min(this.widthPx, toCol(clampedMaxX) + 2);
    const rowStart = Math.max(0, toRow(clampedMaxY) - 1);
    const rowEnd = Math.min(this.heightPx, toRow(clampedMinY) + 2);

    if (colEnd <= colStart || rowEnd <= rowStart) {
      this.cache.set(key, 0);
      return 0;
    }

    const window = [colStart, rowStart, colEnd, rowEnd];
    const [data] = await this.image.readRasters({ window, fillValue: NODATA_THRESHOLD - 1 });
    if (!data) {
      this.cache.set(key, 0);
      return 0;
    }

    const windowWidth = colEnd - colStart;
    const windowHeight = rowEnd - rowStart;
    const degPerPxX = (maxX - minX) / this.widthPx;
    const degPerPxY = (maxY - minY) / this.heightPx;

    let population = 0;
    for (let row = 0; row < windowHeight; row++) {
      const cellLat = maxY - (rowStart + row + 0.5) * degPerPxY;
      const rowOffset = row * windowWidth;
      for (let col = 0; col < windowWidth; col++) {
        const value = data[rowOffset + col];
        if (value <= NODATA_THRESHOLD) continue;

        const cellLon = minX + (colStart + col + 0.5) * degPerPxX;
        if (haversineMetres(lon, lat, cellLon, cellLat) <= radiusMeters) {
          population += value;
        }
      }
    }

    const rounded = Math.round(population);
    this.cache.set(key, rounded);
    return rounded;
  }
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

const POPULATION_FORMATTER = new Intl.NumberFormat('en-US');
function formatPopulation(value) {
  if (value === null || !Number.isFinite(value)) return '—';
  return POPULATION_FORMATTER.format(Math.round(value));
}

function formatRadius(meters) {
  if (meters < 1000) return `${meters} m`;
  const km = meters / 1000;
  return `${Number(km.toFixed(2))} km`;
}

function formatCoordinates(lat, lon) {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ *
 * Map setup
 * ------------------------------------------------------------------ */

function rasterBasemapStyle() {
  return {
    version: 8,
    sources: {
      basemap: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        attribution: '© OpenStreetMap contributors',
        maxzoom: 19,
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#eef1f5' } },
      { id: 'basemap', type: 'raster', source: 'basemap', paint: { 'raster-opacity': 1 } },
    ],
  };
}

const map = new maplibregl.Map({
  container: 'map',
  style: rasterBasemapStyle(),
  center: [DEFAULT_PIN.lng, DEFAULT_PIN.lat],
  zoom: DEFAULT_PIN_ZOOM,
  maxZoom: 17,
  minZoom: 3,
  maxBounds: [
    [IRAQ_BOUNDS[0][0] - 8, IRAQ_BOUNDS[0][1] - 8],
    [IRAQ_BOUNDS[1][0] + 8, IRAQ_BOUNDS[1][1] + 8],
  ],
  attributionControl: { compact: true },
});

// Handy for debugging in the browser console.
window.__map = map;

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');
map.getCanvas().style.cursor = 'crosshair';

const CIRCLE_SOURCE = 'population-circle-source';
const CIRCLE_FILL_LAYER = 'population-circle-fill-layer';
const CIRCLE_OUTLINE_LAYER = 'population-circle-outline-layer';

map.on('load', () => {
  map.addSource(CIRCLE_SOURCE, { type: 'geojson', data: emptyCollection() });
  map.addLayer({
    id: CIRCLE_FILL_LAYER,
    type: 'fill',
    source: CIRCLE_SOURCE,
    paint: { 'fill-color': '#7c3aed', 'fill-opacity': 0.12 },
  });
  map.addLayer({
    id: CIRCLE_OUTLINE_LAYER,
    type: 'line',
    source: CIRCLE_SOURCE,
    paint: { 'line-color': '#6d28d9', 'line-width': 2, 'line-opacity': 0.85 },
  });

  // Parking Supply reuses this same map instance and, at calculation time,
  // this same circle geometry — see ParkingFeature.recalculate() below.
  window.ParkingFeature.init(map);
  window.FoursquareSource.init(map);
  window.GoogleMapsParking.init(map);

  // The app opens with this fixed location already selected, exactly as if
  // the user had clicked it — same marker, circle, population and parking
  // calculations as any other pin.
  state.point = { ...DEFAULT_PIN };
  recalculate();
});

function markerElement() {
  const element = document.createElement('div');
  element.className = 'population-marker';
  element.setAttribute('aria-hidden', 'true');
  element.innerHTML = `
    <svg viewBox="0 0 24 32" width="30" height="40" focusable="false">
      <path d="M12 0C5.4 0 0 5.4 0 12c0 8.4 12 20 12 20s12-11.6 12-20C24 5.4 18.6 0 12 0z"
            fill="#6d28d9" stroke="#ffffff" stroke-width="2"/>
      <circle cx="12" cy="12" r="4.5" fill="#ffffff"/>
    </svg>`;
  return element;
}

/* ------------------------------------------------------------------ *
 * App state + wiring
 * ------------------------------------------------------------------ */

const state = {
  point: null, // { lat, lng }
  radiusMeters: DEFAULT_RADIUS_METERS,
  raster: null,
  rasterLoadError: null,
  requestId: 0,
};

const rasterAlertEl = document.getElementById('raster-alert');
const rasterAlertMessageEl = document.getElementById('raster-alert-message');

// Start loading immediately — the map is interactive right away, and the
// first click just awaits this same promise rather than re-triggering it.
const rasterReady = PopulationRaster.open(RASTER_URL)
  .then((raster) => {
    state.raster = raster;
  })
  .catch((err) => {
    console.error('Population raster failed to load', err);
    state.rasterLoadError = err instanceof Error ? err.message : String(err);
    rasterAlertMessageEl.textContent =
      'Could not load the population raster in this browser: ' + state.rasterLoadError;
    rasterAlertEl.hidden = false;
  });

let marker = null;
let popup = null;

const panelEmpty = document.getElementById('panel-empty');
const panelResult = document.getElementById('panel-result');
const panelCoords = document.getElementById('panel-coords');
const panelLoading = document.getElementById('panel-loading');
const panelError = document.getElementById('panel-error');
const panelErrorMessage = document.getElementById('panel-error-message');
const panelReadout = document.getElementById('panel-readout');
const panelPopulation = document.getElementById('panel-population');
const mapHint = document.getElementById('map-hint');

const parkingPanelEmpty = document.getElementById('parking-panel-empty');
const parkingPanelResult = document.getElementById('parking-panel-result');
const parkingPanelLoading = document.getElementById('parking-panel-loading');
const parkingPanelError = document.getElementById('parking-panel-error');
const parkingPanelErrorMessage = document.getElementById('parking-panel-error-message');
const parkingStats = document.getElementById('parking-stats');
const parkingStatFacilities = document.getElementById('parking-stat-facilities');
const parkingStatGoogle = document.getElementById('parking-stat-google');
const parkingStatCombined = document.getElementById('parking-stat-combined');
const parkingSourcesNote = document.getElementById('parking-sources-note');
const parkingFoursquareStatus = document.getElementById('parking-foursquare-status');
const parkingStatSpaces = document.getElementById('parking-stat-spaces');
const parkingStatKnown = document.getElementById('parking-stat-known');
const parkingStatEstimated = document.getElementById('parking-stat-estimated');
const parkingStatSupply = document.getElementById('parking-stat-supply');
const parkingRetryButton = document.getElementById('parking-retry-button');
const layerParkingToggle = document.getElementById('layer-parking-toggle');

const INTEGER_FORMATTER = new Intl.NumberFormat('en-US');
function formatInteger(value) {
  if (value === null || !Number.isFinite(value)) return '—';
  return INTEGER_FORMATTER.format(Math.round(value));
}

function renderParkingPanel({ loading, error, summary }) {
  if (!state.point) {
    parkingPanelEmpty.hidden = false;
    parkingPanelResult.hidden = true;
    return;
  }
  parkingPanelEmpty.hidden = true;
  parkingPanelResult.hidden = false;

  parkingPanelLoading.hidden = !loading || !!summary || !!error;
  parkingPanelError.hidden = !error;
  // OSM failing does not take down the rest of the panel — Google Maps'
  // row and the Retry button both still need to render, so the stats list
  // stays visible and shows "Unavailable"/"Unknown" for OSM's own figures
  // instead of disappearing behind a full-panel error state.
  parkingStats.hidden = loading && !summary && !error;

  const MUTED = 'parking-stats__value--muted';
  const setMuted = (el, muted) => el.classList.toggle(MUTED, muted);

  if (error) {
    parkingPanelErrorMessage.textContent = error;
    parkingStatFacilities.textContent = 'Unavailable';
    setMuted(parkingStatFacilities, true);
    parkingStatSpaces.textContent = '—';
    setMuted(parkingStatSpaces, true);
    parkingStatKnown.textContent = '—';
    setMuted(parkingStatKnown, true);
    parkingStatEstimated.textContent = '—';
    setMuted(parkingStatEstimated, true);
    parkingStatSupply.textContent = 'Unknown';
    setMuted(parkingStatSupply, true);
    return;
  }
  if (!summary) return;

  // Raw counts of returned objects are always real, knowable numbers — 0
  // mapped facilities/spaces is itself a fact worth showing, never "unknown".
  parkingStatFacilities.textContent = formatInteger(summary.mappedParkingFacilities);
  parkingStatSpaces.textContent = formatInteger(summary.mappedIndividualParkingSpaces);

  // Known / estimated / total are only ever real numbers once at least one
  // facility in this circle reported a capacity (see parking.js). Otherwise
  // they are `null` — genuinely unknown, not a confirmed zero — and shown as
  // "—" in a neutral style rather than a misleading green 0.
  const knownUnknown = summary.knownParkingSpaces === null;
  parkingStatKnown.textContent = knownUnknown ? '—' : formatInteger(summary.knownParkingSpaces);
  setMuted(parkingStatKnown, knownUnknown);

  const estimatedUnknown = summary.estimatedParkingSpaces === null;
  parkingStatEstimated.textContent = estimatedUnknown
    ? '—'
    : summary.estimatedParkingSpaces > 0
      ? `~${formatInteger(summary.estimatedParkingSpaces)}`
      : formatInteger(0);
  setMuted(parkingStatEstimated, estimatedUnknown);

  let supplyText;
  if (summary.parkingSupplyStatus === 'none') {
    supplyText = 'No mapped parking found';
  } else if (summary.totalParkingSupply === null) {
    supplyText = 'Unknown';
  } else if (summary.totalParkingSupply > 0) {
    supplyText = `~${formatInteger(summary.totalParkingSupply)}`;
  } else {
    supplyText = formatInteger(0);
  }
  parkingStatSupply.textContent = supplyText;
  setMuted(parkingStatSupply, summary.totalParkingSupply === null);
}

const MUTED_CLASS = 'parking-stats__value--muted';

// The sources this tool is built on are a fixed, structural fact — shown
// unconditionally, regardless of whether any one request happened to
// succeed. Foursquare is different: it is categorically "not configured yet"
// rather than a live source having a transient hiccup, so it gets its own
// small, separate status line instead of appearing as a headline metric.
const SOURCES_NOTE_TEXT = 'Sources:\nOpenStreetMap (queried via Geofabrik Postpass)\nGoogle Maps extracted parking dataset';
parkingSourcesNote.textContent = SOURCES_NOTE_TEXT;

/**
 * Renders the Google Maps row and the OSM+Google "Combined Unique Parking
 * Locations" row. `combinedUniqueCount` is `null` while either OSM's own
 * result or the Google Maps lookup is still pending — both are required to
 * compute it. `foursquareAvailable` only ever drives the small status line
 * at the bottom, never a headline metric (see the panel-simplification pass).
 */
function renderParkingSources({ combinedUniqueCount, googleResult, foursquareAvailable }) {
  if (!googleResult) {
    parkingStatGoogle.textContent = '—';
    parkingStatGoogle.classList.add(MUTED_CLASS);
  } else if (!googleResult.available) {
    parkingStatGoogle.textContent = 'Google Maps data unavailable';
    parkingStatGoogle.classList.add(MUTED_CLASS);
  } else {
    parkingStatGoogle.textContent = formatInteger(googleResult.count);
    parkingStatGoogle.classList.remove(MUTED_CLASS);
  }

  if (combinedUniqueCount === null) {
    parkingStatCombined.textContent = '—';
    parkingStatCombined.classList.add(MUTED_CLASS);
  } else {
    parkingStatCombined.textContent = formatInteger(combinedUniqueCount);
    parkingStatCombined.classList.remove(MUTED_CLASS);
  }

  parkingFoursquareStatus.hidden = foursquareAvailable !== false;
  if (foursquareAvailable === false) {
    parkingFoursquareStatus.textContent = 'Foursquare Open Source Places: not configured';
  }
}

function renderPanel({ loading, error, population }) {
  if (!state.point) {
    panelEmpty.hidden = false;
    panelResult.hidden = true;
    return;
  }
  panelEmpty.hidden = true;
  panelResult.hidden = false;
  panelCoords.textContent = formatCoordinates(state.point.lat, state.point.lng);

  panelLoading.hidden = !loading || population !== null;
  panelError.hidden = !error;
  panelReadout.hidden = !!error || (loading && population === null);

  if (error) {
    panelErrorMessage.textContent = error;
  } else if (!panelReadout.hidden) {
    panelPopulation.textContent = formatPopulation(population);
  }
}

function renderPopup({ loading, error, population }) {
  if (!popup || !state.point) return;
  const radiusText = formatRadius(state.radiusMeters);

  let body;
  if (error) {
    body = `<div class="population-popup__error">${escapeHtml(error)}</div>`;
  } else if (loading && population === null) {
    body = `<div class="population-popup__loading">Calculating population...</div>`;
  } else {
    body = `
      <div class="population-popup__row">
        <span class="population-popup__label">Population</span>
        <strong class="population-popup__value" dir="ltr">${escapeHtml(formatPopulation(population))}</strong>
      </div>
      <div class="population-popup__row">
        <span class="population-popup__label">Radius</span>
        <strong class="population-popup__value" dir="ltr">${escapeHtml(radiusText)}</strong>
      </div>`;
  }

  popup.setHTML(
    `<div class="population-popup">
       <div class="population-popup__title">📍 Selected Location</div>
       ${body}
     </div>`
  );
}

function updateCircle() {
  const source = map.getSource(CIRCLE_SOURCE);
  if (!source) return;
  if (!state.point) {
    source.setData(emptyCollection());
    return;
  }
  source.setData({
    type: 'FeatureCollection',
    features: [circlePolygon(state.point.lat, state.point.lng, state.radiusMeters)],
  });
}

function updateMarker() {
  if (!state.point) {
    marker?.remove();
    marker = null;
    popup = null;
    return;
  }
  if (!marker) {
    popup = new maplibregl.Popup({ offset: 34, closeButton: true, closeOnClick: false, maxWidth: '240px' });
    const element = markerElement();
    marker = new maplibregl.Marker({ element, anchor: 'bottom' })
      .setLngLat([state.point.lng, state.point.lat])
      .setPopup(popup)
      .addTo(map);
    marker.togglePopup();
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      marker.togglePopup();
    });
  } else {
    marker.setLngLat([state.point.lng, state.point.lat]);
    if (!popup.isOpen()) marker.togglePopup();
  }
}

// Guards the second (Foursquare) step below against a stale response landing
// after a newer pin/radius change — mirrors the token pattern already used
// inside parking.js and app.js's own population recalculate().
let parkingSourcesGeneration = 0;

function recalculateParking() {
  const myGeneration = ++parkingSourcesGeneration;

  // Same pin, same radius, same circle ring the population figure above just
  // used — ParkingFeature only ever sees values this file already computed,
  // it never tracks its own copy of "where" or "how far".
  const circleRing = circlePolygon(state.point.lat, state.point.lng, state.radiusMeters).geometry
    .coordinates[0];

  let osmFacilityCount = 0;
  let osmFacilityFeatures = null; // OSM's own facility/structure features, for cross-source dedup
  let googleResult = null;
  let foursquareAvailable = null;
  let combinedUniqueCount = null; // null until BOTH OSM and Google have answered

  // "Combined Unique Parking Locations" = OSM + Google Maps, deduplicated —
  // reuses the exact same cross-source matching logic already built (and
  // unit-tested) for OSM+Foursquare; the algorithm only ever needs
  // {id, name, lat, lng}-shaped places, so it is not Foursquare-specific.
  function recomputeCombined() {
    if (!osmFacilityFeatures || !googleResult) return; // still waiting on one of the two
    if (!googleResult.available) {
      combinedUniqueCount = osmFacilityCount; // Google unavailable -> falls back to OSM-only, never fabricated
      return;
    }
    const googlePlacesWithIds = googleResult.places.map((p, i) => ({
      id: `google:${i}`,
      name: p.name,
      lat: p.lat,
      lng: p.lng,
    }));
    combinedUniqueCount = window.FoursquareSource.mergeSources(osmFacilityFeatures, googlePlacesWithIds)
      .combinedUniqueCount;
  }

  const rerender = () => renderParkingSources({ combinedUniqueCount, googleResult, foursquareAvailable });

  // Google Maps needs nothing from OSM — it starts immediately, in parallel.
  window.GoogleMapsParking.recalculate(state.point.lat, state.point.lng, state.radiusMeters).then(
    (result) => {
      if (myGeneration !== parkingSourcesGeneration) return; // superseded by a newer pin/radius
      googleResult = result;
      recomputeCombined();
      rerender();
    }
  );

  window.ParkingFeature.recalculate(state.point.lat, state.point.lng, state.radiusMeters, circleRing, {
    onLoading: () => {
      renderParkingPanel({ loading: true, error: null, summary: null });
      rerender();
    },
    onResult: (summary) => {
      renderParkingPanel({ loading: false, error: null, summary });
      osmFacilityCount = summary.mappedParkingFacilities;
      osmFacilityFeatures = summary.geojson.features.filter(
        (f) => f.properties.category === 'facility' || f.properties.category === 'structure'
      );
      recomputeCombined();
      rerender();

      // Foursquare keeps running purely so the small status line can
      // honestly report whether it is configured — its own counts no longer
      // appear as headline metrics (see the panel-simplification pass), and
      // it never contributes to "Combined Unique Parking Locations" above.
      window.FoursquareSource.recalculate(
        state.point.lat,
        state.point.lng,
        state.radiusMeters,
        osmFacilityFeatures
      ).then((result) => {
        if (myGeneration !== parkingSourcesGeneration) return; // superseded by a newer pin/radius
        foursquareAvailable = result.available;
        rerender();
      });
    },
    onError: (message) => {
      console.warn('OSM parking data unavailable:', message);
      renderParkingPanel({ loading: false, error: message, summary: null });
      rerender();
    },
  });
}

async function recalculate() {
  const myRequestId = ++state.requestId;
  updateMarker();
  updateCircle();
  renderPanel({ loading: true, error: null, population: null });
  renderPopup({ loading: true, error: null, population: null });
  mapHint.textContent = 'Showing results for the selected location. Click elsewhere on the map for contact details.';
  recalculateParking();

  // The raster may still be loading (its own network fetch) on the very
  // first click — wait for that same in-flight load rather than failing.
  await rasterReady;
  if (myRequestId !== state.requestId) return;

  if (!state.raster) {
    const message = state.rasterLoadError ?? 'The population raster failed to load in this browser.';
    renderPanel({ loading: false, error: message, population: null });
    renderPopup({ loading: false, error: message, population: null });
    return;
  }

  try {
    const population = await state.raster.populationInCircle(
      state.point.lat,
      state.point.lng,
      state.radiusMeters
    );
    if (myRequestId !== state.requestId) return; // a newer click/radius change superseded this one
    renderPanel({ loading: false, error: null, population });
    renderPopup({ loading: false, error: null, population });
  } catch (err) {
    if (myRequestId !== state.requestId) return;
    const message = err instanceof Error ? err.message : String(err);
    renderPanel({ loading: false, error: message, population: null });
    renderPopup({ loading: false, error: message, population: null });
  }
}

map.on('click', (event) => {
  // A click on a visible OSM parking feature still opens its own popup.
  const parkingFeature = window.ParkingFeature.queryClick(event.point);
  if (parkingFeature) {
    new maplibregl.Popup({ closeButton: true, maxWidth: '260px' })
      .setLngLat(event.lngLat)
      .setHTML(window.ParkingFeature.popupHtml(parkingFeature))
      .addTo(map);
    return;
  }

  // Same for a Foursquare-only marker (a location matched to an OSM feature
  // never gets its own separate marker — see FoursquareSource.updateLayer()).
  const foursquareFeature = window.FoursquareSource.queryClick(event.point);
  if (foursquareFeature) {
    new maplibregl.Popup({ closeButton: true, maxWidth: '260px' })
      .setLngLat(event.lngLat)
      .setHTML(window.FoursquareSource.popupHtml(foursquareFeature))
      .addTo(map);
    return;
  }

  // Same for a Google Maps extracted-dataset marker.
  const googleFeature = window.GoogleMapsParking.queryClick(event.point);
  if (googleFeature) {
    new maplibregl.Popup({ closeButton: true, maxWidth: '260px' })
      .setLngLat(event.lngLat)
      .setHTML(window.GoogleMapsParking.popupHtml(googleFeature))
      .addTo(map);
    return;
  }

  // The pin is fixed to DEFAULT_PIN by product decision — a click anywhere
  // else never moves it or re-runs the calculations, it just points the user
  // at contact info for other locations.
  new maplibregl.Popup({ closeButton: true, maxWidth: '260px' })
    .setLngLat(event.lngLat)
    .setHTML(
      `<div class="contact-popup">For more information contact <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></div>`
    )
    .addTo(map);
});

layerParkingToggle.addEventListener('change', () => {
  window.ParkingFeature.setLayerVisible(layerParkingToggle.checked);
  window.FoursquareSource.setLayerVisible(layerParkingToggle.checked);
  window.GoogleMapsParking.setLayerVisible(layerParkingToggle.checked);
});

// The pin never moves once set (see the map click handler above), so a
// failed lookup — e.g. the Postpass proxy briefly unavailable — needs its
// own way to try again without waiting for a radius change.
parkingRetryButton.addEventListener('click', () => {
  if (state.point) recalculateParking();
});

for (const button of document.querySelectorAll('.radius-selector__option')) {
  button.addEventListener('click', () => {
    const meters = Number(button.dataset.radius);
    if (meters === state.radiusMeters) return;
    state.radiusMeters = meters;
    for (const other of document.querySelectorAll('.radius-selector__option')) {
      const active = other === button;
      other.classList.toggle('radius-selector__option--active', active);
      other.setAttribute('aria-checked', String(active));
    }
    if (state.point) recalculate();
  });
}
