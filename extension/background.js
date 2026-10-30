// DSH Browser Bridge — service worker (v1.1).
// The service worker no longer holds the relay connection: an offscreen document does that,
// because MV3 service workers are killed after ~30s idle and take the poll loop with them.
// The offscreen document forwards commands here; a message wakes this worker if it is dead.
const attached = new Set();

chrome.debugger.onDetach.addListener((src) => {
  if (src.tabId) attached.delete(src.tabId);
});

async function ensure(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    const m = String(e?.message || e);
    if (!m.includes('Already attached') && !m.includes('Another debugger')) throw e;
  }
  attached.add(tabId);
}

async function cdp(tabId, method, params = {}) {
  await ensure(tabId);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    const m = String(e?.message || e);
    if (m.includes('not attached')) {
      attached.delete(tabId);
      await ensure(tabId);
      return await chrome.debugger.sendCommand({ tabId }, method, params);
    }
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ op, args = {} }) {
  if (op === 'ping') return 'pong';

  if (op === 'status') {
    let offscreen = null;
    try {
      offscreen = (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length;
    } catch (e) {
      offscreen = 'unavailable: ' + e.message;
    }
    return { version: chrome.runtime.getManifest().version, offscreen, attachedTabs: [...attached], t: Date.now() };
  }

  if (op === 'tabs') {
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => ({
      tabId: t.id, windowId: t.windowId, active: t.active, index: t.index,
      title: t.title, url: t.url, status: t.status,
    }));
  }

  if (op === 'open') {
    const t = await chrome.tabs.create({ url: args.url, active: args.active !== false });
    return { tabId: t.id };
  }

  if (op === 'activate') {
    await chrome.tabs.update(args.tabId, { active: true });
    return true;
  }

  if (op === 'close') {
    await chrome.tabs.remove(args.tabId);
    return true;
  }

  const tabId = args.tabId;
  if (!tabId) throw new Error('args.tabId is required');

  if (op === 'eval') {
    const r = await cdp(tabId, 'Runtime.evaluate', {
      expression: args.code,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) return { __error: r.exceptionDetails.text, detail: r.exceptionDetails.exception?.description };
    return r.result?.value;
  }

  if (op === 'shot') {
    try {
      const r = await cdp(tabId, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      return r.data;
    } catch (e) {
      await chrome.tabs.update(tabId, { active: true });
      await sleep(400);
      const r = await cdp(tabId, 'Page.captureScreenshot', { format: 'png' });
      return r.data;
    }
  }

  if (op === 'click') {
    const { x, y, button = 'left', clickCount = 1, modifier } = args;
    const mods = modifier || 0;
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: mods });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount, modifiers: mods });
    await sleep(30);
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount, modifiers: mods });
    return true;
  }

  if (op === 'type') {
    await cdp(tabId, 'Input.insertText', { text: args.text ?? '' });
    return true;
  }

  if (op === 'key') {
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...args.key });
    await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...args.key });
    return true;
  }

  if (op === 'cdp') {
    return await cdp(tabId, args.method, args.params || {});
  }

  throw new Error('unknown op: ' + op);
}

// --- offscreen keepalive -------------------------------------------------

async function ensureOffscreen() {
  try {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (ctxs.length) return 'present';
  } catch {
    // older runtime: fall through and try to create
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Holds the localhost connection to the DSH relay so the bridge survives service-worker idle shutdowns.',
    });
    return 'created';
  } catch (e) {
    const m = String(e?.message || e);
    if (m.includes('single offscreen') || m.includes('Only a single')) return 'present';
    throw e;
  }
}

ensureOffscreen().catch(() => {});
chrome.runtime.onInstalled.addListener(() => ensureOffscreen().catch(() => {}));
chrome.runtime.onStartup.addListener(() => ensureOffscreen().catch(() => {}));
chrome.alarms.create('watchdog', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => ensureOffscreen().catch(() => {}));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'cmd' && msg.cmd) {
    run(msg.cmd)
      .then((value) => sendResponse({ id: msg.cmd.id, ok: true, value }))
      .catch((e) => sendResponse({ id: msg.cmd.id, ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === 'ensure-offscreen') {
    ensureOffscreen().then(sendResponse).catch((e) => sendResponse('error: ' + e.message));
    return true;
  }
  if (msg?.type === 'reload-extension') {
    sendResponse({ ok: true });
    setTimeout(() => chrome.runtime.reload(), 200);
    return true;
  }
  return false;
});
