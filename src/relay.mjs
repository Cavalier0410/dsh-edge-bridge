// Local relay between any caller (CLI, agent, script) and the browser extension.
//
// The extension long-polls GET /poll; callers POST /cmd and wait for the answer.
// No dependencies, 127.0.0.1 only.
//
// Why a relay at all: an MV3 extension cannot listen on a port, so it dials out instead.
// The flip side is a long-poll loop that must survive the service worker being killed,
// which is why the extension keeps an offscreen document alive (see extension/offscreen.js).
import http from 'node:http';

const PORT = Number(process.env.BRIDGE_RELAY_PORT || 9311);

const queue = [];
const pending = new Map();
let held = null;
let lastPoll = 0;
let seq = 0;

// connection health instrumentation, surfaced by /health
const startedAt = Date.now();
let pollCount = 0;
let maxGapMs = 0;
let prevPoll = 0;

const readBody = (req) =>
  new Promise((res) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => res(d));
  });

const json = (res, code, obj) => {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

function flush() {
  if (!held || !queue.length) return;
  const h = held;
  held = null;
  clearTimeout(h.timer);
  json(h.res, 200, queue.shift());
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (pathname === '/poll') {
    const now = Date.now();
    if (prevPoll) maxGapMs = Math.max(maxGapMs, now - prevPoll);
    prevPoll = now;
    lastPoll = now;
    pollCount += 1;

    if (queue.length) return json(res, 200, queue.shift());

    const timer = setTimeout(() => {
      if (held && held.res === res) {
        held = null;
        json(res, 204, {});
      }
    }, 20000);
    held = { res, timer };
    req.on('close', () => {
      if (held && held.res === res) {
        clearTimeout(timer);
        held = null;
      }
    });
    return;
  }

  if (pathname === '/result' && req.method === 'POST') {
    let msg;
    try {
      msg = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: 'bad json' });
    }
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p(msg);
    }
    return json(res, 200, { ok: true });
  }

  if (pathname === '/cmd' && req.method === 'POST') {
    let cmd;
    try {
      cmd = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: 'bad json' });
    }
    const id = ++seq;
    const answer = new Promise((r) => pending.set(id, r));
    queue.push({ id, op: cmd.op, args: cmd.args || {} });
    flush();
    const timeout = new Promise((r) => setTimeout(() => r({ ok: false, error: 'timeout: extension not connected' }), 60000));
    const out = await Promise.race([answer, timeout]);
    pending.delete(id);
    return json(res, 200, out);
  }

  // Break a hung long-poll so a stuck worker re-polls immediately instead of waiting 20s.
  if (pathname === '/unstick') {
    if (held) {
      const h = held;
      held = null;
      clearTimeout(h.timer);
      json(h.res, 204, { stuck: true });
      return json(res, 200, { ok: true, unstuck: true });
    }
    return json(res, 200, { ok: true, unstuck: false });
  }

  if (pathname === '/health') {
    return json(res, 200, {
      online: lastPoll > 0 && Date.now() - lastPoll < 30000,
      lastPollAgoSec: lastPoll ? Math.round((Date.now() - lastPoll) / 1000) : null,
      queued: queue.length,
      pending: pending.size,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      polls: pollCount,
      maxGapSec: Math.round(maxGapMs / 100) / 10,
    });
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => console.log(`relay listening on http://127.0.0.1:${PORT}`));
