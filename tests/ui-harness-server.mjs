import { createServer } from 'node:http';
import { get } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../src/', import.meta.url);
const rootPath = normalize(fileURLToPath(root));
const extensionRootPath = normalize(fileURLToPath(new URL('../extension/', import.meta.url)));
const qaScreenshotDirectory = fileURLToPath(new URL('../reports/product-flow-audit-2026-11-10/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    response.setHeader('Cache-Control', 'no-store');
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/tests/save-qa-screenshot' && request.method === 'POST') {
      const requestedName = new URL(request.url, 'http://127.0.0.1').searchParams.get('name') || '80-option1-implementation.png';
      if (!/^\d{2,3}-[a-z0-9-]+\.png$/.test(requestedName)) throw new Error('Invalid screenshot name');
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 10 * 1024 * 1024) throw new Error('Screenshot exceeds 10 MiB');
        chunks.push(chunk);
      }
      await writeFile(join(qaScreenshotDirectory, requestedName), Buffer.concat(chunks));
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ok: true, bytes: size }));
      return;
    }
    if (pathname === '/tests/ui-harness-mock.js') {
      response.setHeader('Content-Type', mime['.js']);
      response.end(await readFile(new URL('./ui-harness-mock.js', import.meta.url)));
      return;
    }
    if (pathname === '/tests/extension-popup-mock.js') {
      response.setHeader('Content-Type', mime['.js']);
      response.end(await readFile(new URL('./extension-popup-mock.js', import.meta.url)));
      return;
    }
    if (pathname === '/tests/extension-content-harness.html' || pathname === '/tests/extension-custom-harness.html' || pathname === '/tests/x-content-harness.html' || pathname === '/tests/x-content-mock.js' || pathname === '/tests/extension-content-mock.js') {
      const fileName = pathname.slice('/tests/'.length);
      response.setHeader('Content-Type', mime[extname(fileName)] || 'application/octet-stream');
      response.end(await readFile(new URL(`./${fileName}`, import.meta.url)));
      return;
    }
    if (pathname.startsWith('/extension/')) {
      const relative = decodeURIComponent(pathname.slice('/extension/'.length)) || 'popup.html';
      const path = normalize(join(extensionRootPath, relative));
      if (!path.startsWith(extensionRootPath)) throw new Error('Invalid extension path');
      let content = await readFile(path);
      if (relative === 'popup.html') content = Buffer.from(content.toString().replace('<script src="popup.js"', '<script src="/tests/extension-popup-mock.js"></script>\n  <script src="popup.js"'));
      response.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
      response.end(content);
      return;
    }
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const path = normalize(join(rootPath, relative));
    if (!path.startsWith(rootPath)) throw new Error('Invalid path');
    let content = await readFile(path);
    if (relative === 'index.html') content = Buffer.from(content.toString().replace('<script src="./link-utils.js', '<script src="/tests/ui-harness-mock.js"></script>\n  <script src="./link-utils.js'));
    response.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
    response.end(content);
  } catch (error) {
    response.statusCode = 404;
    response.end(String(error));
  }
});

const host = '127.0.0.1';
const port = 4175;

server.on('error', (error) => {
  if (error.code !== 'EADDRINUSE') throw error;

  const probe = get(`http://${host}:${port}/`, (response) => {
    const isClipCargoHarness = response.headers['cache-control'] === 'no-store';
    response.resume();
    if (isClipCargoHarness) {
      console.log(`ClipCargo UI harness is already running: http://${host}:${port}`);
      process.exitCode = 0;
      return;
    }

    console.error(`Port ${port} is occupied by another application. Stop that application or free the port before starting the ClipCargo UI harness.`);
    process.exitCode = 1;
  });

  probe.on('error', () => {
    console.error(`Port ${port} is already in use and the existing service could not be identified.`);
    process.exitCode = 1;
  });
  probe.setTimeout(1500, () => probe.destroy());
});

server.listen(port, host, () => console.log(`ClipCargo UI harness: http://${host}:${port}`));
