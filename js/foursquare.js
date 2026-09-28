// Foursquare Open Source Places — a SECOND, independent parking data source
// layered on top of the existing OSM/Overpass feature. Classic (non-module)
// script, loaded before app.js. Exposes `window.FoursquareSource`.
//
// STATUS: Foursquare OS Places turned out to be a gated dataset — both the
// 251 GB place data and the category taxonomy live behind a free account you
// have to create and accept terms for yourself (Hugging Face, or Foursquare's
// own Places Portal + access token). Neither can be done headlessly, and this
// app does not fabricate data to paper over that. So today this module always
// reports "unavailable" — but every other piece specified for this feature
// (the static-extract loading path, the category-ID config, the cross-source
// deduplication, the combined counts, the map styling, the debug output) is
// implemented for real and unit-tested against synthetic data.
//
// TO ACTIVATE WITH REAL DATA: once you have Places Portal or Hugging Face
// access, pre-filter the Foursquare OS Places parquet to Iraq + the parking
// category IDs (offline — this static site never touches the global
// dataset), and drop the result at `assets/foursquare_iraq_parking.json` in
// this exact shape:
//
//   {
//     "generatedAt": "2026-09-28",
//     "categoryIdsUsed": ["<official Parking category ID>", ...],
//     "places": [
//       {
//         "fsq_place_id": "...",
//         "name": "...",
//         "latitude": 33.31,
//         "longitude": 44.36,
//         "fsq_category_ids": ["..."],
//         "categoryLabels": ["Parking"],
//         "address": "...",
//         "locality": "...",
//         "region": "...",
//         "country": "IQ"
//       }
//     ]
//   }
//
// The moment that file exists, this module picks it up automatically — no
// code changes needed. Nothing here ever calls the internet for Foursquare
// data; only that one local, pre-filtered file.

