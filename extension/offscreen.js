// Offscreen document: lives as an extension page (not a service worker), so it is not
// killed after 30s idle. It owns the long-poll connection and forwards commands to the
// service worker, which does the CDP work.
const RELAY = 'http://127.0.0.1:9311';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dispatch(cmd) {
  return await Promise.race([
    chrome.runtime.sendMessage({ type: 'cmd', cmd }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('service worker did not answer in 45s')), 45000)),
  ]);
}

let lastError = null;

async function loop() {
  for (;;) {
    try {
      const r = await fetch(RELAY + '/poll', { cache: 'no-store' });
      if (r.status === 200) {
        const cmd = await r.json();
        let msg;
        try {
          const res = await dispatch(cmd);
          msg = res || { id: cmd.id, ok: false, error: 'empty response from service worker' };
        } catch (e) {
          msg = { id: cmd.id, ok: false, error: String(e?.message || e) };
        }
        await fetch(RELAY + '/result', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(msg),
        });
        lastError = null;
      }
    } catch (e) {
      lastError = String(e?.message || e);
      await sleep(500);
    }
    await sleep(30);
  }
}

loop();
