// Reopen a saved tab list in the CDP browser (background tabs, no focus stealing).
//
//   node src/restore-tabs.mjs backup/tabs.json
//
// The JSON must be an array of objects with a `url` field — the format `bcli.mjs tabs` prints.
import fs from 'node:fs';

const PORT = Number(process.env.BRIDGE_CDP_PORT || 9222);
const HOST = `http://127.0.0.1:${PORT}`;

const file = process.argv[2];
if (!file) {
  console.error('usage: node src/restore-tabs.mjs <tabs.json>');
  process.exit(2);
}

const tabs = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const urls = [...new Set(tabs.map((t) => t.url).filter((u) => u && /^https?:/i.test(u)))];

const ver = await (await fetch(HOST + '/json/version')).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  const p = m.id && pending.get(m.id);
  if (p) {
    pending.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  }
};
const send = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
};

const q = [...urls];
let ok = 0;
let fail = 0;
const errors = [];

async function worker() {
  while (q.length) {
    const url = q.shift();
    try {
      await send('Target.createTarget', { url, background: true, newWindow: false });
      ok++;
    } catch (e) {
      fail++;
      if (errors.length < 5) errors.push(url.slice(0, 80) + ' -> ' + e.message);
    }
  }
}

await Promise.all([worker(), worker(), worker()]);
console.log(JSON.stringify({ requested: urls.length, opened: ok, failed: fail, errors }, null, 2));
process.exit(0);