window.FoursquareSource = (function () {
  'use strict';

  const EXTRACT_URL = 'assets/foursquare_iraq_parking.json';

  // Official Foursquare Places category IDs that represent a parking
  // facility. Left EMPTY on purpose: the task is explicit that guessed IDs
  // must never be hardcoded, and the real taxonomy is behind the same gate
  // described above. Populate this from the official category export once
  // you have portal/Hugging Face access — for reference, the categories you
  // are looking for are the ones whose official name or hierarchy is one of:
  //   Parking | Parking Garage | Parking Lot | Car Park | Public Parking
  // and explicitly NOT: Car Dealer, Car Wash, Auto Repair, Gas Station,
  // Rental Car Location (those are different categories entirely).
  //
  // When this list is empty, every place in the extract file is trusted as
  // already being parking-related (i.e. you pre-filtered it yourself); when
  // populated, this filter is applied as a second, defensive pass.
  const PARKING_CATEGORY_IDS = [];

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

  /** Even-odd ray-casting test — is [lon,lat] `point` inside `ring`? Mirrors parking.js's own. */
  function pointInRing(point, ring) {
    const [px, py] = point;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const crosses = yi > py !== yj > py;
      if (crosses && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /** lowercase, trim, strip punctuation, collapse whitespace — for cross-source name matching. */
  function normalizeName(name) {
    if (!name) return '';
    return name
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ') // punctuation -> space (keeps Arabic/Latin letters and digits)
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ------------------------------------------------------------------ *
   * Loading the (currently non-existent) static extract, once, cached.
   * ------------------------------------------------------------------ */

  let extractPromise = null;

  function loadExtract() {
    if (!extractPromise) {
      extractPromise = fetch(EXTRACT_URL, { headers: { Accept: 'application/json' } })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((json) => (Array.isArray(json.places) ? json : { places: [] }))
        .catch(() => null); // any failure (404 today, bad JSON, network) => "unavailable", never fabricated
    }
    return extractPromise;
  }

  function placeCategoryMatches(place) {
    if (PARKING_CATEGORY_IDS.length === 0) return true; // trusting a pre-filtered extract
    const ids = Array.isArray(place.fsq_category_ids) ? place.fsq_category_ids : [];
    return ids.some((id) => PARKING_CATEGORY_IDS.includes(id));
  }

  /**
   * Foursquare POIs within `radiusMeters` of (lat, lon) — a real geographic
   * distance test, applied client-side against the small local extract (never
   * the full global dataset). Resolves `{ available: false }` — never an
   * empty-but-"available" result — when the extract cannot be loaded, so the
   * UI can tell "not configured" apart from a genuine zero.
   */
  async function queryPlaces(lat, lon, radiusMeters) {
    const startedAt = performance.now();
    const extract = await loadExtract();
    if (!extract) {
      return { available: false, places: [], rawCount: 0, queryMs: performance.now() - startedAt };
    }

    const rawCount = extract.places.length;
    const inRadius = extract.places
      .filter(placeCategoryMatches)
      .filter((p) => haversineMetres(lon, lat, p.longitude, p.latitude) <= radiusMeters)
      .map((p) => ({
        id: p.fsq_place_id,
        name: p.name || null,
        lat: p.latitude,
        lng: p.longitude,
        categories: p.categoryLabels && p.categoryLabels.length ? p.categoryLabels : ['Parking'],
        address: p.address || null,
        locality: p.locality || null,
        region: p.region || null,
        source: 'foursquare_os',
      }));

    return { available: true, places: inRadius, rawCount, queryMs: performance.now() - startedAt };
  }

  /* ------------------------------------------------------------------ *
   * Cross-source deduplication
   * ------------------------------------------------------------------ */

  /**
   * True when `fsqPlace` and an OSM facility/structure `osmFeature` are
   * probably the same physical parking location:
   *   - the Foursquare point falls inside the OSM polygon (always a match,
   *     regardless of how far the polygon's centroid is), OR
   *   - they are within 50 m AND (normalized names match, one side has no
   *     usable name but they are within a much tighter 15 m — "strongly
   *     overlapping" — radius, ...).
   * Two distinct nearby lots are never merged just for being close: a missing
   * name alone only counts within that tighter 15 m band, not the full 50 m.
   */
  function isSameFacility(fsqPlace, osmFeature) {
    const fsqPoint = [fsqPlace.lng, fsqPlace.lat];
    const ring = osmFeature.geometry.type === 'Polygon' ? osmFeature.geometry.coordinates[0] : null;
    if (ring && pointInRing(fsqPoint, ring)) return true;

    const center =
      osmFeature.geometry.type === 'Polygon'
        ? centroidOf(osmFeature.geometry.coordinates[0])
        : osmFeature.geometry.coordinates;
    const distance = haversineMetres(fsqPlace.lng, fsqPlace.lat, center[0], center[1]);
    if (distance > 50) return false;

    const fsqName = normalizeName(fsqPlace.name);
    const osmName = normalizeName(osmFeature.properties.name);
    if (fsqName && osmName) {
      return fsqName === osmName || fsqName.includes(osmName) || osmName.includes(fsqName);
    }
    return distance <= 15; // "strongly overlapping" when a usable name is missing on either side
  }

  function centroidOf(ring) {
    let sx = 0;
    let sy = 0;
    for (const [x, y] of ring) {
      sx += x;
      sy += y;
    }
    return [sx / ring.length, sy / ring.length];
  }

  /**
   * Merges OSM facility/structure features with a set of external places
   * into one deduplicated list. Every OSM feature is kept (with its sources
   * annotated); every external place either merges into the OSM feature it
   * matches (first match wins — never merged into more than one) or becomes
   * its own standalone record.
   *
   * Despite living in this file, this function is intentionally generic — it
   * only needs `{id, name, lat, lng}`-shaped places, so app.js also reuses it
   * for the OSM + Google Maps "Combined Unique Parking Locations" figure
   * ("fsqPlaces" below just means "the external source's places", whichever
   * source that happens to be).
   */
  function mergeSources(osmFacilityFeatures, fsqPlaces) {
    const merged = [];
    const claimedFsqIds = new Set();

    for (const osmFeature of osmFacilityFeatures) {
      const match = fsqPlaces.find((p) => !claimedFsqIds.has(p.id) && isSameFacility(p, osmFeature));
      if (match) claimedFsqIds.add(match.id);
      merged.push({
        combinedId: `osm:${osmFeature.properties.id}`,
        sources: match ? ['osm', 'foursquare_os'] : ['osm'],
        osmId: osmFeature.properties.id,
        fsqPlaceId: match ? match.id : null,
        name: osmFeature.properties.name || (match ? match.name : null),
        lat: osmFeature.geometry.type === 'Polygon' ? centroidOf(osmFeature.geometry.coordinates[0])[1] : osmFeature.geometry.coordinates[1],
        lng: osmFeature.geometry.type === 'Polygon' ? centroidOf(osmFeature.geometry.coordinates[0])[0] : osmFeature.geometry.coordinates[0],
      });
    }

    const foursquareOnly = fsqPlaces.filter((p) => !claimedFsqIds.has(p.id));
    for (const place of foursquareOnly) {
      merged.push({
        combinedId: `fsq:${place.id}`,
        sources: ['foursquare_os'],
        osmId: null,
        fsqPlaceId: place.id,
        name: place.name,
        lat: place.lat,
        lng: place.lng,
      });
    }

    return {
      merged,
      osmCount: osmFacilityFeatures.length,
      foursquareCount: fsqPlaces.length,
      duplicateCount: claimedFsqIds.size,
      foursquareOnlyCount: foursquareOnly.length,
      combinedUniqueCount: osmFacilityFeatures.length + foursquareOnly.length,
    };
  }

  /* ------------------------------------------------------------------ *
   * Map layer — Foursquare-ONLY markers get their own source/layer, styled
   * distinctly from OSM's. A location found in both sources shows just the
   * existing OSM marker (enriched via parking.js's setForeignSourceMatches),
   * never a duplicate second pin for the same physical place.
   * ------------------------------------------------------------------ */

  const SOURCE_ID = 'foursquare-source';
  const POINT_LAYER = 'foursquare-points-layer';
  let mapRef = null;
  let layerVisible = false;
  let lastMergedById = new Map(); // combinedId -> merged record, for popupHtml/queryClick

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
        'circle-color': '#ea580c', // orange — distinct from every OSM category colour
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

  function updateLayer(foursquareOnlyRecords) {
    lastMergedById = new Map(foursquareOnlyRecords.map((r) => [r.combinedId, r]));
    const source = mapRef && mapRef.getSource(SOURCE_ID);
    if (!source) return;
    source.setData({
      type: 'FeatureCollection',
      features: foursquareOnlyRecords.map((r) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
        properties: { combinedId: r.combinedId, name: r.name },
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

  /** Foursquare-only marker popup — capacity is always "Unknown": never derived from a POI count. */
  function popupHtml(feature) {
    const name = feature.properties.name ? escapeHtml(feature.properties.name) : '(unnamed)';
    return (
      '<div class="parking-popup">' +
      '<div class="parking-popup__title">Parking Facility</div>' +
      `<div class="parking-popup__row"><span>Name</span><strong>${name}</strong></div>` +
      '<div class="parking-popup__row"><span>Sources</span><strong>✓ Foursquare</strong></div>' +
      '<div class="parking-popup__row"><span>Capacity</span><strong>Unknown</strong></div>' +
      '</div>'
    );
  }

  /* ------------------------------------------------------------------ *
   * Public entry point — app.js calls this right after the OSM/Overpass
   * result comes back, handing it the SAME lat/lng/radius and the OSM
   * facility+structure features so both sources describe the same circle.
   * ------------------------------------------------------------------ */

  async function recalculate(lat, lon, radiusMeters, osmFacilityFeatures) {
    const overallStart = performance.now();
    const fsq = await queryPlaces(lat, lon, radiusMeters);

    if (!fsq.available) {
      if (typeof console !== 'undefined' && typeof console.debug === 'function') {
        console.debug('Parking Multi-Source Debug:', {
          radiusMeters,
          osm: { rawElements: osmFacilityFeatures.length, parkingFacilities: osmFacilityFeatures.length },
          foursquare: { available: false, reason: `Could not load ${EXTRACT_URL} (not configured yet)` },
          categoryIdsQueried: PARKING_CATEGORY_IDS,
          queryExecutionMs: +(performance.now() - overallStart).toFixed(1),
        });
      }
      updateLayer([]);
      if (window.ParkingFeature) window.ParkingFeature.setForeignSourceMatches(new Set());
      return {
        available: false,
        osmCount: osmFacilityFeatures.length,
        foursquareCount: null,
        duplicateCount: null,
        combinedUniqueCount: osmFacilityFeatures.length, // only real source currently contributing
        merged: osmFacilityFeatures.map((f) => ({
          combinedId: `osm:${f.properties.id}`,
          sources: ['osm'],
          osmId: f.properties.id,
          fsqPlaceId: null,
        })),
      };
    }

    const result = mergeSources(osmFacilityFeatures, fsq.places);

    if (typeof console !== 'undefined' && typeof console.debug === 'function') {
      console.debug('Parking Multi-Source Debug:', {
        radiusMeters,
        osm: { rawElements: osmFacilityFeatures.length, parkingFacilities: osmFacilityFeatures.length },
        foursquare: {
          available: true,
          rawPlacesInExtract: fsq.rawCount,
          insideExactRadius: fsq.places.length,
          queryMs: +fsq.queryMs.toFixed(1),
        },
        categoryIdsQueried: PARKING_CATEGORY_IDS,
        deduplication: {
          osmFoursquareMatches: result.duplicateCount,
          foursquareOnly: result.foursquareOnlyCount,
          osmOnly: result.osmCount - result.duplicateCount,
        },
        combinedUniqueFacilities: result.combinedUniqueCount,
        queryExecutionMs: +(performance.now() - overallStart).toFixed(1),
      });
    }

    // Map layer only ever shows Foursquare-only points — a matched location
    // stays a single marker (the existing OSM one, now annotated below).
    const foursquareOnlyRecords = result.merged.filter((r) => r.sources.length === 1 && r.sources[0] === 'foursquare_os');
    updateLayer(foursquareOnlyRecords);

    const matchedOsmIds = new Set(
      result.merged.filter((r) => r.sources.includes('foursquare_os') && r.osmId).map((r) => r.osmId)
    );
    if (window.ParkingFeature) window.ParkingFeature.setForeignSourceMatches(matchedOsmIds);

    return { available: true, ...result };
  }

  return {
    init,
    recalculate,
    setLayerVisible,
    isLayerVisible,
    queryClick,
    popupHtml,
    mergeSources, // exposed for testing
    isSameFacility, // exposed for testing
    normalizeName, // exposed for testing
    PARKING_CATEGORY_IDS,
    EXTRACT_URL,
  };
})();
