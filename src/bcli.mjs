#!/usr/bin/env node
// CLI: run one browser command and print JSON.
//
//   node src/bcli.mjs '{"op":"tabs"}'
//   '{"op":"eval","args":{"tabId":"...","code":"document.title"}}' | node src/bcli.mjs -
//
// Backend selection is automatic:
//   1. direct CDP on 127.0.0.1:${BRIDGE_CDP_PORT:-9222}   (durable)
//   2. extension relay on 127.0.0.1:${BRIDGE_RELAY_PORT:-9311}  (works with a browser you already have open)
//
// Ops: ping | status | tabs | open | activate | close | eval | shot | click | type | key | cdp
// See README.md for the argument of each op.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as cdp from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY_PORT = Number(process.env.BRIDGE_RELAY_PORT || 9311);
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health() {
  try {
    const r = await fetch(RELAY + '/health', { signal: AbortSignal.timeout(1500) });
    return await r.json();
  } catch {
    return null;
  }
}

async function ensureRelay() {
  let h = await health();
  if (h) return h;
  const child = spawn(process.execPath, [path.join(HERE, 'relay.mjs')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    h = await health();
    if (h) return h;
  }
  return null;
}

async function waitOnline(ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const h = await health();
    if (h?.online) return h;
    await sleep(250);
  }
  return await health();
}

const readStdin = () =>
  new Promise((r) => {
    let d = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => r(d));
  });

let raw = process.argv.slice(2).join(' ').trim();
if (raw === '--help' || raw === '-h') {
  console.log('usage: node src/bcli.mjs \'{"op":"tabs"}\'   (or pipe JSON via stdin with -)');
  process.exit(0);
}
if (!raw || raw === '-') raw = (await readStdin()).trim();
if (!raw) {
  console.error('usage: node src/bcli.mjs \'{"op":"tabs"}\'');
  process.exit(2);
}

let cmd;
try {
  cmd = JSON.parse(raw);
} catch (e) {
  console.error('bad json: ' + e.message);
  process.exit(2);
}

let out;
let backend;

if (await cdp.isUp()) {
  backend = 'cdp';
  try {
    out = { ok: true, value: await cdp.run(cmd.op, cmd.args || {}) };
  } catch (e) {
    out = { ok: false, error: String(e?.message || e) };
  }
} else {
  backend = 'extension';
  await ensureRelay();
  let h = await waitOnline();

  if (!h?.online) {
    try {
      await fetch(RELAY + '/unstick', { signal: AbortSignal.timeout(3000) });
    } catch {}
    h = await waitOnline();
  }

  if (!h?.online) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: 'no browser backend available',
          hint: 'start Edge with --remote-debugging-port=9222, or load the extension (see README)',
          health: h,
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  const res = await fetch(RELAY + '/cmd', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  out = await res.json();
}

if (out.ok && cmd.op === 'shot' && typeof out.value === 'string') {
  const file = cmd.args?.out || 'shot.png';
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, Buffer.from(out.value, 'base64'));
  console.log(JSON.stringify({ ok: true, backend, file, bytes: fs.statSync(file).size }, null, 2));
} else {
  console.log(JSON.stringify({ ...out, backend }, null, 2));
}
