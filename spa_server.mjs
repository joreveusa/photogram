import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dist = '/mnt/j/AI DATA CENTER/AI Agents/PhotoForge/frontend/dist';
const mime = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

http.createServer((req, res) => {
  let filePath = path.join(dist, req.url.split('?')[0]);
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) filePath = path.join(dist, 'index.html');
  } catch {
    filePath = path.join(dist, 'index.html');
  }
  const ext = path.extname(filePath);
  res.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
  fs.createReadStream(filePath).pipe(res);
}).listen(1420, '0.0.0.0', () => {
  console.log('PhotoForge UI → http://localhost:1420');
});
