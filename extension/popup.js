const title = document.querySelector('#page-title');
const button = document.querySelector('#capture');
const message = document.querySelector('#message');
const stateLabel = document.querySelector('#state-label');
let currentTab;
const project = document.querySelector('#project');
const form = document.querySelector('#capture-form');
const siteToggle = document.querySelector('#site-toggle');
const injectPage = document.querySelector('#inject-page');
const siteState = document.querySelector('#site-state');
const siteDetail = document.querySelector('#site-detail');
const siteControl = document.querySelector('.site-control');
const projectsList = document.querySelector('#projects-list');
const BUILT_IN_SITES = new Set(['youtube.com', 'xiaohongshu.com', 'douyin.com', 'tiktok.com', 'bilibili.com', 'x.com', 'twitter.com', 'instagram.com', 'facebook.com', 'vimeo.com', 'dailymotion.com', 'twitch.tv']);
let currentHost = '';

function siteKey(value) {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

async function siteConfiguration() {
  if (!currentHost) return;
  const stored = await chrome.storage.local.get(['mediaSites', 'disabledMediaSites']);
  const custom = Array.isArray(stored.mediaSites) ? stored.mediaSites : [];
  const disabled = Array.isArray(stored.disabledMediaSites) ? stored.disabledMediaSites : [];
  const enabled = BUILT_IN_SITES.has(currentHost) ? !disabled.includes(currentHost) : custom.includes(currentHost);
  siteState.textContent = enabled ? '已启用' : '未启用';
  siteToggle.textContent = enabled ? '停用' : '启用';
  siteToggle.classList.toggle('enabled', enabled);
  siteToggle.dataset.enabled = String(enabled);
  siteToggle.disabled = false;
  injectPage.hidden = !enabled;
  injectPage.disabled = !enabled;
}

function supported(url) {
  try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
}

async function injectCurrentPage() {
  if (!currentTab?.id || !supported(currentTab.url) || !chrome.scripting?.executeScript) return { ok: false, reason: 'unsupported' };
  try {
    await chrome.scripting.executeScript({ target: { tabId: currentTab.id }, files: ['content.js'] });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: currentTab.id },
      func: async () => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const marker = document.documentElement?.hasAttribute('data-clipcargo-page-control')
            || Boolean(document.querySelector('[data-clipcargo-video-control]'));
          if (marker) return true;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return false;
      },
    });
    return result?.result === true ? { ok: true } : { ok: false, reason: 'missing' };
  } catch {
    return { ok: false, reason: 'blocked' };
  }
}

function showInjectionState(result) {
  if (result.ok) {
    siteState.textContent = '已启用，入口已显示';
    siteDetail.textContent = '当前页面已注入 ClipCargo 浮标。';
    siteDetail.className = 'site-detail ok';
    siteDetail.hidden = true;
    injectPage.hidden = true;
    siteControl.hidden = true;
    return;
  }
  siteControl.hidden = false;
  siteState.textContent = result.reason === 'blocked' ? '注入受阻' : '等待页面刷新';
  siteDetail.textContent = result.reason === 'blocked'
    ? '当前页暂时拒绝脚本注入，请刷新页面后重试。'
    : '已启用当前网站，但页面还没有报告入口。';
  siteDetail.className = 'site-detail error';
  siteDetail.hidden = false;
  injectPage.hidden = false;
  injectPage.disabled = false;
}

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  currentTab = tab;
  title.textContent = tab?.title || '未命名页面';
  title.title = title.textContent;
  currentHost = siteKey(tab?.url || '');
  button.disabled = !supported(tab?.url);
  if (button.disabled) {
    siteControl.hidden = true;
    stateLabel.textContent = '不可收集';
    stateLabel.className = 'state-label';
    message.textContent = '当前页面暂不支持收集。';
  } else {
    siteControl.hidden = !currentHost;
    stateLabel.textContent = '可收集';
    stateLabel.className = 'state-label available';
    siteConfiguration().then(async () => {
      if (siteToggle.dataset.enabled === 'true') showInjectionState(await injectCurrentPage());
    }).catch(() => { siteState.textContent = '读取失败'; });
  }
}).catch(() => {
  siteControl.hidden = true;
  title.textContent = '无法读取当前页面';
  stateLabel.textContent = '读取失败';
  stateLabel.className = 'state-label error';
  message.textContent = '请关闭弹窗后重试。';
  message.className = 'message error';
});

