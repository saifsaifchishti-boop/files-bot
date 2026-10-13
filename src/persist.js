/**
 * PERSISTENCE FOR HEROKU (and any host whose disk is wiped on every restart).
 *
 * Heroku deletes ./data and ./session whenever the dyno restarts (at least once a day), so settings
 * and the WhatsApp login would be lost. This module keeps both folders in a free Upstash Redis
 * database (plain HTTPS, no extra npm package) and restores them BEFORE the bot starts.
 *
 *   UPSTASH_REDIS_REST_URL    https://xxxx.upstash.io
 *   UPSTASH_REDIS_REST_TOKEN  (the REST token)
 *
 * Not configured → this module does nothing (local PC / VPS with a real disk keep working as before).
 * Optional: PERSIST_PREFIX (default "mehfooz"), PERSIST_SESSION_SEC (default 45), PERSIST_DATA_SEC (default 10).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import axios from 'axios';

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const URL_ = (env('UPSTASH_REDIS_REST_URL') || env('KV_REST_API_URL') || env('REDIS_REST_URL')).replace(/\/$/, '');
const TOKEN = env('UPSTASH_REDIS_REST_TOKEN') || env('KV_REST_API_TOKEN') || env('REDIS_REST_TOKEN');
export const persistEnabled = !!(URL_ && TOKEN);
const KEY = `${env('PERSIST_PREFIX', 'mehfooz')}:files`;
const CHUNK = 400 * 1024;           // raw bytes per Redis field (stays far below the 1 MB request limit)
const MAX_FILE = 25 * 1024 * 1024;
const BATCH_BYTES = 700 * 1024;

const dirs = () => ({ data: path.resolve(env('DATA_DIR', './data')), session: path.resolve(env('SESSION_DIR', './session')) });
const headers = () => ({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });
const say = (...a) => console.log('[persist]', ...a);

async function cmd(args) {
  const r = await axios.post(URL_, args, { headers: headers(), timeout: 30000, maxBodyLength: Infinity, maxContentLength: Infinity });
  if (r.data?.error) throw new Error(r.data.error);
  return r.data?.result;
}
async function pipe(cmds) {
  const r = await axios.post(`${URL_}/pipeline`, cmds, { headers: headers(), timeout: 60000, maxBodyLength: Infinity, maxContentLength: Infinity });
  const bad = (r.data || []).find((x) => x?.error);
  if (bad) throw new Error(bad.error);
}

function walk(dir, base = dir, out = []) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of list) {
    if (e.name.startsWith('.') || e.name.endsWith('.tmp')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

// what Redis is known to hold:  "label/rel" → { sig, fields:[...] }
const known = new Map();
let restoreOk = false;
let busy = false;

const fieldsFor = (id, buf) => {
  if (buf.length <= CHUNK) return [[id, buf.toString('base64')]];
  const out = [];
  for (let i = 0, n = 0; i < buf.length; i += CHUNK, n++) out.push([`${id}#${n}`, buf.subarray(i, i + CHUNK).toString('base64')]);
  return out;
};

/** Pull everything from Redis into ./data and ./session. Call once, before the server starts. */
export async function restoreAll() {
  if (!persistEnabled) return false;
  try {
    const flat = await cmd(['HGETALL', KEY]);
    const map = new Map();
    for (let i = 0; i + 1 < (flat || []).length; i += 2) map.set(flat[i], flat[i + 1]);
    const groups = new Map();
    for (const [f, v] of map) {
      const m = /^(.*)#(\d+)$/.exec(f);
      const id = m ? m[1] : f;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push({ n: m ? Number(m[2]) : 0, f, v });
    }
    const D = dirs();
    let files = 0;
    for (const [id, parts] of groups) {
      const slash = id.indexOf('/');
      const label = id.slice(0, slash), rel = id.slice(slash + 1);
      if (!D[label] || !rel || rel.includes('..')) continue;
      parts.sort((a, b) => a.n - b.n);
      const buf = Buffer.concat(parts.map((p) => Buffer.from(p.v, 'base64')));
      const dest = path.join(D[label], rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      const st = fs.statSync(dest);
      known.set(id, { sig: `${st.size}:${st.mtimeMs}`, fields: parts.map((p) => p.f) });
      files++;
    }
    restoreOk = true;
    say(files ? `restored ${files} file(s) (settings + WhatsApp session) from Redis` : 'Redis is empty — first start, nothing to restore yet');
    return true;
  } catch (e) {
    restoreOk = false;
    say(`⚠️ could not read Redis (${e?.response?.status || e?.message}) — saving is DISABLED this run so the stored data is never overwritten`);
    return false;
  }
}

/** Push every changed / new file, delete removed ones. */
async function flush(labels) {
  if (!persistEnabled || !restoreOk || busy) return;
  busy = true;
  try {
    const D = dirs();
    const cmds = [];
    let size = 0;
    const send = async () => { if (cmds.length) { const c = cmds.splice(0); size = 0; await pipe(c); } };
    const seen = new Set();
    for (const label of labels) {
      for (const rel of walk(D[label])) {
        const id = `${label}/${rel}`;
        seen.add(id);
        const full = path.join(D[label], rel);
        let st; try { st = fs.statSync(full); } catch { continue; }
        const sig = `${st.size}:${st.mtimeMs}`;
        if (known.get(id)?.sig === sig || st.size > MAX_FILE) continue;
        let buf; try { buf = fs.readFileSync(full); } catch { continue; }
        const fl = fieldsFor(id, buf);
        const stale = (known.get(id)?.fields || []).filter((f) => !fl.some(([n]) => n === f));
        if (stale.length) cmds.push(['HDEL', KEY, ...stale]);
        for (const [f, v] of fl) { cmds.push(['HSET', KEY, f, v]); size += v.length; if (size > BATCH_BYTES) await send(); }
        known.set(id, { sig, fields: fl.map(([n]) => n) });
      }
    }
    for (const [id, info] of [...known]) { // removed files
      if (!labels.includes(id.slice(0, id.indexOf('/'))) || seen.has(id)) continue;
      cmds.push(['HDEL', KEY, ...info.fields]); known.delete(id);
    }
    await send();
  } catch (e) { say(`save failed (${e?.response?.status || e?.message}) — will retry`); known.clear(); /* re-scan next time */ }
  finally { busy = false; }
}

let timer = null;
/** Start the background saver. Also saves on shutdown (Heroku sends SIGTERM before every restart). */
export function startSync() {
  if (!persistEnabled || !restoreOk || timer) return;
  const dataEvery = Math.max(3, Number(env('PERSIST_DATA_SEC', '10'))) * 1000;
  const sessEvery = Math.max(10, Number(env('PERSIST_SESSION_SEC', '45'))) * 1000;
  let last = 0;
  timer = setInterval(() => {
    const now = Date.now();
    const labels = ['data'];
    if (now - last >= sessEvery) { labels.push('session'); last = now; }
    flush(labels).catch(() => {});
  }, dataEvery);
  timer.unref();
  const finalFlush = async () => { try { while (busy) await new Promise((r) => setTimeout(r, 100)); await flush(['data', 'session']); } catch { /* ignore */ } };
  globalThis.__persistFlush = finalFlush;
  let closing = false;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      if (closing) return; closing = true;
      say(`${sig}: saving settings before shutdown …`);
      Promise.race([finalFlush(), new Promise((r) => setTimeout(r, 8000))]).finally(() => process.exit(0));
    });
  }
  say(`saving settings every ${dataEvery / 1000}s and the WhatsApp session every ${sessEvery / 1000}s`);
}
