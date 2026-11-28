import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const workspaceSource = readFileSync(new URL('../src/state/workspace.js', import.meta.url), 'utf8');
const studioSource = readFileSync(new URL('../src/views/studio.js', import.meta.url), 'utf8');
const storage = new Map();
const localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) };
const document = { activeElement: null, querySelector: () => null };
class HTMLElement {}
const window = { ClipCargoViews: { library: { completedAssets: (state) => state.assets } } };
const context = { window, document, HTMLElement, Element: class {}, localStorage, CSS: { escape: (value) => value }, console };
vm.runInNewContext(workspaceSource, context);
vm.runInNewContext(studioSource, context);

const asset = { assetType: 'original', assetId: 42, id: 42, parentJobId: 42, title: 'Studio smoke', projectName: '测试项目', filePath: 'C:\\Media\\smoke.mp4', durationSeconds: 90, status: 'completed', hasVideo: true };
const state = { assets: [asset], jobs: [asset], derivatives: [], components: { ffmpegReady: true }, editor: { id: 'jianying', name: '剪映 Pro' } };
const helpers = { escapeHtml: (value) => String(value), icon: (name) => `<i>${name}</i>` };
const html = window.ClipCargoViews.studio.render({ state, helpers });

for (const marker of ['id="studio-video"', 'id="studio-timeline"', 'data-timeline-handle="in"', 'data-timeline-handle="out"', 'id="studio-crop-frame"', 'id="studio-auto-import"']) {
  if (!html.includes(marker)) throw new Error(`Studio render marker missing: ${marker}`);
}
for (const mode of ['clip', 'crop-vertical', 'speed-2x', 'rotate-left', 'rotate-right', 'compress', 'audio', 'mute', 'convert']) {
  if (!html.includes(`data-studio-mode="${mode}"`)) throw new Error(`Studio mode missing: ${mode}`);
}

const missingFfmpegHtml = window.ClipCargoViews.studio.render({ state: { ...state, components: { ffmpegReady: false } }, helpers });
if (!missingFfmpegHtml.includes('缺少 FFmpeg') || !missingFfmpegHtml.includes('data-studio-settings') || !missingFfmpegHtml.includes('id="studio-process-submit" class="button primary wide" type="button" disabled')) {
  throw new Error('Studio missing-FFmpeg guidance or disabled submit state is missing');
}

window.ClipCargoWorkspace.openStudioAsset('original', 42, 12.5);
if (window.ClipCargoWorkspace.ui.studio.activeKey !== 'original:42' || window.ClipCargoWorkspace.ui.studio.pendingSeek !== 12.5) throw new Error('Timed Studio routing state was not retained');
const session = window.ClipCargoWorkspace.ensureStudioSession(asset);
session.inPoint = 3.5; session.outPoint = 18; session.cropX = 25; session.cropY = 70; session.cropZoom = 145;
if (session.outPoint - session.inPoint !== 14.5 || session.cropZoom !== 145) throw new Error('Studio edit state was not retained');

console.log(JSON.stringify({ modes: 9, timedSeek: true, timelineRange: 14.5, crop: [25, 70, 145], missingFfmpegGuide: true }));
