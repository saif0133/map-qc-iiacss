// Netlify serverless function — the ONLY thing on this site allowed to query
// OSM parking data. Runs server-side against Geofabrik's Postpass API
// (PostgreSQL/PostGIS over an OpenStreetMap snapshot) rather than the
// classic Overpass API, whose public mirrors (overpass-api.de and its
// aliases, Kumi Systems, private.coffee, mail.ru) were all intermittently
// down, timing out, or 406-rejecting requests. Postpass is the QUERY
// service; OpenStreetMap remains the actual data source (see the
// attribution note in README.md) — do not label this "Geofabrik parking
// data" anywhere in the UI.
//
// The frontend (js/parking.js) POSTs only { lat, lng, radiusMeters } — never
// raw SQL — and this function builds a validated, parameterized query
// itself, so this endpoint can never become an open SQL proxy. The response
// is adapted back into the same `elements` shape parking.js always expected
// from Overpass, so nothing downstream (classification, dedup, capacity
// hierarchy, map rendering) needed to change.

const POSTPASS_ENDPOINT = 'https://postpass.geofabrik.de/api/interpreter';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RADIUS_METERS = 60_000;
const USER_AGENT = 'IIACSS-QC-Map/1.0 (+https://iraq-map-data.netlify.app)';

const isDev = process.env.CONTEXT !== 'production';
function log(...args) {
  if (isDev) console.log('[postpass proxy]', ...args);
}

/* ------------------------------------------------------------------ *
 * Input validation — the only things the browser is trusted to send.
 * ------------------------------------------------------------------ */

function validateInput(body) {
  const { lat, lng, radiusMeters } = body || {};
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return 'lat must be a finite number between -90 and 90';
  }
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return 'lng must be a finite number between -180 and 180';
  }
  if (
    typeof radiusMeters !== 'number' ||
    !Number.isFinite(radiusMeters) ||
    radiusMeters <= 0 ||
    radiusMeters > MAX_RADIUS_METERS
  ) {
    return `radiusMeters must be a finite number between 0 and ${MAX_RADIUS_METERS}`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * SQL construction — same parking concepts, tags, and radius semantics as
 * the previous Overpass query (amenity=parking/parking_space/
 * parking_entrance, building=parking; a true metre-based great-circle
 * radius via geography casts, never drive-time).
 * ------------------------------------------------------------------ */

function boundingBox(lat, lng, radiusMeters) {
  const metresPerDegLat = 111_320;
  const metresPerDegLon = 111_320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const latPad = radiusMeters / metresPerDegLat;
  const lonPad = radiusMeters / metresPerDegLon;
  return {
    west: lng - lonPad,
    south: lat - latPad,
    east: lng + lonPad,
    north: lat + latPad,
  };
}

function buildSql(lat, lng, radiusMeters) {
  const { west, south, east, north } = boundingBox(lat, lng, radiusMeters);
  // lat/lng/radiusMeters are already validated finite numbers (never raw
  // strings from the request), and west/south/east/north are derived from
  // them by plain arithmetic — nothing below is string-interpolated
  // free-form input, so this hand-built query can't become an injection
  // vector despite not using a prepared-statement API.
  return (
    'SELECT osm_id, osm_type, tags, geom FROM postpass_pointlinepolygon WHERE ' +
    `geom && ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326) AND ` +
    "(tags->>'amenity' = 'parking' OR tags->>'amenity' = 'parking_space' OR " +
    "tags->>'amenity' = 'parking_entrance' OR tags->>'building' = 'parking') AND " +
    `ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radiusMeters})`
  );
}

/* ------------------------------------------------------------------ *
 * Adapter: Postpass GeoJSON -> the Overpass `elements` shape parking.js's
 * computeSupply() already classifies/dedupes/estimates capacity from.
 * ------------------------------------------------------------------ */

const OSM_TYPE_MAP = { N: 'node', W: 'way', R: 'relation' };

/** First polygon's outer ring, as Overpass's own `[{lon,lat}, ...]` shape. */
function ringFromPolygonCoordinates(polygonCoordinates) {
  return polygonCoordinates[0].map(([lon, lat]) => ({ lon, lat }));
}

/**
 * One Postpass feature -> one Overpass-shaped element. Postpass already
 * assembles ways and multipolygon relations into proper (Multi)Polygon
 * GeoJSON, so — unlike the old Overpass path — no manual ring-closing or
 * "find the outer member" logic is needed here; only the first polygon of a
 * MultiPolygon is kept, matching the same "first outer ring only"
 * simplification the previous Overpass-based adapter already relied on.
 */
function adaptFeature(feature) {
  const { osm_id: id, osm_type, tags } = feature.properties;
  const type = OSM_TYPE_MAP[osm_type];
  if (!type) return null; // unrecognised osm_type — skip rather than guess

  const geometry = feature.geometry;

  if (type === 'node') {
    if (geometry.type !== 'Point') return null;
    const [lon, lat] = geometry.coordinates;
    return { type, id, tags, lat, lon };
  }

  if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
    const polygon = geometry.type === 'MultiPolygon' ? geometry.coordinates[0] : geometry.coordinates;
    const ring = ringFromPolygonCoordinates(polygon);
    if (type === 'way') return { type, id, tags, geometry: ring };
    return { type, id, tags, members: [{ role: 'outer', geometry: ring }] };
  }

  if (geometry.type === 'LineString') {
    // An open way — no valid ring, so no polygon/area can be derived from it
    // (never estimate capacity from an invalid line). Kept only as raw
    // geometry so a center point can still be averaged from it.
    const points = geometry.coordinates.map(([lon, lat]) => ({ lon, lat }));
    if (type === 'way') return { type, id, tags, geometry: points };
    return { type, id, tags, members: [{ role: 'outer', geometry: points }] };
  }

  return null;
}

