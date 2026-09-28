// Netlify serverless function — the ONLY thing on this site allowed to call
// the Overpass API. Browsers cannot reliably call overpass-api.de directly
// from a third-party origin: the service's edge sometimes rejects
// cross-origin browser fetches with 406 Not Acceptable and no CORS headers,
// which shows up in devtools as a "blocked by CORS policy" error even though
// the real cause is server-side. Running the request from here (server to
// server, no browser, no Origin-based rejection) sidesteps that entirely.
//
// The frontend (js/parking.js) POSTs { query } to this function's path
// (/.netlify/functions/overpass) and gets back the raw Overpass `elements`
// JSON — same shape it always read directly from Overpass, so parking.js's
// own classification/dedup/capacity logic needs no changes at all.

const OVERPASS_ENDPOINTS = [
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// Netlify's synchronous function limit is a hard 60s ceiling, so three
// sequential attempts at 18s each (54s worst case) leaves headroom for
// network/JSON overhead instead of risking Netlify killing the function
// mid-request.
const ENDPOINT_TIMEOUT_MS = 18_000;

// Overpass's own fair-use policy asks clients to identify themselves with a
// descriptive User-Agent rather than a generic HTTP-library default — a
// header browsers refuse to let client-side JS set, which is one more reason
// this call has to happen server-side.
const USER_AGENT = 'IIACSS-QC-Map/1.0 (+https://iraq-map-data.netlify.app)';

const isDev = process.env.CONTEXT !== 'production';

function log(...args) {
  if (isDev) console.log('[overpass proxy]', ...args);
}

function endpointLabel(endpoint) {
  return new URL(endpoint).hostname;
}

function logAttempt(attemptNumber, endpoint, status, durationMs, fallbackTriggered) {
  log(
    `Overpass attempt ${attemptNumber}:\n` +
      `endpoint: ${endpointLabel(endpoint)}\n` +
      `status: ${status}\n` +
      `duration: ${durationMs}ms\n` +
      `fallback triggered: ${fallbackTriggered}`
  );
}

async function queryEndpoint(endpoint, query) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ENDPOINT_TIMEOUT_MS);
  try {
    const body = new URLSearchParams();
    body.set('data', query);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: body.toString(),
      signal: controller.signal,
    });

    if (!response.ok) {
      const err = new Error(`Overpass endpoint returned HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Overpass endpoint returned a non-JSON response');
    }
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

  let query;
  try {
    const parsed = JSON.parse(event.body || '{}');
    query = parsed.query;
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  if (typeof query !== 'string' || query.trim() === '') {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: '"query" must be a non-empty string' }),
    };
  }

  log(`request received, query length=${query.length}`);

  const attempts = [];
  for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
    const endpoint = OVERPASS_ENDPOINTS[i];
    const attemptNumber = i + 1;
    const fallbackTriggered = i > 0;
    const startedAt = Date.now();
    try {
      const json = await queryEndpoint(endpoint, query);
      logAttempt(attemptNumber, endpoint, 200, Date.now() - startedAt, fallbackTriggered);
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify(json),
      };
    } catch (err) {
      const status = err.name === 'AbortError' ? 'timeout' : err.status || err.message;
      logAttempt(attemptNumber, endpoint, status, Date.now() - startedAt, fallbackTriggered);
      attempts.push({ endpoint: endpointLabel(endpoint), reason: String(status) });
    }
  }

  return {
    statusCode: 502,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({ error: 'OSM parking service temporarily unavailable', details: attempts }),
  };
};
