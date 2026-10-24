#!/usr/bin/env node
/** Zero-dependency preview server for site/.  npm run preview */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const PORT = Number(process.env.PORT ?? 4321);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

http
  .createServer((request, response) => {
    const url = decodeURIComponent((request.url ?? '/').split('?')[0]);
    const target = path.join(ROOT, url === '/' ? 'index.html' : url);
    if (!target.startsWith(ROOT)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(target, (error, body) => {
      if (error) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
        return;
      }
      response.writeHead(200, { 'content-type': TYPES[path.extname(target)] ?? 'application/octet-stream' }).end(body);
    });
  })
  .listen(PORT, () => console.log(`http://localhost:${PORT}`));
