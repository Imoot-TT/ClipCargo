import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/state/workspace.js', import.meta.url), 'utf8');
const persistentConfirm = { matches: () => false };
const document = {
  activeElement: null,
  querySelector(selector) {
    if (selector === '[data-confirm-persistent="true"]') return persistentConfirm.open ? persistentConfirm : null;
    if (selector === '#main') return { scrollTop: 0 };
    return null;
  },
};
class HTMLElement {
  matches(selector) { return selector.includes('input') || selector.includes('data-preserve-refresh'); }
}
const window = {};
const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
vm.runInNewContext(source, { window, document, HTMLElement, localStorage, CSS: { escape: (value) => value } });

const workspace = window.ClipCargoWorkspace;
if (!workspace) throw new Error('Workspace state module did not initialize');
if (workspace.shouldDeferRefresh()) throw new Error('Idle workspace should allow a refresh');

workspace.openDrawer('add-links', { value: 'https://example.com' });
if (!workspace.shouldDeferRefresh()) throw new Error('An open drawer must defer destructive refreshes');
if (workspace.ui.drawer.draft.value !== 'https://example.com') throw new Error('Drawer draft was not retained');
workspace.closeDrawer();

persistentConfirm.open = true;
if (!workspace.shouldDeferRefresh()) throw new Error('A persistent confirmation must defer destructive refreshes');
persistentConfirm.open = false;

const input = new HTMLElement();
input.dataset = { focusKey: 'library-search' };
input.id = 'library-search';
input.selectionStart = 2;
input.selectionEnd = 4;
input.isConnected = true;
input.focus = () => {};
input.setSelectionRange = () => {};
document.activeElement = input;
document.querySelector = (selector) => {
  if (selector === '[data-confirm-persistent="true"]') return null;
  if (selector === '#main') return { scrollTop: 0 };
  if (selector === '[data-focus-key="library-search"]') return input;
  return null;
};
const root = { contains: (element) => element === input };
if (!workspace.shouldDeferRefresh(root)) throw new Error('Focused preserved input must defer destructive refreshes');
const snapshot = workspace.captureInteraction(root);
if (snapshot.key !== '[data-focus-key="library-search"]' || snapshot.selection[0] !== 2) throw new Error('Focused input state was not captured');

console.log('Workspace state smoke test passed.');
