# Population Estimator — static build

A fully static, standalone copy of the "Estimate Population" feature from the
Iraq Location Resolver app (`iraq-location-resolver/`), plus a **Parking
Supply by Distance** feature built on top of it. No backend, no build
step — drag-and-drop the whole `population-raster-static/` folder onto
Netlify (or open `index.html` directly in a browser) and it works.

## Parking Supply by Distance

`js/parking.js` adds a second, independent calculation over the *same* pin
and radius the population feature already tracks (see `state.point` /
`state.radiusMeters` in `js/app.js`, and `recalculateParking()` which fires
right alongside the population calculation on every click and radius change).
It never introduces a second notion of "where" or "how far" — it is handed
the population feature's own circle ring (from the same `circlePolygon()`
function) so the two features always agree on the circle's shape.

Data is OpenStreetMap parking features (`amenity=parking`, `amenity=
parking_space`, `amenity=parking_entrance`, `building=parking`; nodes, ways
and relations), queried through this site's own Netlify function
(`netlify/functions/overpass.js`) rather than called directly from the
browser — see "Postpass proxy" below. A true metre-based great-circle radius
test is done server-side (never drive-time). For each mapped facility: a
valid numeric `capacity` tag is used directly; otherwise, for a polygon, the
area that falls **inside the selected circle** is computed (via a
Sutherland–Hodgman clip against the same circle ring) and divided by
27.5 m²/space; a point with no reported capacity is counted but never
assigned a fabricated one. Results are cached per (lat, lng, radius) and
in-flight requests are aborted the moment a newer pin/radius supersedes
them, exactly mirroring `PopulationRaster`'s own cache/abort pattern.

An optional **Parking** layer (checkbox above the map) shows the same
computed features on the map; clicking one opens a popup with its reported or
estimated capacity. All of this is independently unit-tested (clipping/area
math and capacity-tag validation) and was verified end-to-end against live
data for central Baghdad.

### Postpass proxy

OSM parking data is queried through [Geofabrik's Postpass
API](https://postpass.geofabrik.de/) (PostgreSQL/PostGIS over an OSM
snapshot) rather than the classic Overpass API, whose public mirrors
(`overpass-api.de` and its aliases, Kumi Systems, private.coffee, mail.ru)
turned out to be unreliable in practice — intermittently down, timing out, or
rejecting cross-origin browser requests with `406 Not Acceptable` and no CORS
header (which shows up in devtools as a "blocked by CORS policy" error even
though the real cause is server-side). OpenStreetMap is still the actual data
source; Postpass is only the query service.

`js/parking.js` never talks to Postpass, or to any OSM query service,
directly — it POSTs only `{ lat, lng, radiusMeters }` to this site's own
same-origin `netlify/functions/overpass.js`, which validates those three
numbers, builds a parameterized SQL query itself (so this endpoint can never
become an open SQL proxy), queries Postpass server-to-server, and adapts its
GeoJSON response back into the same Overpass-shaped `elements` array the
frontend always expected — so classification, deduplication, and the
capacity hierarchy below needed no changes at all. If Postpass fails, the
function returns a clean `502` with `{ error, upstream, status }` instead of
an HTML error page, and the frontend shows "Unavailable" on OSM's own figures
without touching the Google Maps row or population calculation.

## How it differs from the main app's feature

The main app computes the population sum **on its Node.js backend**
(`backend/src/gis/populationRaster.ts`), reading a pixel window out of the
GeoTIFF with `geotiff`'s `fromFile`. This static build ports that exact same
windowing/summing logic into the browser (`js/app.js`), using `geotiff`'s
`fromUrl` instead: it reads the same small pixel window straight out of
`assets/irq_pop_2026_CN_100m_R2025A_v1.tif` over HTTP **range requests** — the
27 MB raster is never downloaded in full for a single click. Any static host
that serves byte-range requests for static files works; Netlify does this by
default.

## Files

```
index.html              the page (map, radius selector, side panels)
css/style.css            styling, adapted from the main app's app.css
css/maplibre-gl.css      vendored MapLibre GL JS stylesheet
js/app.js                map + click handling + client-side population calc
js/parking.js            Parking Supply: OSM classification + area/capacity calc + map layer
js/maplibre-gl.js        vendored MapLibre GL JS v4.7.1 (classic UMD bundle)
js/geotiff.js            vendored geotiff.js browser bundle (reads the raster)
images/favicon.svg       tab icon
assets/*.tif             the population raster this page reads
```

Everything is vendored locally and loaded as plain, classic (non-module)
`<script>` tags — no bundler, no CDN dependency, no `import`/`export`. The
main app's own frontend uses MapLibre GL JS v6, which dropped its classic
global build in favour of an ES module + a separate worker file resolved via
`import.meta.url`; that combination is fragile to self-host without a bundler
and (being an ES module import) fails outright when this page is opened via
`file://` instead of `http(s)`. Pinning `maplibre-gl@4.7.1` here — its last
version with a self-contained classic UMD bundle — avoids both problems while
keeping the same public API this feature actually uses (`Map`, `Marker`,
`Popup`, `NavigationControl`, `ScaleControl`).

The only network dependency this page cannot vendor is the basemap tiles
themselves (`https://tile.openstreetmap.org/...`), fetched live like any
other web map — the same as the original React app.

## Deploying

`netlify.toml` sets `publish = "."` and `functions = "netlify/functions"` —
needed so Netlify picks up the Postpass proxy function above. Everything
else about the deploy is unchanged: no build command, this whole folder is
the publish directory.

### Local development

Plain static file servers (`npx serve`, `file://`) can't run
`netlify/functions/overpass.js`, so the parking feature has nothing to call
locally under those. Use the Netlify CLI instead, which serves the static
files and the function together on one port:

```
npx netlify-cli dev
```