siteToggle.addEventListener('click', async () => {
  if (!currentHost || !currentTab) return;
  siteToggle.disabled = true;
  const enabling = siteToggle.dataset.enabled !== 'true';
  try {
    const stored = await chrome.storage.local.get(['mediaSites', 'disabledMediaSites']);
    const custom = new Set(Array.isArray(stored.mediaSites) ? stored.mediaSites : []);
    const disabled = new Set(Array.isArray(stored.disabledMediaSites) ? stored.disabledMediaSites : []);
    if (enabling) {
      if (!BUILT_IN_SITES.has(currentHost)) {
        const origins = [`https://${currentHost}/*`, `https://*.${currentHost}/*`, `http://${currentHost}/*`, `http://*.${currentHost}/*`];
        const granted = await chrome.permissions.request({ origins });
        if (!granted) throw new Error('未授予当前网站访问权限。');
        custom.add(currentHost);
      }
      disabled.delete(currentHost);
    } else {
      if (BUILT_IN_SITES.has(currentHost)) disabled.add(currentHost);
      else {
        custom.delete(currentHost);
        await chrome.permissions.remove({ origins: [`https://${currentHost}/*`, `https://*.${currentHost}/*`, `http://${currentHost}/*`, `http://*.${currentHost}/*`] });
      }
    }
    await chrome.storage.local.set({ mediaSites: [...custom], disabledMediaSites: [...disabled] });
    await chrome.runtime.sendMessage({ type: 'sync-media-sites' });
    await siteConfiguration();
    if (enabling) {
      showInjectionState(await injectCurrentPage());
    } else {
      siteControl.hidden = false;
      siteState.textContent = '刷新页面后停用';
      siteDetail.textContent = '当前页面刷新后，ClipCargo 浮标会消失。';
      siteDetail.className = 'site-detail';
      siteDetail.hidden = true;
      injectPage.hidden = true;
    }
  } catch (error) {
    siteState.textContent = error?.message || '设置失败';
  } finally {
    siteToggle.disabled = false;
  }
});

injectPage.addEventListener('click', async () => {
  injectPage.disabled = true;
  siteState.textContent = '正在注入…';
  siteDetail.textContent = '正在重新连接当前页面。';
  siteDetail.className = 'site-detail';
  siteDetail.hidden = false;
  showInjectionState(await injectCurrentPage());
});

chrome.storage.local.get(['lastProject', 'recentProjects']).then((stored) => {
  const recent = Array.isArray(stored.recentProjects) ? stored.recentProjects.filter((value) => typeof value === 'string' && value.trim()).slice(0, 8) : [];
  projectsList.innerHTML = [...new Set(recent)].map((value) => `<option value="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></option>`).join('');
  if (typeof stored.lastProject === 'string' && stored.lastProject.trim()) project.value = stored.lastProject.slice(0, 50);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentTab || !supported(currentTab.url)) return;
  button.disabled = true;
  button.textContent = '正在发送…';
  message.textContent = '';
  const projectName = project.value.trim() || '未分类';
  const storedProjects = await chrome.storage.local.get(['lastProject', 'recentProjects']);
  const recentProjects = [projectName, ...(Array.isArray(storedProjects.recentProjects) ? storedProjects.recentProjects : [])]
    .map((value) => String(value || '').trim().slice(0, 50))
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 8);
  await chrome.storage.local.set({ lastProject: projectName, recentProjects });
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'capture-active-tab',
      payload: {
        pageUrl: currentTab.url,
        title: currentTab.title || '',
        projectName,
        method: 'extension',
      },
    });
    if (!response?.ok) throw new Error(response?.error || '未连接到 ClipCargo 桌面端。');
    const queued = Boolean(response.value?.queued);
    stateLabel.className = `state-label ${queued ? 'queued' : 'ready'}`;
    stateLabel.textContent = queued ? '已暂存' : '已送达';
    button.textContent = queued ? '已暂存，等待桌面端' : '已收进 ClipCargo';
    message.textContent = queued ? '桌面端未连接；链接已保存在扩展中，下次连接会自动发送。' : '页面链接已写入 ClipCargo。';
    message.className = `message ${queued ? 'queued' : 'ready'}`;
  } catch (error) {
    button.disabled = false;
    button.textContent = '重新发送';
    stateLabel.className = 'state-label error';
    stateLabel.textContent = '发送失败';
    message.textContent = String(error?.message || error);
    message.className = 'message error';
  }
});
