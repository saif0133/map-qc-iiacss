// Local-development-only static file server with HTTP Range support.
//
// `netlify dev`'s own built-in static server always answers with the whole
// file, which breaks geotiff.js's windowed reads of the population raster
// ("Server responded with full file"). `npx serve` supports ranges but its
// Windows binary resolution breaks when netlify-cli spawns it as a nested
// child process (see netlify.toml's `[dev].command`), so this is a small,
// dependency-free replacement invoked directly via `node`, which has no such
// resolution ambiguity. Not used in production — Netlify's own hosting
// supports range requests natively.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3999;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.csv': 'text/csv; charset=utf-8',
};

function contentType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let relativePath = decodeURIComponent(url.pathname);
    if (relativePath === '/' || relativePath === '') relativePath = '/index.html';

    const filePath = path.join(ROOT, relativePath);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const stats = await stat(filePath).catch(() => null);
    if (!stats || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const type = contentType(filePath);
    const range = req.headers.range;

    if (!range) {
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stats.size,
        'Accept-Ranges': 'bytes',
      });
      createReadStream(filePath).pipe(res);
      return;
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
      res.end();
      return;
    }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : stats.size - 1;
    if (start > end || end >= stats.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stats.size}` });
      res.end();
      return;
    }

    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stats.size}`,
      'Accept-Ranges': 'bytes',
    });
    createReadStream(filePath, { start, end }).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal error: ' + (err instanceof Error ? err.message : String(err)));
  }
});

server.listen(PORT, () => {
  console.log(`Dev static server (range-request capable) listening on http://localhost:${PORT}`);
});
