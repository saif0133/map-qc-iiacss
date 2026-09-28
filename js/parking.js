// Parking Supply by Distance — classic (non-module) script, loaded before
// js/app.js. Exposes `window.ParkingFeature`, a self-contained subsystem that
// app.js drives with the SAME pin and radius state the population feature
// already uses — this file never reads the map's clicks or the radius
// buttons itself, so there is exactly one place (app.js) that decides what
// the "current pin" and "current radius" are.
//
// Data source: the public Overpass API (a free, non-commercial OpenStreetMap
// query service — not a paid API, not a backend we run). Element selection
// uses Overpass's own `around:radius,lat,lon` filter, which is a true
// great-circle ("as the crow flies") distance test done server-side — the
// same straight-line notion of "radius" the population feature uses, never a
// drive-time or travel-time estimate.

window.ParkingFeature = (function () {
  'use strict';

  // The free public Overpass instance occasionally answers with 502/503/504
  // or just stalls under load — these are its own official mirrors (same
  // project, same data, different servers), tried in order so one slow or
  // overloaded server doesn't fail the whole lookup.
  const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
    'https://z.overpass-api.de/api/interpreter',
  ];
  const OVERPASS_ATTEMPT_TIMEOUT_MS = 15_000;
  const OVERPASS_OVERALL_TIMEOUT_MS = 50_000;

  // Configurable default used only for tier-3 (polygon-area) estimation —
  // see the capacity hierarchy in computeSupply() below.
  const PARKING_AREA_PER_SPACE_M2 = 27.5;
  const CACHE_MAX_ENTRIES = 200;

  const POINT_LAYER = 'parking-points-layer';
  const FILL_LAYER = 'parking-fill-layer';
  const OUTLINE_LAYER = 'parking-outline-layer';
  const SOURCE_ID = 'parking-source';

  /* ------------------------------------------------------------------ *
   * Geometry: polygon area (m²), point-in-polygon, and clipping a polygon to
   * the same circle `circlePolygon()` in app.js draws — so "area inside
   * radius" here and the on-map circle are always the same shape.
   *
   * Clipping uses Sutherland–Hodgman against the circle's 64-gon
   * approximation, which is convex, so the algorithm is exact for it. Ring
   * winding is normalised to counter-clockwise first, since OSM way node
   * order (and the clip ring) are not guaranteed to wind consistently.
   * Working directly in lon/lat degrees for the clip's line intersections and
   * for point-in-polygon is a safe local approximation at the <=10 km scale
   * these radii cover; the resulting ring is then projected to metres
   * (anchored at its own first vertex) before measuring area, which is where
   * accuracy actually matters.
   * ------------------------------------------------------------------ */

  function signedArea2(ring) {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      sum += x1 * y2 - x2 * y1;
    }
    return sum;
  }

  function ensureCCW(ring) {
    return signedArea2(ring) < 0 ? ring.slice().reverse() : ring;
  }

  function lineIntersection(p1, p2, a, b) {
    const A1 = b[1] - a[1];
    const B1 = a[0] - b[0];
    const C1 = A1 * a[0] + B1 * a[1];
    const A2 = p2[1] - p1[1];
    const B2 = p1[0] - p2[0];
    const C2 = A2 * p1[0] + B2 * p1[1];
    const det = A1 * B2 - A2 * B1;
    if (Math.abs(det) < 1e-15) return p2; // parallel/degenerate edge — keep the endpoint
    return [(B2 * C1 - B1 * C2) / det, (A1 * C2 - A2 * C1) / det];
  }

  /** Sutherland–Hodgman: clip `subject` (any simple polygon) against `clip` (convex, CCW). */
  function clipToConvex(subjectRing, convexClipRing) {
    let output = subjectRing;
    const n = convexClipRing.length;
    for (let i = 0; i < n && output.length > 0; i++) {
      const a = convexClipRing[i];
      const b = convexClipRing[(i + 1) % n];
      const inside = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
      const input = output;
      output = [];
      for (let j = 0; j < input.length; j++) {
        const current = input[j];
        const prev = input[(j - 1 + input.length) % input.length];
        const currentIn = inside(current);
        const prevIn = inside(prev);
        if (currentIn) {
          if (!prevIn) output.push(lineIntersection(prev, current, a, b));
          output.push(current);
        } else if (prevIn) {
          output.push(lineIntersection(prev, current, a, b));
        }
      }
    }
    return output;
  }

  /** Geodesic-ish area in m² of a [lon,lat] ring, via a local equirectangular projection. */
  function ringAreaM2(ring) {
    if (ring.length < 3) return 0;
    const [refLon, refLat] = ring[0];
    const metresPerDegLat = 111_320;
    const metresPerDegLon = 111_320 * Math.max(0.01, Math.cos((refLat * Math.PI) / 180));
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const [lon1, lat1] = ring[i];
      const [lon2, lat2] = ring[(i + 1) % ring.length];
      const x1 = (lon1 - refLon) * metresPerDegLon;
      const y1 = (lat1 - refLat) * metresPerDegLat;
      const x2 = (lon2 - refLon) * metresPerDegLon;
      const y2 = (lat2 - refLat) * metresPerDegLat;
      sum += x1 * y2 - x2 * y1;
    }
    return Math.abs(sum) / 2;
  }

  /** Area (m²) of `ring` that falls inside `circleRing` — both [lon,lat] rings. */
  function areaInsideCircleM2(ring, circleRing) {
    const clipped = clipToConvex(ensureCCW(ring), ensureCCW(circleRing));
    return ringAreaM2(clipped);
  }

  /** Even-odd ray-casting test — is [lon,lat] `point` inside `ring`? */
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

  /* ------------------------------------------------------------------ *
   * Tag reading
   * ------------------------------------------------------------------ */

  const PARKING_TYPE_LABELS = {
    surface: 'Surface Parking',
    multi_storey: 'Multi-storey Parking',
    'multi-storey': 'Multi-storey Parking',
    underground: 'Underground Parking',
    rooftop: 'Rooftop Parking',
    street_side: 'Street-side Parking',
    lane: 'Parking Lane',
    layby: 'Lay-by Parking',
    garage_boxes: 'Garage Boxes',
    sheds: 'Parking Sheds',
    carports: 'Carports',
  };

  function parkingTypeLabel(tags) {
    const raw = (tags.parking || '').trim().toLowerCase();
    return PARKING_TYPE_LABELS[raw] || 'Parking';
  }

  /** A `capacity` tag counts only if it parses as a finite, non-negative number. */
  function readValidCapacity(tags) {
    if (tags.capacity === undefined || tags.capacity === null) return null;
    const raw = String(tags.capacity).trim();
    if (raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }

  /* ------------------------------------------------------------------ *
   * Overpass query — every OSM parking-related feature type, node/way/
   * relation, unioned in one request so results de-duplicate at the source
   * for anything Overpass itself would otherwise return twice.
   * ------------------------------------------------------------------ */

  const PARKING_QUERY_TAGS = [
    ['amenity', 'parking'],
    ['amenity', 'parking_space'],
    ['amenity', 'parking_entrance'],
    ['building', 'parking'],
  ];

  function buildQuery(lat, lon, radiusMeters) {
    // `nwr[...]` is Overpass's own shorthand for "node, way AND relation with
    // this tag" — functionally identical to writing all three out by hand.
    const clauses = PARKING_QUERY_TAGS.map(
      ([key, value]) => `  nwr["${key}"="${value}"](around:${radiusMeters},${lat},${lon});`
    ).join('\n');
    return `[out:json][timeout:25];\n(\n${clauses}\n);\nout geom center;`;
  }

  function abortError() {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return err;
  }

  /**
   * One attempt against one Overpass mirror, bounded by its own short
   * timeout so a single stalled server can't eat the whole budget — and
   * still cancelled immediately if `outerSignal` aborts (pin/radius changed).
   */
  async function queryOverpassOnce(endpoint, query, outerSignal) {
    if (outerSignal.aborted) throw abortError();

    const attemptController = new AbortController();
    const onOuterAbort = () => attemptController.abort();
    outerSignal.addEventListener('abort', onOuterAbort);
    const timeoutId = setTimeout(() => attemptController.abort(), OVERPASS_ATTEMPT_TIMEOUT_MS);

    try {
      const body = 'data=' + encodeURIComponent(query);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: attemptController.signal,
      });
      if (!response.ok) {
        const err = new Error(`Overpass API returned HTTP ${response.status}`);
        err.status = response.status;
        throw err;
      }
      const json = await response.json();
      return Array.isArray(json.elements) ? json.elements : [];
    } finally {
      clearTimeout(timeoutId);
      outerSignal.removeEventListener('abort', onOuterAbort);
    }
  }

  /**
   * Tries each Overpass mirror in turn. A per-attempt timeout, a 5xx/429, or
   * a network error moves on to the next mirror; the outer `signal` aborting
   * (a newer pin/radius superseding this call) stops the whole thing at once.
   */
  async function queryOverpass(lat, lon, radiusMeters, signal) {
    const query = buildQuery(lat, lon, radiusMeters);
    if (typeof console !== 'undefined' && typeof console.debug === 'function') {
      console.debug('Parking Overpass query:', query);
    }
    let lastError = abortError();

    for (const endpoint of OVERPASS_ENDPOINTS) {
      if (signal.aborted) throw abortError();
      try {
        return await queryOverpassOnce(endpoint, query, signal);
      } catch (err) {
        if (signal.aborted) throw err; // real supersede — stop, don't try another mirror
        lastError = err;
      }
    }
    throw lastError;
  }

  /* ------------------------------------------------------------------ *
   * Element -> ring/center extraction
   * ------------------------------------------------------------------ */

  function geomToRing(geometry) {
    if (!Array.isArray(geometry) || geometry.length < 4) return null;
    const ring = geometry.map((p) => [p.lon, p.lat]);
    const first = ring[0];
    const last = ring[ring.length - 1];
    // A closed way repeats its first node as the last; an open way (or an
    // incomplete/degenerate one) has no defensible polygon, so it is treated
    // like a point below — its area is unknown, never guessed.
    if (first[0] !== last[0] || first[1] !== last[1]) return null;
    return ring;
  }

  /**
   * Best-effort ring for a `way` or `relation` element. Multipolygon
   * relations are approximated by their first "outer" member ring; inner
   * (hole) members are not subtracted. This under-counts holes (rare for
   * parking areas) rather than over-counting area, which stays on the safe
   * side of "do not fabricate capacity".
   */
  function elementToRing(element) {
    if (element.type === 'way') {
      return geomToRing(element.geometry);
    }
    if (element.type === 'relation' && Array.isArray(element.members)) {
      const outer = element.members.find((m) => m.role === 'outer' && Array.isArray(m.geometry));
      if (outer) return geomToRing(outer.geometry);
      const anyWay = element.members.find((m) => Array.isArray(m.geometry));
      if (anyWay) return geomToRing(anyWay.geometry);
    }
    return null;
  }

  function averageLonLat(points) {
    if (!points || points.length === 0) return null;
    let sx = 0;
    let sy = 0;
    for (const p of points) {
      sx += Array.isArray(p) ? p[0] : p.lon;
      sy += Array.isArray(p) ? p[1] : p.lat;
    }
    return [sx / points.length, sy / points.length];
  }

  function elementCenter(element, ring) {
    if (element.type === 'node') return [element.lon, element.lat];
    // Prefer the closed ring's own centroid; fall back to the raw node list
    // (covers an open way, which has no ring but still has geometry), then to
    // Overpass's own `center` field (requested via `out ... center;`), and
    // finally to the element's bounding box if even that is missing.
    return (
      averageLonLat(ring) ||
      averageLonLat(element.geometry) ||
      (element.center ? [element.center.lon, element.center.lat] : null) ||
      (element.bounds
        ? [
            (element.bounds.minlon + element.bounds.maxlon) / 2,
            (element.bounds.minlat + element.bounds.maxlat) / 2,
          ]
        : null)
    );
  }

  /* ------------------------------------------------------------------ *
   * Classification — one OSM object gets exactly one category, so an object
   * carrying both amenity=parking and building=parking is one facility, not
   * two, and a parking_entrance is never miscounted as a facility or space.
   * ------------------------------------------------------------------ */

  function classify(tags) {
    // Priority order matters: an entrance tag always wins (rule: "parking_
    // entrance must never be counted as a parking facility or parking
    // space"), then an individually-mapped space, then a facility — where
    // amenity=parking and building=parking on the SAME object still resolve
    // to a single category, never two.
    if (tags.amenity === 'parking_entrance') return 'entrance';
    if (tags.amenity === 'parking_space') return 'space';
    if (tags.amenity === 'parking' || tags.building === 'parking') return 'facility';
    return null; // defensive — the query should never return anything else
  }

  /* ------------------------------------------------------------------ *
   * Aggregate computation
   * ------------------------------------------------------------------ */

  /**
   * Turns raw Overpass elements into the headline numbers plus a per-feature
   * GeoJSON collection for the optional map layer.
   *
   * `circleRing` is the exact [lon,lat] ring the population feature's own
   * `circlePolygon()` produced for this pin+radius — passed in rather than
   * rebuilt here, so both features agree pixel-for-pixel on what the circle is.
   */
  function computeSupply(elements, circleRing) {
    const seen = new Set(); // "type/id" — the one global de-duplication key
    let duplicateObjectsRemoved = 0;

    // Pass 1: dedupe, classify, and extract geometry for every element.
    const records = [];
    let amenityParkingCount = 0;
    let amenityParkingSpaceCount = 0;
    let amenityParkingEntranceCount = 0;
    let buildingParkingCount = 0;

    for (const element of elements) {
      const key = `${element.type}/${element.id}`;
      if (seen.has(key)) {
        duplicateObjectsRemoved++;
        continue;
      }
      seen.add(key);

      const tags = element.tags || {};
      const category = classify(tags);
      if (!category) continue;

      if (tags.amenity === 'parking') amenityParkingCount++;
      if (tags.amenity === 'parking_space') amenityParkingSpaceCount++;
      if (tags.amenity === 'parking_entrance') amenityParkingEntranceCount++;
      if (tags.building === 'parking') buildingParkingCount++;

      const ring = element.type === 'node' ? null : elementToRing(element);
      const center = elementCenter(element, ring);
      if (!center) continue; // no usable geometry at all — cannot place or count it

      records.push({
        key,
        category,
        tags,
        ring,
        center,
        isStructure: tags.building === 'parking',
      });
    }

    const facilities = records.filter((r) => r.category === 'facility');
    const spaces = records.filter((r) => r.category === 'space');
    const entrances = records.filter((r) => r.category === 'entrance');

    // Pass 2: for each facility polygon, find individually-mapped spaces that
    // physically fall inside it — those feed the capacity hierarchy's tier 2
    // instead of the facility's own tag data. Each space is credited to at
    // most one (the first) containing facility, so it is never double-counted
    // across overlapping polygons.
    const claimedSpaceKeys = new Set();
    const containedSpacesByFacility = new Map(); // facility key -> space records[]
    for (const facility of facilities) {
      if (!facility.ring) continue;
      const contained = [];
      for (const space of spaces) {
        if (claimedSpaceKeys.has(space.key)) continue;
        if (pointInRing(space.center, facility.ring)) {
          contained.push(space);
          claimedSpaceKeys.add(space.key);
        }
      }
      if (contained.length > 0) containedSpacesByFacility.set(facility.key, contained);
    }

    // Capacity hierarchy per facility: 1) explicit capacity, 2) individually
    // mapped spaces contained in this polygon, 3) polygon-area estimate,
    // 4) unknown. Never more than one tier contributes per facility, so an
    // area estimate is never added on top of a polygon's own reported
    // capacity or its already-counted mapped spaces.
    const features = [];
    let facilitiesWithExplicitCapacity = 0;
    let facilitiesWithMappedSpaceCount = 0;
    let facilitiesWithPolygonGeometry = 0;
    let estimatedFromAreaFacilities = 0;
    let unknownCapacityFacilities = 0;
    let knownSpaces = 0;
    let estimatedSpaces = 0;

    for (const facility of facilities) {
      if (facility.ring) facilitiesWithPolygonGeometry++;

      const validCapacity = readValidCapacity(facility.tags);
      const containedSpaces = containedSpacesByFacility.get(facility.key) || [];
      let capacitySource;
      let capacity = null;
      let areaInsideRadiusM2 = null;

      if (validCapacity !== null) {
        capacitySource = 'reported';
        capacity = validCapacity;
        facilitiesWithExplicitCapacity++;
        knownSpaces += validCapacity;
      } else if (containedSpaces.length > 0) {
        capacitySource = 'mapped-spaces';
        // A mapped space normally represents one physical space, unless it
        // was itself tagged with its own capacity > 1 (e.g. a small
        // multi-space area mapped as a single object).
        capacity = containedSpaces.reduce((sum, space) => {
          const spaceCapacity = readValidCapacity(space.tags);
          return sum + (spaceCapacity !== null && spaceCapacity > 1 ? spaceCapacity : 1);
        }, 0);
        facilitiesWithMappedSpaceCount++;
        knownSpaces += capacity;
      } else if (facility.ring) {
        areaInsideRadiusM2 = areaInsideCircleM2(facility.ring, circleRing);
        capacity = Math.round(areaInsideRadiusM2 / PARKING_AREA_PER_SPACE_M2);
        capacitySource = 'estimated';
        estimatedFromAreaFacilities++;
        estimatedSpaces += capacity;
      } else {
        capacitySource = 'unknown';
        unknownCapacityFacilities++;
      }
      // Point facilities with neither a reported capacity nor a polygon are
      // "unknown" — never estimated, since their area cannot be measured.

      features.push({
        type: 'Feature',
        geometry: facility.ring
          ? { type: 'Polygon', coordinates: [facility.ring] }
          : { type: 'Point', coordinates: facility.center },
        properties: {
          id: facility.key,
          category: facility.isStructure ? 'structure' : 'facility',
          name: facility.tags.name || null,
          parkingType: parkingTypeLabel(facility.tags),
          access: facility.tags.access || null,
          fee: facility.tags.fee || null,
          surface: facility.tags.surface || null,
          operator: facility.tags.operator || null,
          capacity,
          capacitySource,
          mappedSpaceCount: capacitySource === 'mapped-spaces' ? containedSpaces.length : null,
          areaInsideRadiusM2: areaInsideRadiusM2 !== null ? Math.round(areaInsideRadiusM2) : null,
        },
      });
    }

    // Individually mapped spaces and entrances get their own, much simpler
    // map features — they are never facilities and never get an area
    // estimate (spec: never estimate from a space or an entrance).
    for (const space of spaces) {
      const validCapacity = readValidCapacity(space.tags);
      features.push({
        type: 'Feature',
        geometry: space.ring
          ? { type: 'Polygon', coordinates: [space.ring] }
          : { type: 'Point', coordinates: space.center },
        properties: {
          id: space.key,
          category: 'space',
          name: space.tags.name || null,
          capacity: validCapacity !== null && validCapacity > 1 ? validCapacity : 1,
          claimedByFacility: claimedSpaceKeys.has(space.key),
        },
      });
    }
    for (const entrance of entrances) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: entrance.center },
        properties: {
          id: entrance.key,
          category: 'entrance',
          name: entrance.tags.name || null,
          access: entrance.tags.access || null,
        },
      });
    }

    const mappedParkingFacilities = facilities.length;
    const mappedIndividualParkingSpaces = spaces.length;
    const mappedParkingEntrances = entrances.length;
    const mappedParkingStructures = facilities.filter((f) => f.isStructure).length;

    // A raw sum can legitimately be 0 (every facility already had real known
    // data, so nothing was left to estimate) — that is a different fact from
    // "we have no real data at all" for this circle. Conflating the two would
    // silently present an unconfirmed void as a confirmed zero, so: only once
    // at least one facility has EITHER an explicit capacity OR a contained
    // mapped-space count do the derived figures become real numbers.
    // Otherwise every one of them is `null` ("unknown"), never a fabricated 0.
    const facilitiesWithKnownData = facilitiesWithExplicitCapacity + facilitiesWithMappedSpaceCount;
    const hasAnyKnownData = facilitiesWithKnownData > 0;
    const knownParkingSpaces = hasAnyKnownData ? knownSpaces : null;
    const estimatedParkingSpaces = hasAnyKnownData ? estimatedSpaces : null;
    const totalParkingSupply = hasAnyKnownData ? knownSpaces + estimatedSpaces : null;

    const capacityCoveragePercent =
      mappedParkingFacilities > 0 ? (facilitiesWithKnownData / mappedParkingFacilities) * 100 : null;

    const parkingSupplyStatus =
      mappedParkingFacilities === 0
        ? 'none'
        : !hasAnyKnownData
          ? 'unknown'
          : facilitiesWithKnownData < mappedParkingFacilities
            ? 'partial'
            : 'complete';

    if (typeof console !== 'undefined' && typeof console.debug === 'function') {
      console.debug('Parking Query Debug:', {
        totalOsmElementsReturned: elements.length,
        uniqueOsmElements: elements.length - duplicateObjectsRemoved,
        'amenity=parking': amenityParkingCount,
        'amenity=parking_space': amenityParkingSpaceCount,
        'amenity=parking_entrance': amenityParkingEntranceCount,
        'building=parking': buildingParkingCount,
        facilitiesWithExplicitCapacity,
        facilitiesWithPolygonGeometry,
        individualMappedSpaces: mappedIndividualParkingSpaces,
        duplicateObjectsRemoved,
        estimatedFromAreaFacilities,
        unknownCapacityFacilities,
      });
    }

    return {
      mappedParkingFacilities,
      mappedIndividualParkingSpaces,
      mappedParkingEntrances,
      mappedParkingStructures,
      facilitiesWithCapacity: facilitiesWithKnownData,
      facilitiesWithoutCapacity: mappedParkingFacilities - facilitiesWithKnownData,
      knownParkingSpaces,
      estimatedParkingSpaces,
      totalParkingSupply,
      capacityCoveragePercent,
      parkingSupplyStatus,
      geojson: { type: 'FeatureCollection', features },
    };
  }

  /* ------------------------------------------------------------------ *
   * Cache + abort-on-supersede, mirroring PopulationRaster's own pattern
   * ------------------------------------------------------------------ */

  const cache = new Map(); // "lat,lon,radius" -> raw Overpass elements[]
  let activeController = null;
  let latestToken = 0;

  function cacheKey(lat, lon, radiusMeters) {
    return `${lat.toFixed(5)},${lon.toFixed(5)},${Math.round(radiusMeters)}`;
  }

  function remember(key, elements) {
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, elements);
  }

  /**
   * The single entry point app.js calls whenever the pin or radius changes.
   * Any call in flight is aborted (both the network request and the result)
   * the moment a newer call starts, so a slow Overpass response can never
   * overwrite a more recent pin/radius with stale numbers.
   */
  function recalculate(lat, lon, radiusMeters, circleRing, callbacks) {
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const myToken = ++latestToken;

    callbacks.onLoading();

    const key = cacheKey(lat, lon, radiusMeters);
    const cached = cache.get(key);
    const source = cached
      ? Promise.resolve(cached)
      : (() => {
          // A last-resort cap in case something outside queryOverpass's own
          // per-mirror timeouts hangs — normally each mirror times out (and
          // falls through to the next one) well before this fires.
          const timeoutId = setTimeout(() => controller.abort(), OVERPASS_OVERALL_TIMEOUT_MS);
          return queryOverpass(lat, lon, radiusMeters, controller.signal)
            .then((elements) => {
              clearTimeout(timeoutId);
              remember(key, elements);
              return elements;
            })
            .catch((err) => {
              clearTimeout(timeoutId);
              throw err;
            });
        })();

    source
      .then((elements) => {
        if (myToken !== latestToken) return; // superseded by a newer pin/radius
        const summary = computeSupply(elements, circleRing);
        updateLayer(summary.geojson);
        callbacks.onResult(summary);
      })
      .catch((err) => {
        // `myToken !== latestToken` is the only real "this call is stale"
        // signal. Checking `controller.signal.aborted` here too would also
        // swallow a genuine timeout of *this* still-current call (its own
        // abort sets that same flag), leaving the panel stuck on "loading"
        // forever instead of showing an error.
        if (myToken !== latestToken) return;
        const message =
          err instanceof Error && err.name === 'AbortError'
            ? 'The parking data request timed out after trying multiple servers. Try again in a moment.'
            : err instanceof Error
              ? err.message
              : String(err);
        callbacks.onError(message);
      });
  }

  function clear() {
    activeController?.abort();
    ++latestToken; // orphan any in-flight result
    updateLayer({ type: 'FeatureCollection', features: [] });
  }

  /* ------------------------------------------------------------------ *
   * Map layer (optional — toggled independently of the calculation above)
   *
   * One shared GeoJSON source; category-based paint expressions give
   * facilities, structures, individually mapped spaces and entrances each
   * their own colour without needing four separate layers per geometry type.
   * ------------------------------------------------------------------ */

  const CATEGORY_COLOR = [
    'match',
    ['get', 'category'],
    'structure',
    '#1d4ed8', // building=parking — blue
    'space',
    '#b45309', // amenity=parking_space — amber
    'entrance',
    '#dc2626', // amenity=parking_entrance — red
    /* facility (default) */ '#0f766e', // teal, same as the feature's original colour
  ];

  let mapRef = null;
  let layerVisible = false;

  function init(map) {
    mapRef = map;
    map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    map.addLayer({
      id: FILL_LAYER,
      type: 'fill',
      source: SOURCE_ID,
      filter: ['==', ['geometry-type'], 'Polygon'],
      layout: { visibility: 'none' },
      paint: { 'fill-color': CATEGORY_COLOR, 'fill-opacity': 0.35 },
    });
    map.addLayer({
      id: OUTLINE_LAYER,
      type: 'line',
      source: SOURCE_ID,
      filter: ['==', ['geometry-type'], 'Polygon'],
      layout: { visibility: 'none' },
      paint: { 'line-color': CATEGORY_COLOR, 'line-width': 1.5 },
    });
    map.addLayer({
      id: POINT_LAYER,
      type: 'circle',
      source: SOURCE_ID,
      filter: ['==', ['geometry-type'], 'Point'],
      layout: { visibility: 'none' },
      paint: {
        'circle-radius': ['match', ['get', 'category'], 'space', 3, 'entrance', 3, 5],
        'circle-color': CATEGORY_COLOR,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
      },
    });
  }

  function updateLayer(geojson) {
    const source = mapRef && mapRef.getSource(SOURCE_ID);
    if (source) source.setData(geojson);
  }

  function setLayerVisible(visible) {
    layerVisible = visible;
    if (!mapRef) return;
    const visibility = visible ? 'visible' : 'none';
    for (const id of [FILL_LAYER, OUTLINE_LAYER, POINT_LAYER]) {
      mapRef.setLayoutProperty(id, 'visibility', visibility);
    }
  }

  function isLayerVisible() {
    return layerVisible;
  }

  /** Hit-test a click against the parking layers; returns the feature or null. */
  function queryClick(point) {
    if (!mapRef || !layerVisible) return null;
    const hits = mapRef.queryRenderedFeatures(point, { layers: [POINT_LAYER, FILL_LAYER] });
    return hits.length > 0 ? hits[0] : null;
  }

  // Set by window.FoursquareSource after it cross-matches OSM facilities
  // against Foursquare places — a small, additive annotation so a facility's
  // popup can say "also seen in Foursquare" without parking.js needing to
  // know anything about that other source's data shape.
  let osmIdsMatchedInOtherSources = new Set();

  function setForeignSourceMatches(osmIds) {
    osmIdsMatchedInOtherSources = osmIds;
  }

  const NUMBER_FORMAT = new Intl.NumberFormat('en-US');
  function formatNumber(n) {
    return NUMBER_FORMAT.format(Math.round(n));
  }

  function row(label, value) {
    return `<div class="parking-popup__row"><span>${label}</span><strong>${value}</strong></div>`;
  }

  /** Popup content for a facility or structure (polygon or point). */
  function facilityPopupHtml(p) {
    const name = p.name ? escapeHtml(p.name) : '(unnamed)';
    const rows = [];

    if (p.capacitySource === 'reported') {
      rows.push(row('Name', name));
      rows.push(row('Type', escapeHtml(p.parkingType)));
      rows.push(row('Capacity', `${formatNumber(p.capacity)} spaces`));
      rows.push(row('Source', 'OpenStreetMap'));
      rows.push(row('Capacity source', 'Reported'));
    } else if (p.capacitySource === 'mapped-spaces') {
      rows.push(row('Name', name));
      rows.push(row('Type', escapeHtml(p.parkingType)));
      rows.push(row('Capacity', `${formatNumber(p.capacity)} spaces`));
      rows.push(row('Source', 'OpenStreetMap'));
      rows.push(row('Capacity source', `${formatNumber(p.mappedSpaceCount)} individually mapped spaces`));
    } else if (p.capacitySource === 'estimated') {
      rows.push(row('Area inside radius', `${formatNumber(p.areaInsideRadiusM2)} m²`));
      rows.push(row('Estimated capacity', `~${formatNumber(p.capacity)} spaces`));
      rows.push(
        row(
          'Calculation',
          `<span dir="ltr">${formatNumber(p.areaInsideRadiusM2)} ÷ ${PARKING_AREA_PER_SPACE_M2} m²</span>`
        )
      );
      rows.push(row('Source', 'OpenStreetMap'));
    } else {
      rows.push(row('Name', name));
      rows.push(row('Type', escapeHtml(p.parkingType)));
      rows.push(row('Capacity', 'Not reported'));
      rows.push(row('Source', 'OpenStreetMap'));
    }

    if (p.operator) rows.push(row('Operator', escapeHtml(p.operator)));
    if (p.access) rows.push(row('Access', escapeHtml(p.access)));
    if (p.fee) rows.push(row('Fee', escapeHtml(p.fee)));
    if (p.surface) rows.push(row('Surface', escapeHtml(p.surface)));
    if (osmIdsMatchedInOtherSources.has(p.id)) {
      rows.push(row('Sources', '✓ OpenStreetMap &nbsp; ✓ Foursquare'));
    }

    const title = p.category === 'structure' ? 'Parking Structure' : 'Parking Facility';
    return `<div class="parking-popup"><div class="parking-popup__title">${title}</div>${rows.join('')}</div>`;
  }

  function spacePopupHtml(p) {
    const rows = [
      row('Capacity', `${formatNumber(p.capacity)} space${p.capacity === 1 ? '' : 's'}`),
      row('Source', 'OpenStreetMap'),
    ];
    if (p.claimedByFacility) {
      rows.push(row('Note', 'Counted within a nearby parking facility’s known spaces'));
    }
    return `<div class="parking-popup"><div class="parking-popup__title">Individually Mapped Parking Space</div>${rows.join('')}</div>`;
  }

  function entrancePopupHtml(p) {
    const rows = [];
    if (p.name) rows.push(row('Name', escapeHtml(p.name)));
    if (p.access) rows.push(row('Access', escapeHtml(p.access)));
    rows.push(row('Source', 'OpenStreetMap'));
    return `<div class="parking-popup"><div class="parking-popup__title">Parking Entrance</div>${rows.join('')}</div>`;
  }

  /** Routes a clicked feature to the right popup template for its category. */
  function popupHtml(feature) {
    const p = feature.properties;
    if (p.category === 'space') return spacePopupHtml(p);
    if (p.category === 'entrance') return entrancePopupHtml(p);
    return facilityPopupHtml(p);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return {
    init,
    recalculate,
    clear,
    setLayerVisible,
    isLayerVisible,
    queryClick,
    popupHtml,
    setForeignSourceMatches,
    PARKING_AREA_PER_SPACE_M2,
  };
})();
