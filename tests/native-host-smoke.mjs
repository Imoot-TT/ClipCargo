import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const executableCandidates = [
  join(root, 'src-tauri', 'binaries', 'clipcargo-native-host-x86_64-pc-windows-msvc.exe'),
  join(root, 'src-tauri', 'target', 'debug', 'clipcargo-native-host.exe'),
  join(root, 'src-tauri', 'target', 'release', 'clipcargo-native-host.exe'),
];
const executable = executableCandidates.find(existsSync);
if (!executable) throw new Error(`Native host executable is missing. Checked: ${executableCandidates.join(', ')}`);
const queueRoot = join(root, 'reports', 'native-host-smoke');
rmSync(queueRoot, { recursive: true, force: true });
mkdirSync(queueRoot, { recursive: true });

const requestId = 'smoke-request-001';
const payload = Buffer.from(JSON.stringify({
  protocolVersion: 1,
  requestId,
  type: 'capture_page',
  payload: {
    pageUrl: 'https://example.com/video-page',
    title: 'Native host smoke',
    projectName: '未分类',
  },
}));
const frame = Buffer.alloc(payload.length + 4);
frame.writeUInt32LE(payload.length, 0);
payload.copy(frame, 4);

const child = spawn(executable, [], {
  env: { ...process.env, CLIPCARGO_BRIDGE_ROOT: queueRoot },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const chunks = [];
child.stdout.on('data', (chunk) => chunks.push(chunk));
child.stdin.end(frame);
const exitCode = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', resolveExit);
});
if (exitCode !== 0) throw new Error(`Native host exited with ${exitCode}`);

const responseFrame = Buffer.concat(chunks);
const responseLength = responseFrame.readUInt32LE(0);
const response = JSON.parse(responseFrame.subarray(4, 4 + responseLength).toString('utf8'));
if (!response.ok || !response.accepted || response.requestId !== requestId) throw new Error(`Unexpected response: ${JSON.stringify(response)}`);
const queued = JSON.parse(readFileSync(join(queueRoot, `${requestId}.json`), 'utf8'));
if (queued.payload.pageUrl !== 'https://example.com/video-page') throw new Error('Queued message changed');
console.log(JSON.stringify({ executable, exitCode, response, queuedFile: `${requestId}.json` }));
