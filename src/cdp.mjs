// Direct CDP backend.
//
// Talks to a Chromium browser started with --remote-debugging-port (default 9222).
// This is the durable path: the browser process itself listens, so nothing dies when a
// service worker idles out.
const PORT = Number(process.env.BRIDGE_CDP_PORT || 9222);
const HOST = `http://127.0.0.1:${PORT}`;

export async function isUp() {
  try {
    const r = await fetch(HOST + '/json/version', { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch {
    return false;
  }
}

async function listPages() {
  const r = await fetch(HOST + '/json/list', { signal: AbortSignal.timeout(3000) });
  const all = await r.json();
  return all.filter((t) => t.type === 'page');
}

class Conn {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }

  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('ws open timeout')), 5000);
      this.ws.onopen = () => {
        clearTimeout(t);
        res();
      };
      this.ws.onerror = () => {
        clearTimeout(t);
        rej(new Error('ws error: cannot connect ' + this.wsUrl));
      };
    });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      const p = m.id && this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
      }
    };
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error('cdp timeout: ' + method));
      }, 30000);
      this.pending.set(id, {
        res: (v) => {
          clearTimeout(t);
          res(v);
        },
        rej: (e) => {
          clearTimeout(t);
          rej(e);
        },
      });
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function pageConn(tabId) {
  const pages = await listPages();
  const t = pages.find((p) => p.id === tabId);
  if (!t) throw new Error('no such tab: ' + tabId);
  const c = new Conn(t.webSocketDebuggerUrl);
  await c.open();
  return c;
}

async function browserConn() {
  const r = await fetch(HOST + '/json/version', { signal: AbortSignal.timeout(3000) });
  const v = await r.json();
  const c = new Conn(v.webSocketDebuggerUrl);
  await c.open();
  return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run(op, args = {}) {
  if (op === 'ping') return 'pong (cdp)';

  if (op === 'tabs') {
    const pages = await listPages();
    return pages.map((t) => ({
      tabId: t.id,
      title: t.title,
      url: t.url,
      active: null,
      status: 'cdp',
    }));
  }

  if (op === 'open') {
    const url = args.url || 'about:blank';
    const r = await fetch(`${HOST}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!r.ok) throw new Error('cannot open tab: HTTP ' + r.status);
    const t = await r.json();
    return { tabId: t.id };
  }

  if (op === 'close') {
    const b = await browserConn();
    try {
      await b.send('Target.closeTarget', { targetId: args.tabId });
    } finally {
      b.close();
    }
    return true;
  }

  if (op === 'activate') {
    const b = await browserConn();
    try {
      await b.send('Target.activateTarget', { targetId: args.tabId });
    } finally {
      b.close();
    }
    return true;
  }

  const tabId = args.tabId;
  if (!tabId) throw new Error('args.tabId is required');

  const c = await pageConn(tabId);
  try {
    if (op === 'eval') {
      const r = await c.send('Runtime.evaluate', {
        expression: args.code,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (r.exceptionDetails) {
        return { __error: r.exceptionDetails.text, detail: r.exceptionDetails.exception?.description };
      }
      return r.result?.value;
    }

    if (op === 'shot') {
      const r = await c.send('Page.captureScreenshot', { format: 'png' });
      return r.data;
    }

    if (op === 'click') {
      const { x, y, button = 'left', clickCount = 1 } = args;
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
      await sleep(30);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
      return true;
    }

    if (op === 'type') {
      await c.send('Input.insertText', { text: args.text ?? '' });
      return true;
    }

    if (op === 'key') {
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', ...args.key });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...args.key });
      return true;
    }

    if (op === 'cdp') {
      return await c.send(args.method, args.params || {});
    }

    throw new Error('unknown op: ' + op);
  } finally {
    c.close();
  }
}
