// Google Maps extracted parking dataset — a THIRD, independent local parking
// source (alongside OSM/Overpass and the Foursquare plumbing). Classic
// (non-module) script, loaded before app.js. Exposes `window.GoogleMapsParking`.
//
// This is a fixed, hand-extracted CSV (assets/data/baghdad_parking_places.csv)
// — not a live Google Maps API call, and it does not stay up to date on its
// own. Every place in it is a *location*, never a capacity: this module never
// contributes to Known/Estimated Parking Spaces, only to its own separate
// "Google Maps Parking Places" count.

window.GoogleMapsParking = (function () {
  'use strict';

  const CSV_URL = 'assets/data/baghdad_parking_places.csv';
  const SOURCE_LABEL = 'Google Maps extracted parking dataset';

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

  /* ------------------------------------------------------------------ *
   * CSV parsing — a small RFC4180-ish parser: several Address fields in this
   * file contain commas inside quotes (e.g. street, then city), so a naive
   * `line.split(',')` would misalign columns. Handles quoted fields and the
   * `""` escaped-quote convention.
   * ------------------------------------------------------------------ */

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const normalized = text.replace(/\r\n/g, '\n');
    for (let i = 0; i < normalized.length; i++) {
      const c = normalized[i];
      if (inQuotes) {
        if (c === '"') {
          if (normalized[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
      } else {
        field += c;
      }
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => !(r.length === 1 && r[0] === ''));
  }

  function isValidCoordinate(lat, lng) {
    return (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180 &&
      !(lat === 0 && lng === 0) // (0,0) is almost always a parsing failure, never a real Baghdad coordinate
    );
  }

  /* ------------------------------------------------------------------ *
   * Load + parse once, cached — never refetched/reparsed on radius or pin
   * changes (only the cheap in-memory distance filter re-runs each time).
   * ------------------------------------------------------------------ */

  let recordsPromise = null;
  let totalRowsLoaded = 0;

  function loadRecords() {
    if (!recordsPromise) {
      recordsPromise = fetch(CSV_URL, { headers: { Accept: 'text/csv' } })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })
        .then((text) => {
          const rows = parseCsv(text);
          const header = rows[0] || [];
          const dataRows = rows.slice(1);
          totalRowsLoaded = dataRows.length;

          const col = (name) => header.indexOf(name);
          const iName = col('Name');
          const iLat = col('Latitude');
          const iLng = col('Longitude');
          const iAddress = col('Address');
          const iType = col('Type');
          const iLink = col('Google Maps Link');

          const records = [];
          for (const r of dataRows) {
            const lat = Number(r[iLat]);
            const lng = Number(r[iLng]);
            if (!isValidCoordinate(lat, lng)) continue; // invalid rows are skipped, never fabricated
            records.push({
              name: (r[iName] || '').trim() || null,
              lat,
              lng,
              address: (r[iAddress] || '').trim() || null,
              type: (r[iType] || '').trim() || null,
              link: (r[iLink] || '').trim() || null,
            });
          }
          return { available: true, records };
        })
        .catch((err) => {
          console.error('Google Maps parking CSV failed to load', err);
          // Distinct from a genuine empty result — the panel must show
          // "unavailable", never a silently fabricated 0.
          return { available: false, records: [] };
        });
    }
    return recordsPromise;
  }

  /* ------------------------------------------------------------------ *
   * Radius query
   * ------------------------------------------------------------------ */

  async function recalculate(lat, lng, radiusMeters) {
    const loaded = await loadRecords();
    if (!loaded.available) {
      if (typeof console !== 'undefined' && typeof console.debug === 'function') {
        console.debug('Google Parking Dataset Debug:', {
          available: false,
          reason: `Could not load ${CSV_URL}`,
          selectedLat: lat,
          selectedLng: lng,
          selectedRadiusMeters: radiusMeters,
        });
      }
      updateLayer([]);
      return { available: false, count: null, places: [] };
    }

    const inRadius = loaded.records
      .map((r) => ({ ...r, distanceMeters: haversineMetres(lng, lat, r.lng, r.lat) }))
      .filter((r) => r.distanceMeters <= radiusMeters)
      .sort((a, b) => a.distanceMeters - b.distanceMeters);

    if (typeof console !== 'undefined' && typeof console.debug === 'function') {
      console.debug('Google Parking Dataset Debug:', {
        available: true,
        totalRecordsLoaded: totalRowsLoaded,
        validCoordinateRecords: loaded.records.length,
        selectedLat: lat,
        selectedLng: lng,
        selectedRadiusMeters: radiusMeters,
        parkingRecordsInsideRadius: inRadius.length,
      });
    }

    updateLayer(inRadius);
    return { available: true, count: inRadius.length, places: inRadius };
  }

  /* ------------------------------------------------------------------ *
   * Map layer
   * ------------------------------------------------------------------ */

  const SOURCE_ID = 'google-parking-source';
  const POINT_LAYER = 'google-parking-points-layer';
  let mapRef = null;
  let layerVisible = false;

  function init(map) {
    mapRef = map;
    map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: POINT_LAYER,
      type: 'circle',
      source: SOURCE_ID,
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': 5,
        'circle-color': '#2563eb', // blue — distinct from OSM/Foursquare colours
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
      },
    });
  }

  function setLayerVisible(visible) {
    layerVisible = visible;
    if (mapRef) mapRef.setLayoutProperty(POINT_LAYER, 'visibility', visible ? 'visible' : 'none');
  }

  function isLayerVisible() {
    return layerVisible;
  }

  function updateLayer(places) {
    const source = mapRef && mapRef.getSource(SOURCE_ID);
    if (!source) return;
    source.setData({
      type: 'FeatureCollection',
      features: places.map((p, index) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: {
          index,
          name: p.name,
          address: p.address,
          type: p.type,
          link: p.link,
          distanceMeters: Math.round(p.distanceMeters),
        },
      })),
    });
  }

  function queryClick(point) {
    if (!mapRef || !layerVisible) return null;
    const hits = mapRef.queryRenderedFeatures(point, { layers: [POINT_LAYER] });
    return hits.length > 0 ? hits[0] : null;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDistance(metres) {
    if (metres < 1000) return `${Math.round(metres)} m`;
    return `${(metres / 1000).toFixed(1)} km`;
  }

  function row(label, value) {
    return `<div class="parking-popup__row"><span>${label}</span><strong>${value}</strong></div>`;
  }

  function popupHtml(feature) {
    const p = feature.properties;
    const rows = [];
    if (p.address) rows.push(row('Address', escapeHtml(p.address)));
    if (p.type) rows.push(row('Type', escapeHtml(p.type)));
    rows.push(row('Distance', formatDistance(p.distanceMeters)));
    if (p.link) {
      rows.push(
        row(
          'Google Maps',
          `<a href="${escapeHtml(p.link)}" target="_blank" rel="noopener noreferrer">Open</a>`
        )
      );
    }
    rows.push(row('Source', SOURCE_LABEL));

    const title = p.name ? escapeHtml(p.name) : '(unnamed)';
    return `<div class="parking-popup"><div class="parking-popup__title">${title}</div>${rows.join('')}</div>`;
  }

  return {
    init,
    recalculate,
    setLayerVisible,
    isLayerVisible,
    queryClick,
    popupHtml,
    SOURCE_LABEL,
    CSV_URL,
  };
})();