function adaptFeatureCollection(featureCollection) {
  const features = Array.isArray(featureCollection.features) ? featureCollection.features : [];
  const elements = [];
  for (const feature of features) {
    const adapted = adaptFeature(feature);
    if (adapted) elements.push(adapted);
  }
  return elements;
}

/* ------------------------------------------------------------------ *
 * Postpass request
 * ------------------------------------------------------------------ */

async function queryPostpass(sql, context) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const body = new URLSearchParams();
    body.set('data', sql);
    const response = await fetch(POSTPASS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: body.toString(),
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      log(
        `Postpass request:\n` +
          `endpoint: ${POSTPASS_ENDPOINT}\n` +
          `selected lat: ${context.lat}\n` +
          `selected lng: ${context.lng}\n` +
          `radius: ${context.radiusMeters}\n` +
          `SQL query length: ${sql.length}\n` +
          `upstream HTTP status: ${response.status}\n` +
          `duration: ${durationMs}ms\n` +
          `upstream error preview: ${text.slice(0, 300)}`
      );
      const err = new Error('Postpass upstream error');
      err.status = response.status;
      throw err;
    }

    const json = await response.json();
    log(
      `Postpass request:\n` +
        `endpoint: ${POSTPASS_ENDPOINT}\n` +
        `selected lat: ${context.lat}\n` +
        `selected lng: ${context.lng}\n` +
        `radius: ${context.radiusMeters}\n` +
        `SQL query length: ${sql.length}\n` +
        `upstream HTTP status: 200\n` +
        `duration: ${durationMs}ms\n` +
        `features returned: ${Array.isArray(json.features) ? json.features.length : 0}`
    );
    return json;
  } finally {
    clearTimeout(timeoutId);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json', Allow: 'POST' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const validationError = validateInput(body);
  if (validationError) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: validationError }),
    };
  }

  const { lat, lng, radiusMeters } = body;
  const sql = buildSql(lat, lng, radiusMeters);

  try {
    const featureCollection = await queryPostpass(sql, { lat, lng, radiusMeters });
    const elements = adaptFeatureCollection(featureCollection);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ elements }),
    };
  } catch (err) {
    const status = err.name === 'AbortError' ? 'timeout' : err.status || 500;
    return {
      statusCode: 502,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        error: 'OSM parking service temporarily unavailable',
        upstream: 'postpass.geofabrik.de',
        status,
      }),
    };
  }
};
