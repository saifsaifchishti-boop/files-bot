/**
 * `.sim <number>` — looks a number up in YOUR configured SIM-data API (see SAIF_CHISHTI_SIM_COMMAND_INTEGRATION.md).
 *
 *  - Only the Super Developer, the board's own number and "Special Devs" (`.setspecial`) can use it. Normal developers cannot.
 *  - Nothing is hard-coded: URL / key / field names come from .env. The key is never printed or logged.
 *  - Raw API output is never sent to the chat — only number, network, status, plus fields YOU list in SIM_SHOW_FIELDS.
 */
import axios from 'axios';

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const BAR = '━━━━━━━━━━━━━━━━━━━━━━';
const box = (lines) => ['╭━━━〔 SAIF CHISHTI SIM DATABASE 〕━━━╮', '┃', ...lines.map((l) => `┃ ${l}`), '┃', '╰' + BAR + '╯'].join('\n');

/** 03XXXXXXXXX from 03…, 3…, 92…, +92…, 0092… (spaces/dashes ignored). Returns '' when invalid. */
export function normalizePkNumber(raw) {
  let d = String(raw || '').replace(/[^\d]/g, '');
  if (d.startsWith('0092')) d = d.slice(4);
  else if (d.startsWith('92') && d.length === 12) d = d.slice(2);
  if (d.length === 10 && d.startsWith('3')) d = '0' + d;
  return /^03\d{9}$/.test(d) ? d : '';
}

const pick = (obj, paths) => {
  for (const p of String(paths).split(',').map((x) => x.trim()).filter(Boolean)) {
    const v = p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
};

/** Special devs: the Super Developer decides who may use `.sim` (and other special commands). */
export async function isSpecial(bot, { state, groupJid, senderJid, senderBareNum, msg, isSuper }) {
  if (isSuper || msg?.key?.fromMe) return true;
  const list = (state.specialIds || []).map((id) => String(id).split('@')[0].split(':')[0]);
  if (!list.length) return false;
  const mine = new Set([senderBareNum]);
  try { for (const id of await bot._altIds(msg, senderJid)) mine.add(String(id).split('@')[0].split(':')[0]); } catch { /* none */ }
  try { for (const b of await bot._idBares(groupJid, senderJid)) mine.add(b); } catch { /* none */ }
  return [...mine].some((b) => list.includes(b));
}

const lastBy = new Map();
let lastAny = 0;

export async function runSim(bot, { argText, reply, senderBareNum, P }) {
  const number = normalizePkNumber(argText);
  if (!number) return reply(box(['⚠️ *Invalid number*', '', 'Example:', `${P}sim 03001234567`]));
  const now = Date.now();
  if (now - (lastBy.get(senderBareNum) || 0) < 5000 || now - lastAny < 1000) return reply(box(['⏳ Please wait a few seconds', 'before the next search.']));
  lastBy.set(senderBareNum, now); lastAny = now;

  const url = env('SIM_API_URL'), key = env('SIM_API_KEY');
  if (!url) return reply(box(['⚙️ SIM API is not set up yet.', '', 'Add SIM_API_URL and SIM_API_KEY', 'to the server .env, then restart once.']));

  const method = env('SIM_API_METHOD', 'GET').toUpperCase();
  const param = env('SIM_API_PARAM', 'number');
  const headers = { Accept: 'application/json' };
  const params = {};
  if (key) {
    const keyParam = env('SIM_API_KEY_PARAM');
    if (keyParam) params[keyParam] = key;
    else { const scheme = env('SIM_API_AUTH_SCHEME', 'Bearer'); headers[env('SIM_API_AUTH_HEADER', 'Authorization')] = scheme ? `${scheme} ${key}` : key; }
  }
  let res;
  try {
    const cfg = { url, method, headers, timeout: Number(env('SIM_API_TIMEOUT', '10000')) || 10000, validateStatus: () => true };
    if (method === 'POST') { cfg.data = { [param]: number }; cfg.params = params; headers['Content-Type'] = 'application/json'; }
    else cfg.params = { ...params, [param]: number };
    res = await axios(cfg);
  } catch (err) {
    bot.logger?.warn({ code: err?.code }, 'sim: request failed'); // never log url/key/response
    return reply(box(['⚠️ Service temporarily unavailable.', '', 'Please try again later.']));
  }
  if (res.status === 404) return reply(box(['🔎 *SIM SEARCH*', '', '❌ No matching authorized record found.']));
  if (res.status < 200 || res.status >= 300 || typeof res.data !== 'object' || res.data === null) {
    bot.logger?.warn({ status: res.status }, 'sim: API returned an error');
    return reply(box(['⚠️ Service temporarily unavailable.', '', 'Please try again later.']));
  }

  const body = res.data;
  let rec = body.data ?? body.result ?? body.results ?? body;
  if (Array.isArray(rec)) rec = rec[0];
  const notFound = body.found === false || body.success === false || !rec || typeof rec !== 'object' || !Object.keys(rec).length;
  if (notFound) return reply(box(['🔎 *SIM SEARCH*', '', '❌ No matching authorized record found.']));

  const out = {
    number: pick(rec, env('SIM_MAP_NUMBER', 'number,mobile,msisdn,phone,sim')) || number,
    network: pick(rec, env('SIM_MAP_NETWORK', 'network,operator,carrier,company')),
    status: pick(rec, env('SIM_MAP_STATUS', 'status,state')),
  };
  const lines = ['🔎 *SIM SEARCH RESULT*', '', `📱 Number : ${out.number}`];
  if (out.network) lines.push(`📡 Network: ${out.network}`);
  if (out.status) lines.push(`🟢 Status : ${out.status}`);
  // Extra fields only when the owner switched them on in .env (SIM_SHOW_FIELDS=name,address …)
  for (const f of env('SIM_SHOW_FIELDS').split(',').map((x) => x.trim()).filter(Boolean)) {
    const v = pick(rec, f);
    if (v) lines.push(`▫️ ${f.split('.').pop()}: ${v.slice(0, 120)}`);
  }
  lines.push('', '🔐 Data provided through authorized API', '⚡ SAIF CHISHTI');
  return reply(box(lines));
}
