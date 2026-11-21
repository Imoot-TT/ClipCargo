import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';

const output = new URL('../reports/product-flow-audit-2026-11-10/80-option1-implementation.png', import.meta.url);

createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/screenshot') {
      response.statusCode = 404;
      response.end('Not found');
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) throw new Error('Screenshot exceeds 10 MiB');
      chunks.push(chunk);
    }
    await writeFile(output, Buffer.concat(chunks));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, bytes: size }));
  } catch (error) {
    response.statusCode = 500;
    response.end(String(error));
  }
}).listen(4176, '127.0.0.1', () => console.log('QA screenshot receiver: http://127.0.0.1:4176/screenshot'));
