/**
 * Free-API commands (everything here comes from the public-apis list on GitHub).
 * `apiCommand(bot, c)` returns true when it handled the command; it is called from extraCmds.js.
 *
 *   MUSIC / VIDEO   .song  .video  .lyrics
 *   AI              .ask  .imagine  .dpai
 *   PROFILE PICS    .avatar  .robot
 *   ANIME           .anime  .animepic  .animegif  .findanime
 *   CALENDAR        .holiday  .nextholiday  .hijri  .namaz
 *   HEALTH          .food  .bmi  .drug
 *   FUN / UTILITY   .weather  .joke  .fact  .meme  .qr
 *   CONVERTERS      .toaudio  .tovideo  .toimg
 *   DEVELOPER       .apitest   (checks every service from the server)
 *
 * No key is needed for any of them. Optional keys / settings (all in .env, see .env.example):
 *   YTDLP_PATH, YTDLP_COOKIES, YTDLP_AUTO=off, COBALT_API_URL, COBALT_API_KEY, SAAVN_API_URL, VEROME_API_URL,
 *   FDC_API_KEY, CALENDARIFIC_KEY, IMGFLIP_USER, IMGFLIP_PASS, DEFAULT_COUNTRY, DEFAULT_CITY, HF_TOKEN, API_MAX_JOBS
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import axios from 'axios';
import { askText, imageFromPrompt } from './aiBrains.js';
import { findFfmpeg, runFfmpeg } from './tools.js';
import { cardOn, setCard, cardState, songCardText, aiCard } from './cards.js';

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TZ = () => env('BOT_TZ', 'Asia/Karachi');
const short = (e, n = 140) => String(e?.message || e || 'failed').replace(/\s+/g, ' ').replace(/(\/[\w.-]+){2,}/g, '…').slice(0, n);
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// ───────────────────────────── generic helpers ─────────────────────────────
const http = (url, opts = {}) => axios.get(url, { timeout: 20000, headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) }, validateStatus: () => true, ...opts, headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) } });
async function getJson(url, params, opts = {}) {
  const res = await http(url, { params, ...opts });
  if (res.status < 200 || res.status >= 300) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.data;
}
async function fetchBuf(url, { max = 60 * 1024 * 1024, headers = {}, timeout = 120000 } = {}) {
  const res = await axios.get(url, { responseType: 'arraybuffer', maxContentLength: max, maxBodyLength: max, timeout, headers: { 'User-Agent': UA, ...headers }, validateStatus: () => true });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return { buf: Buffer.from(res.data), type: String(res.headers['content-type'] || '') };
}
const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s).trim());
/** Only public http(s) links are passed to the downloader (no localhost / private networks). */
function safeUrl(s) {
  try {
    const u = new URL(String(s).trim());
    if (!/^https?:$/.test(u.protocol)) return false;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === '::1' || h.startsWith('[')) return false;
    return true;
  } catch { return false; }
}
function walk(o, fn, depth = 0, out = []) {
  if (o == null || depth > 7) return out;
  if (typeof o === 'object') { if (fn(o)) out.push(o); for (const v of Object.values(o)) walk(v, fn, depth + 1, out); }
  return out;
}
function allStrings(o, depth = 0, out = []) {
  if (o == null || depth > 7) return out;
  if (typeof o === 'string') out.push(o);
  else if (typeof o === 'object') for (const v of Object.values(o)) allStrings(v, depth + 1, out);
  return out;
}
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'api-'));
const rmTmp = (d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } };

// at most N heavy jobs (downloads / conversions) at the same time, so a small server is never overloaded
let jobs = 0;
const MAX_JOBS = () => Math.max(1, Number(env('API_MAX_JOBS', '2')) || 2);
async function withJob(reply, fn) {
  if (jobs >= MAX_JOBS()) return reply('⏳ The bot is busy with other downloads. Try again in a minute.');
  jobs += 1;
  try { return await fn(); } finally { jobs -= 1; }
}

// ───────────────────────────── quoted media ─────────────────────────────
const ctxOf = (msg) => { const m = msg?.message || {}; for (const v of Object.values(m)) if (v && typeof v === 'object' && v.contextInfo) return v.contextInfo; return null; };
const unwrap = (x) => x?.viewOnceMessage?.message || x?.viewOnceMessageV2?.message?.viewOnceMessage?.message || x?.viewOnceMessageV2?.message || x?.ephemeralMessage?.message || x;
/** The media of the replied-to message (or of the message itself, e.g. a video sent with the command as caption). */
function mediaOf(msg, chat) {
  const ctx = ctxOf(msg);
  const sources = [];
  const q = unwrap(ctx?.quotedMessage);
  if (q) sources.push({ m: q, holder: (type, node) => ({ key: { remoteJid: chat, id: ctx.stanzaId, participant: ctx.participant, fromMe: false }, message: { [type]: node } }) });
  const own = unwrap(msg?.message);
  if (own) sources.push({ m: own, holder: () => msg });
  for (const { m, holder } of sources) {
    for (const [type, kind] of [['imageMessage', 'image'], ['videoMessage', 'video'], ['audioMessage', 'audio'], ['stickerMessage', 'sticker'], ['documentMessage', 'document']]) {
      if (m?.[type]) return { kind, node: m[type], type, holder: holder(type, m[type]) };
    }
  }
  return null;
}
const quotedText = (msg) => { const q = unwrap(ctxOf(msg)?.quotedMessage); return q?.conversation || q?.extendedTextMessage?.text || q?.imageMessage?.caption || q?.videoMessage?.caption || ''; };
async function downloadMedia(bot, holder) {
  const { downloadMediaMessage } = await import('@itsliaaa/baileys');
  return downloadMediaMessage(holder, 'buffer', {}, { logger: bot.logger, reuploadRequest: bot.wa.sock?.updateMediaMessage?.bind(bot.wa.sock) });
}

// ───────────────────────────── yt-dlp (auto-downloaded when missing) ─────────────────────────────
const DATA = () => env('DATA_DIR', './data');
const BIN_DIR = () => path.join(DATA(), 'bin');
let ytdlpBin = null; let ytdlpTried = 0;
const works = (bin, args = ['--version']) => new Promise((res) => execFile(bin, args, { timeout: 25000 }, (err) => res(!err)));
async function getYtdlp() {
  if (ytdlpBin) return ytdlpBin;
  const local = path.join(BIN_DIR(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  for (const c of [env('YTDLP_PATH'), local, 'yt-dlp'].filter(Boolean)) if (await works(c)) return (ytdlpBin = c);
  if (env('YTDLP_AUTO', 'on').toLowerCase() === 'off' || Date.now() - ytdlpTried < 10 * 60000) return null;
  ytdlpTried = Date.now();
  // Download the official standalone build from GitHub once (needs no Python on Linux / Windows).
  const asset = process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos'
    : process.platform === 'linux' && process.arch === 'x64' ? 'yt-dlp_linux' : process.platform === 'linux' && process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp';
  try {
    fs.mkdirSync(BIN_DIR(), { recursive: true });
    const { buf } = await fetchBuf(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, { max: 80 * 1024 * 1024, timeout: 180000 });
    fs.writeFileSync(local, buf, { mode: 0o755 });
    try { fs.chmodSync(local, 0o755); } catch { /* ignore */ }
    if (await works(local)) return (ytdlpBin = local);
  } catch { /* offline / blocked */ }
  return null;
}
function runYtdlp(bin, args, timeout = 150000) {
  const base = ['--no-warnings', '--no-progress', '--no-playlist', '--socket-timeout', '20', '--retries', '2', '--ignore-config'];
  const cookies = env('YTDLP_COOKIES');
  if (cookies && fs.existsSync(cookies)) base.push('--cookies', cookies);
  const extra = env('YTDLP_EXTRA');
  if (extra) base.push(...extra.split(/\s+/).filter(Boolean));
  else base.push('--extractor-args', 'youtube:player_client=tv,mweb,ios,web_safari', '--force-ipv4');
  return new Promise((resolve, reject) => {
    execFile(bin, [...base, ...args], { timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const line = String(stderr || err.message).split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => /error/i.test(l)).pop() || String(stderr || err.message).slice(-160);
        return reject(new Error(line.replace(/^ERROR:\s*/i, '')));
      }
      resolve(String(stdout || ''));
    });
  });
}

// ───────────────────────────── YouTube search (no key) ─────────────────────────────
const VEROME = () => env('VEROME_API_URL', 'https://verome-api.deno.dev').replace(/\/$/, '');
const SAAVN = () => env('SAAVN_API_URL', 'https://saavn.dev/api').replace(/\/$/, '');
async function ytSearch(q) {
  try { // 1) Verome (YouTube Music / YouTube search API)
    const d = await getJson(`${VEROME()}/api/yt_search`, { q });
    const hit = walk(d, (o) => typeof (o.videoId || o.id) === 'string' && /^[\w-]{11}$/.test(o.videoId || o.id))[0];
    if (hit) return { id: hit.videoId || hit.id, title: hit.title || hit.name || q };
  } catch { /* next */ }
  try { const m = await mirrorSearch(q); if (m) return m; } catch { /* next */ }
  try { // 2) plain YouTube results page
    const res = await http('https://www.youtube.com/results', { params: { search_query: q, sp: 'EgIQAQ==' }, headers: { 'Accept-Language': 'en', Cookie: 'CONSENT=YES+1; SOCS=CAI' }, responseType: 'text' });
    const m = /"videoRenderer":\{"videoId":"([\w-]{11})"[\s\S]{0,1500}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/.exec(String(res.data));
    if (m) return { id: m[1], title: JSON.parse(`"${m[2]}"`) };
  } catch { /* none */ }
  return null;
}


// ───────────────────────────── YouTube mirrors: Piped + Invidious (public instances, no key) ─────────────────────────────
const listEnv = (k, d) => [...env(k).split(/[\s,;]+/).filter(Boolean), ...d].map((u) => u.replace(/\/$/, ''));
const PIPED = () => listEnv('PIPED_API_URLS', ['https://pipedapi.kavin.rocks', 'https://pipedapi.adminforge.de', 'https://api.piped.private.coffee', 'https://pipedapi.leptons.xyz']);
const INVIDIOUS = () => listEnv('INVIDIOUS_URLS', ['https://inv.nadeko.net', 'https://yewtu.be', 'https://invidious.nerdvpn.de']);
const ytId = (s) => (/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/.exec(String(s)) || [])[1] || '';
async function mirrorSearch(q) {
  for (const b of PIPED()) {
    try {
      const d = await getJson(`${b}/search`, { q, filter: 'videos' }, { timeout: 9000 });
      const it = (d?.items || []).find((x) => /watch\?v=([\w-]{11})/.test(x.url || ''));
      if (it) return { id: /v=([\w-]{11})/.exec(it.url)[1], title: it.title || q };
    } catch { /* next mirror */ }
  }
  for (const b of INVIDIOUS()) {
    try {
      const d = await getJson(`${b}/api/v1/search`, { q, type: 'video' }, { timeout: 9000 });
      const it = (Array.isArray(d) ? d : []).find((x) => x.videoId);
      if (it) return { id: it.videoId, title: it.title || q };
    } catch { /* next mirror */ }
  }
  return null;
}
/** kind = 'audio' | 'video' → a downloaded Buffer from the first mirror that works. */
async function mirrorStream(id, kind, title = '') {
  const errs = [];
  const grab = async (url, max) => { const { buf, type } = await fetchBuf(url, { max, timeout: 150000 }); if (buf.length < 50000 || /text|json|html/i.test(type)) throw new Error('not media'); return { buf, type }; };
  for (const b of PIPED()) {
    try {
      const d = await getJson(`${b}/streams/${id}`, {}, { timeout: 12000 });
      if (kind === 'audio') {
        const a = (d?.audioStreams || []).filter((x) => x.url).sort((x, y) => (/mp4|m4a/.test(y.mimeType || '') ? 1 : 0) - (/mp4|m4a/.test(x.mimeType || '') ? 1 : 0) || (y.bitrate || 0) - (x.bitrate || 0))[0];
        if (a) { const { buf, type } = await grab(a.url, 45 * 1024 * 1024); return { buf, ext: /webm|opus/.test(type + (a.mimeType || '')) ? 'webm' : 'm4a', title: d.title || title, artist: d.uploader || '', via: 'Piped' }; }
      } else {
        const v = (d?.videoStreams || []).filter((x) => x.url && !x.videoOnly && /mp4/.test(x.mimeType || '')).sort((x, y) => (y.height || 0) - (x.height || 0)).find((x) => (x.height || 360) <= 480) || (d?.videoStreams || []).find((x) => x.url && !x.videoOnly);
        if (v) { const { buf } = await grab(v.url, 60 * 1024 * 1024); return { buf, ext: 'mp4', title: d.title || title, via: 'Piped' }; }
      }
    } catch (e) { errs.push(short(e, 40)); }
  }
  for (const b of INVIDIOUS()) {
    try {
      const d = await getJson(`${b}/api/v1/videos/${id}`, { local: 'true' }, { timeout: 12000 });
      if (kind === 'audio') {
        const a = (d?.adaptiveFormats || []).filter((x) => /^audio/.test(x.type || '') && x.url).sort((x, y) => (/mp4/.test(y.type) ? 1 : 0) - (/mp4/.test(x.type) ? 1 : 0))[0];
        if (a) { const u = a.url.startsWith('http') ? a.url : b + a.url; const { buf } = await grab(u, 45 * 1024 * 1024); return { buf, ext: /webm/.test(a.type) ? 'webm' : 'm4a', title: d.title || title, artist: d.author || '', via: 'Invidious' }; }
      } else {
        const v = (d?.formatStreams || []).filter((x) => x.url && /mp4/.test(x.type || '')).pop();
        if (v) { const u = v.url.startsWith('http') ? v.url : b + v.url; const { buf } = await grab(u, 60 * 1024 * 1024); return { buf, ext: 'mp4', title: d.title || title, via: 'Invidious' }; }
      }
    } catch (e) { errs.push(short(e, 40)); }
  }
  throw new Error(`mirrors: ${errs.slice(0, 2).join(', ') || 'no stream'}`);
}
async function viaMirrors(q, kind) {
  let id = ytId(q); let title = '';
  if (!id) { const r = await mirrorSearch(q); if (!r) throw new Error('no search result'); id = r.id; title = r.title; }
  return mirrorStream(id, kind, title);
}

// ───────────────────────────── cobalt (optional self-hosted downloader API) ─────────────────────────────
async function cobalt(url, mode) {
  const base = env('COBALT_API_URL');
  if (!base) throw new Error('cobalt not configured');
  const res = await axios.post(base, mode === 'audio' ? { url, downloadMode: 'audio', audioFormat: 'mp3' } : { url, videoQuality: '480', youtubeVideoCodec: 'h264' }, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(env('COBALT_API_KEY') ? { Authorization: `Api-Key ${env('COBALT_API_KEY')}` } : {}) },
    timeout: 30000, validateStatus: () => true,
  });
  const d = res.data || {};
  if (!['tunnel', 'redirect'].includes(d.status) || !d.url) throw new Error(`cobalt: ${d.error?.code || d.status || res.status}`);
  const { buf, type } = await fetchBuf(d.url);
  return { buf, type, filename: d.filename || '' };
}

// ───────────────────────────── SONG ─────────────────────────────
const DIRECT_AUDIO = new Set(['m4a', 'mp3', 'aac', 'mp4', 'ogg', 'opus', 'oga']);
const MIME = { m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', ogg: 'audio/ogg; codecs=opus', opus: 'audio/ogg; codecs=opus', oga: 'audio/ogg' };

async function toMp3(buf, inExt) {
  const bin = await findFfmpeg();
  const d = mkTmp();
  try {
    const i = path.join(d, `in.${inExt || 'bin'}`); const o = path.join(d, 'out.mp3');
    fs.writeFileSync(i, buf);
    await runFfmpeg(bin, ['-y', '-i', i, '-vn', '-c:a', 'libmp3lame', '-q:a', '4', o]);
    return fs.readFileSync(o);
  } finally { rmTmp(d); }
}

async function songFromYtdlp(q) {
  const bin = await getYtdlp();
  if (!bin) throw new Error('yt-dlp is not installed (and could not be downloaded)');
  const d = mkTmp();
  try {
    const src = isUrl(q) ? q : `ytsearch1:${q}`;
    const out = await runYtdlp(bin, ['-f', 'bestaudio[ext=m4a]/bestaudio', '--max-filesize', '45M', '--match-filter', 'duration<=1500', '--no-simulate', '--print', '%(title)s\t%(uploader)s', '-o', path.join(d, 'a.%(ext)s'), src]);
    const f = fs.readdirSync(d).find((x) => x.startsWith('a.'));
    if (!f) throw new Error('nothing downloaded (video too long?)');
    const [title, artist] = out.trim().split('\n')[0].split('\t');
    return { buf: fs.readFileSync(path.join(d, f)), ext: f.split('.').pop().toLowerCase(), title, artist, via: 'yt-dlp' };
  } finally { rmTmp(d); }
}
async function songFromCobalt(q) {
  let url = q; let title = '';
  if (!isUrl(q)) { const r = await ytSearch(q); if (!r) throw new Error('no search result'); url = `https://www.youtube.com/watch?v=${r.id}`; title = r.title; }
  const { buf, filename } = await cobalt(url, 'audio');
  return { buf, ext: (filename.split('.').pop() || 'mp3').toLowerCase(), title: title || filename.replace(/\.[^.]+$/, ''), artist: '', via: 'cobalt' };
}
const SAAVN_HOSTS = () => [...new Set([SAAVN(), 'https://saavn.sumit.co/api', 'https://jiosaavn-api-privatecvc2.vercel.app'])];
async function songFromSaavn(q) {
  let lastE = 'not found on JioSaavn';
  for (const base of SAAVN_HOSTS()) {
    try {
      const d = await getJson(`${base}/search/songs`, { query: q, limit: 1 }, { timeout: 12000 });
      const s = d?.data?.results?.[0];
      const links = s?.downloadUrl || [];
      const last = links[links.length - 1] || links[0];
      const link = last?.url || last?.link;
      if (!link) continue;
      const { buf } = await fetchBuf(link, { max: 45 * 1024 * 1024 });
      return { buf, ext: 'mp4', title: s.name, artist: (s.artists?.primary || []).map((a) => a.name).join(', ') || s.primaryArtists || '', via: 'JioSaavn' };
    } catch (e) { lastE = short(e, 60); }
  }
  throw new Error(lastE);
}
async function songFromVerome(q) {
  const r = await ytSearch(q);
  if (!r) throw new Error('no search result');
  const d = await getJson(`${VEROME()}/api/stream`, { id: r.id });
  const urls = allStrings(d).filter((s) => /^https?:\/\//.test(s));
  for (const u of urls.slice(0, 4)) {
    try { const { buf, type } = await fetchBuf(u, { max: 45 * 1024 * 1024 }); if (buf.length > 50000 && !/text|json|html/i.test(type)) return { buf, ext: /mpeg|mp3/.test(type) ? 'mp3' : /webm/.test(type) ? 'webm' : 'm4a', title: r.title, artist: '', via: 'Verome' }; } catch { /* next url */ }
  }
  throw new Error('no playable stream');
}
// Chishti-bot method (copied from chisti-ka-bot): search YouTube → ask the Bandaheali ytmp3 API for an mp3 link → download it.
// BANDAHEALI_API / BANDAHEALI_KEY can be changed in .env; defaults are the ones the Chishti bot uses.
async function songFromBandaheali(q) {
  let url = '', title = q, ytMeta = null;
  if (isUrl(q)) { url = q; title = ''; }
  else {
    try { // yt-search package (same as the Chishti bot) — optional, falls back to the built-in search if not installed
      const yts = (await import('yt-search')).default;
      const v = (await yts(q))?.videos?.[0];
      if (v) { url = v.url; title = v.title || q; ytMeta = { thumb: v.thumbnail, author: v.author?.name, views: v.views, duration: v.timestamp }; }
    } catch { /* package missing → built-in search below */ }
    if (!url) { const r = await ytSearch(q); if (!r) throw new Error('no search result'); url = `https://www.youtube.com/watch?v=${r.id}`; title = r.title || q; }
  }
  const base = env('BANDAHEALI_API', 'https://bandaheali-apis.netlify.app/api/downloader/ytmp3');
  const d = await getJson(base, { url, key: env('BANDAHEALI_KEY', 'bandaheali') }, { timeout: 60000 });
  if (!(d?.status === true || d?.status === 'true' || d?.success) || !d?.result) throw new Error(`API: ${short(d?.message || 'bad response', 60)}`);
  const audio = d.result.audio_url || d.result.mp3_url || d.result.url || d.result.download;
  if (!audio || !isUrl(audio)) throw new Error('API gave no audio link');
  const { buf, type } = await fetchBuf(audio, { max: 60 * 1024 * 1024 });
  if (buf.length < 50000 || /text|json|html/i.test(type)) throw new Error('API link did not return audio');
  const id = ytId(url);
  return { buf, ext: 'mp3', title: d.result.title || title, artist: '', via: 'Chishti API', url, meta: { thumb: ytMeta?.thumb || d.result.thumbnail || d.result.thumb || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : ''), author: ytMeta?.author || d.result.author || d.result.channel || '', views: ytMeta?.views ?? d.result.views, duration: ytMeta?.duration || d.result.duration || '' } };
}
async function getSong(q) {
  const errs = [];
  const chain = [['Chishti API', songFromBandaheali], ['yt-dlp', songFromYtdlp], ...(env('COBALT_API_URL') ? [['cobalt', songFromCobalt]] : []), ...(isUrl(q) ? [] : [['JioSaavn', songFromSaavn]]), ['Piped/Invidious', (x) => viaMirrors(x, 'audio')], ...(isUrl(q) ? [] : [['Verome', songFromVerome]])];
  for (const [name, fn] of chain) {
    try { const r = await fn(q); if (r?.buf?.length) return r; } catch (e) { errs.push(`${name}: ${short(e, 90)}`); }
  }
  throw new Error(errs.join(' | ') || 'no source worked');
}

// ───────────────────────────── VIDEO ─────────────────────────────
async function videoFromYtdlp(q) {
  const bin = await getYtdlp();
  if (!bin) throw new Error('yt-dlp is not installed (and could not be downloaded)');
  const d = mkTmp();
  try {
    const src = isUrl(q) ? q : `ytsearch1:${q}`;
    const out = await runYtdlp(bin, ['-f', '18/best[height<=480][ext=mp4]/best[height<=480]/best[ext=mp4]/best', '--max-filesize', '60M', '--match-filter', 'duration<=900', '--no-simulate', '--print', '%(title)s', '-o', path.join(d, 'v.%(ext)s'), src], 240000);
    const f = fs.readdirSync(d).find((x) => x.startsWith('v.'));
    if (!f) throw new Error('nothing downloaded (video too long / too big?)');
    return { buf: fs.readFileSync(path.join(d, f)), ext: f.split('.').pop().toLowerCase(), title: out.trim().split('\n')[0], via: 'yt-dlp' };
  } finally { rmTmp(d); }
}
async function videoFromCobalt(q) {
  let url = q; let title = '';
  if (!isUrl(q)) { const r = await ytSearch(q); if (!r) throw new Error('no search result'); url = `https://www.youtube.com/watch?v=${r.id}`; title = r.title; }
  const { buf, filename } = await cobalt(url, 'video');
  return { buf, ext: (filename.split('.').pop() || 'mp4').toLowerCase(), title: title || filename.replace(/\.[^.]+$/, ''), via: 'cobalt' };
}
async function getVideo(q) {
  const errs = [];
  for (const [name, fn] of [['yt-dlp', videoFromYtdlp], ...(env('COBALT_API_URL') ? [['cobalt', videoFromCobalt]] : []), ['Piped/Invidious', (x) => viaMirrors(x, 'video')]]) {
    try { const r = await fn(q); if (r?.buf?.length) return r; } catch (e) { errs.push(`${name}: ${short(e, 90)}`); }
  }
  throw new Error(errs.join(' | ') || 'no source worked');
}

// ───────────────────────────── lyrics ─────────────────────────────
async function getLyrics(q) {
  try {
    const d = await getJson('https://lrclib.net/api/search', { q });
    const hit = (Array.isArray(d) ? d : []).find((x) => x.plainLyrics);
    if (hit) return { title: hit.trackName, artist: hit.artistName, text: hit.plainLyrics, via: 'LRCLIB' };
  } catch { /* next */ }
  const m = /^(.+?)\s*[-–—]\s*(.+)$/.exec(q);
  if (m) {
    try {
      const d = await getJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`);
      if (d?.lyrics) return { title: m[2], artist: m[1], text: d.lyrics, via: 'lyrics.ovh' };
    } catch { /* none */ }
  }
  return null;
}

// ───────────────────────────── misc service helpers ─────────────────────────────
const COUNTRY_NAMES = { pk: 'Pakistan', in: 'India', us: 'United States', gb: 'United Kingdom', uk: 'United Kingdom', sa: 'Saudi Arabia', ae: 'United Arab Emirates', bd: 'Bangladesh', tr: 'Turkey', ca: 'Canada', au: 'Australia', de: 'Germany', fr: 'France' };
const fmtDate = (iso) => { try { return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch { return iso; } };
const to12 = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t)); if (!m) return t; let h = Number(m[1]); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${m[2]} ${ap}`; };
const todayParts = () => { const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ(), day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(new Date()); const g = (t) => f.find((p) => p.type === t).value; return { d: g('day'), m: g('month'), y: g('year') }; };
const DRUG_SYN = { paracetamol: 'acetaminophen', panadol: 'acetaminophen', calpol: 'acetaminophen', brufen: 'ibuprofen', disprin: 'aspirin', augmentin: 'amoxicillin and clavulanate', flagyl: 'metronidazole', ventolin: 'albuterol', salbutamol: 'albuterol' };
const AVATAR_STYLES = ['adventurer', 'avataaars', 'big-smile', 'bottts', 'croodles', 'fun-emoji', 'lorelei', 'micah', 'miniavs', 'notionists', 'personas', 'pixel-art', 'thumbs'];
const WAIFU_CATS = ['waifu', 'neko', 'shinobu', 'megumin', 'cuddle', 'cry', 'hug', 'pat', 'smug', 'bonk', 'blush', 'smile', 'wave', 'highfive', 'nom', 'happy', 'wink', 'poke', 'dance', 'cringe', 'slap', 'kiss', 'kill', 'bite', 'bully', 'lick', 'yeet', 'handhold', 'glomp', 'awoo'];


// ───────────────────────────── anime info: Jikan → AniList → Kitsu (any one that answers) ─────────────────────────────
const stripHtml = (t) => String(t || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
async function animeInfo(q) {
  try {
    const d = await getJson('https://api.jikan.moe/v4/anime', { q, limit: 1, sfw: true }, { timeout: 10000 });
    const a = d?.data?.[0];
    if (a) return { title: a.title_english || a.title, jp: a.title_japanese, score: a.score, type: a.type, eps: a.episodes, year: a.year, status: a.status, genres: (a.genres || []).map((g) => g.name), synopsis: a.synopsis, url: a.url, img: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url };
  } catch { /* next */ }
  try {
    const res = await axios.post('https://graphql.anilist.co', { query: 'query($s:String){Media(search:$s,type:ANIME){title{english romaji native} averageScore format episodes seasonYear status genres description(asHtml:false) siteUrl coverImage{large}}}', variables: { s: q } }, { timeout: 12000, validateStatus: () => true });
    const a = res.data?.data?.Media;
    if (a) return { title: a.title.english || a.title.romaji, jp: a.title.native, score: a.averageScore ? (a.averageScore / 10).toFixed(1) : null, type: a.format, eps: a.episodes, year: a.seasonYear, status: a.status, genres: a.genres || [], synopsis: stripHtml(a.description), url: a.siteUrl, img: a.coverImage?.large };
  } catch { /* next */ }
  try {
    const d = await getJson('https://kitsu.io/api/edge/anime', { 'filter[text]': q, 'page[limit]': 1 }, { timeout: 12000, headers: { Accept: 'application/vnd.api+json' } });
    const a = d?.data?.[0]?.attributes;
    if (a) return { title: a.titles?.en || a.titles?.en_jp || a.canonicalTitle, jp: a.titles?.ja_jp, score: a.averageRating ? (Number(a.averageRating) / 10).toFixed(1) : null, type: a.subtype, eps: a.episodeCount, year: String(a.startDate || '').slice(0, 4), status: a.status, genres: [], synopsis: a.synopsis, url: `https://kitsu.io/anime/${d.data[0].id}`, img: a.posterImage?.large || a.posterImage?.original };
  } catch { /* none */ }
  return null;
}

async function gifToMp4(buf) {
  const bin = await findFfmpeg();
  const d = mkTmp();
  try {
    const i = path.join(d, 'in.gif'); const o = path.join(d, 'out.mp4');
    fs.writeFileSync(i, buf);
    await runFfmpeg(bin, ['-y', '-i', i, '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-an', o]);
    return fs.readFileSync(o);
  } finally { rmTmp(d); }
}

// ───────────────────────────── command entry ─────────────────────────────
export async function apiCommand(bot, c) {
  const { cmd, argText, msg, groupJid, reply, isAuth, P } = c;
  const sock = () => { bot.wa._assertOpen?.(); return bot.wa.sock; };
  const q = String(argText || '').trim();
  const toks = q.split(/\s+/).filter(Boolean);
  const sendImg = (image, caption) => sock().sendMessage(groupJid, { image, caption: caption || undefined }, { quoted: msg });

  try {
    switch (cmd) {
      // ───────────────────────── .song <name or link> ─────────────────────────
      case 'song': case 'play': case 'gana': case 'music': {
        const name = q || quotedText(msg).trim();
        if (!name) return reply(`🎵 Usage: ${P}song <song name>\nExample: ${P}song tum hi ho\nYou can also paste a YouTube link.`), true;
        if (isUrl(name) && !safeUrl(name)) return reply('❌ That link is not allowed.'), true;
        await withJob(reply, async () => {
          await reply(`🔎 Searching *${clip(name, 60)}* …`);
          const r = await getSong(clip(name, 120));
          let { buf, ext } = r;
          if (!DIRECT_AUDIO.has(ext)) { buf = await toMp3(buf, ext); ext = 'mp3'; }
          if (buf.length > 60 * 1024 * 1024) throw new Error('file is too big');
          if (cardOn('songcard')) { // song card ON → thumbnail + details first (like the Chishti bot); OFF → audio only
            const info = { title: clip(r.title || name, 90), author: r.meta?.author || r.artist, views: r.meta?.views, duration: r.meta?.duration, url: r.url, via: r.via };
            const cap = songCardText(info);
            if (r.meta?.thumb) await sock().sendMessage(groupJid, { image: { url: r.meta.thumb }, caption: cap }, { quoted: msg }).catch(() => reply(cap));
            else await reply(cap);
          }
          await sock().sendMessage(groupJid, { audio: buf, mimetype: MIME[ext] || 'audio/mpeg', ptt: false, fileName: `${clip(r.title || 'song', 60).replace(/[\\/:*?"<>|]/g, '')}.${ext === 'mp4' ? 'm4a' : ext}` }, { quoted: msg });
        });
        return true;
      }

      // ───────────────────────── .video <name or link> ─────────────────────────
      case 'video': case 'ytv': case 'vid': {
        const name = q || quotedText(msg).trim();
        if (!name) return reply(`🎬 Usage: ${P}video <name or link>\nExample: ${P}video funny cats\nWorks with YouTube, Instagram, TikTok, Facebook links too (max 15 min).`), true;
        if (isUrl(name) && !safeUrl(name)) return reply('❌ That link is not allowed.'), true;
        await withJob(reply, async () => {
          await reply(`🔎 Fetching *${clip(name, 60)}* …`);
          const r = await getVideo(clip(name, 300));
          if (r.buf.length > 60 * 1024 * 1024) throw new Error('video is too big');
          const cap = `🎬 ${clip(r.title || name, 100)}\n_via ${r.via}_`;
          if (r.buf.length > 28 * 1024 * 1024) await sock().sendMessage(groupJid, { document: r.buf, mimetype: 'video/mp4', fileName: `${clip(r.title || 'video', 60).replace(/[\\/:*?"<>|]/g, '')}.mp4`, caption: cap }, { quoted: msg });
          else await sock().sendMessage(groupJid, { video: r.buf, mimetype: 'video/mp4', caption: cap }, { quoted: msg });
        });
        return true;
      }

      // ───────────────────────── .lyrics <song> ─────────────────────────
      case 'lyrics': case 'lyric': {
        const name = q || quotedText(msg).trim();
        if (!name) return reply(`📜 Usage: ${P}lyrics <song name>   (or  artist - title)`), true;
        const r = await getLyrics(name);
        if (!r) return reply('🤷 No lyrics found. Try: artist - title'), true;
        await reply(`📜 *${r.title}* — ${r.artist}\n\n${clip(r.text.trim(), 3500)}\n\n_via ${r.via}_`);
        return true;
      }

      // ───────────────────────── .ask <question> (free AI brains) ─────────────────────────
      case 'ask': case 'ai': case 'gpt': {
        const ctxT = quotedText(msg).trim();
        const prompt = [ctxT && `Context (the message being replied to): ${clip(ctxT, 800)}`, q].filter(Boolean).join('\n\n');
        if (!prompt) return reply(`🤖 Usage: ${P}ask <your question>   (or reply to a message with ${P}ask)`), true;
        const r = await askText(prompt, { logger: bot.logger });
        if (!r.text) return reply(r.error === 'nokey' ? '⚙️ Koi free AI key set nahi hai. .env mein GROQ_API_KEY (console.groq.com) ya GEMINI_API_KEY (aistudio.google.com) ya CEREBRAS_API_KEY daalo — free hain — phir restart.' : `⏳ Sab free AI abhi busy hain, ek minute baad dobara try karo.\n(${clip(r.error || '', 100)})`), true;
        await reply(cardOn('aicard') ? aiCard(clip(r.text.trim(), 3500)) : `🤖 ${clip(r.text.trim(), 3500)}`);
        return true;
      }

      // ───────────────────────── .imagine <description>  /  .dpai <description> ─────────────────────────
      case 'imagine': case 'draw': case 'dpai': {
        const base = q || quotedText(msg).trim();
        if (!base) return reply(`🎨 Usage: ${P}${cmd} <describe the picture>\nExample: ${P}${cmd} a lion with golden crown, cinematic`), true;
        await withJob(reply, async () => {
          await reply('🎨 Drawing … (up to a minute)');
          const prompt = cmd === 'dpai' ? `profile picture, centered portrait, clean background, high quality, ${base}` : base;
          const buf = await imageFromPrompt(clip(prompt, 400), { width: 1024, height: 1024, logger: bot.logger });
          await sendImg(buf, `🎨 ${clip(base, 120)}`);
        });
        return true;
      }

      // ───────────────────────── .avatar [style] [name] / .robot [name] ─────────────────────────
      case 'avatar': case 'pfp': {
        let style = 'adventurer';
        const t = [...toks];
        if (t[0] && AVATAR_STYLES.includes(t[0].toLowerCase())) style = t.shift().toLowerCase();
        if (!t.length && !toks.length) style = pick(AVATAR_STYLES);
        const seed = t.join(' ') || String(Math.floor(Math.random() * 1e9));
        const { buf } = await fetchBuf(`https://api.dicebear.com/9.x/${style}/png?seed=${encodeURIComponent(seed)}&size=512&backgroundColor=b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf`);
        await sendImg(buf, `🖼️ *${style}* avatar for “${clip(seed, 40)}”\nStyles: ${AVATAR_STYLES.join(', ')}\nUse: ${P}avatar <style> <name>`);
        return true;
      }
      case 'robot': case 'robohash': {
        const seed = q || String(Math.floor(Math.random() * 1e9));
        const { buf } = await fetchBuf(`https://robohash.org/${encodeURIComponent(seed)}.png?size=512x512&set=set${1 + Math.floor(Math.random() * 4)}`);
        await sendImg(buf, `🤖 Robot for “${clip(seed, 40)}”`);
        return true;
      }

      // ───────────────────────── anime ─────────────────────────
      case 'anime': {
        if (!q) return reply(`🎌 Usage: ${P}anime <name>   e.g. ${P}anime naruto`), true;
        const a = await animeInfo(q);
        if (!a) return reply('🤷 Anime nahi mila (ya teeno anime sites abhi busy hain). Thori der baad try karo.'), true;
        const cap = `🎌 *${a.title}*${a.jp ? ` (${a.jp})` : ''}\n⭐ ${a.score ?? '—'}  ·  📺 ${a.type || '—'}  ·  🎞️ ${a.eps ?? '?'} eps  ·  📅 ${a.year || '—'}\n📌 ${a.status || ''}\n🏷️ ${(a.genres || []).join(', ')}\n\n${clip(a.synopsis || '', 600)}\n\n🔗 ${a.url}`;
        const img = a.img;
        if (img) await sendImg({ url: img }, cap); else await reply(cap);
        return true;
      }
      case 'animepic': case 'waifu': {
        const cat = (toks[0] || 'waifu').toLowerCase();
        if (!WAIFU_CATS.includes(cat)) return reply(`🎌 Usage: ${P}animepic <type>\nTypes: ${WAIFU_CATS.join(', ')}`), true;
        const d = await getJson(`https://api.waifu.pics/sfw/${cat}`);
        if (!d?.url) throw new Error('no picture');
        if (/\.gif$/i.test(d.url)) {
          try { const { buf } = await fetchBuf(d.url, { max: 20 * 1024 * 1024 }); await sock().sendMessage(groupJid, { video: await gifToMp4(buf), gifPlayback: true, caption: `🎌 ${cat}` }, { quoted: msg }); return true; } catch { /* send as picture below */ }
        }
        await sendImg({ url: d.url }, `🎌 ${cat}`);
        return true;
      }
      case 'animegif': {
        const cat = (toks[0] || pick(['hug', 'pat', 'smile', 'dance', 'wave', 'laugh'])).toLowerCase().replace(/[^a-z]/g, '');
        const d = await getJson(`https://nekos.best/api/v2/${cat}`).catch(() => null);
        const r = d?.results?.[0];
        if (!r?.url) return reply(`🎌 Usage: ${P}animegif <hug|pat|slap|smile|dance|cry|wave|laugh|kiss|poke|bite|blush|cuddle|happy|highfive|kick|punch|sleep|think|wink|yawn>`), true;
        const { buf } = await fetchBuf(r.url, { max: 20 * 1024 * 1024 });
        let out = null;
        try { out = await gifToMp4(buf); } catch { /* no ffmpeg */ }
        if (out) await sock().sendMessage(groupJid, { video: out, gifPlayback: true, caption: `🎌 ${cat}${r.anime_name ? ` — ${r.anime_name}` : ''}` }, { quoted: msg });
        else await sendImg(buf, `🎌 ${cat}`);
        return true;
      }
      case 'findanime': case 'whatanime': {
        const m = mediaOf(msg, groupJid);
        if (!m || !['image', 'sticker', 'video'].includes(m.kind)) return reply(`🔎 Reply to an anime screenshot with ${P}findanime`), true;
        const buf = await downloadMedia(bot, m.holder);
        const res = await axios.post('https://api.trace.moe/search?anilistInfo', buf, { headers: { 'Content-Type': m.kind === 'video' ? 'video/mp4' : 'image/jpeg' }, timeout: 40000, validateStatus: () => true, maxBodyLength: 20 * 1024 * 1024 });
        const r = res.data?.result?.[0];
        if (!r) return reply('🤷 Could not recognise that scene.'), true;
        const t = r.anilist?.title || {};
        const sim = Math.round((r.similarity || 0) * 1000) / 10;
        const mm = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
        await reply(`🔎 *${t.english || t.romaji || t.native || r.filename}*\n📺 Episode: ${r.episode ?? '?'}  ·  ⏱️ ${mm(r.from || 0)}\n🎯 Match: ${sim}%${sim < 85 ? ' (low — may be wrong)' : ''}`);
        return true;
      }

      // ───────────────────────── calendar ─────────────────────────
      case 'holiday': case 'holidays': case 'nextholiday': {
        const cc = (toks.find((x) => /^[a-z]{2}$/i.test(x)) || env('DEFAULT_COUNTRY', 'PK')).toUpperCase();
        const year = toks.find((x) => /^20\d\d$/.test(x)) || todayParts().y;
        let list;
        try {
          list = cmd === 'nextholiday' ? await getJson(`https://date.nager.at/api/v3/NextPublicHolidays/${cc}`) : await getJson(`https://date.nager.at/api/v3/PublicHolidays/${year}/${cc}`);
        } catch (e) {
          if (env('CALENDARIFIC_KEY')) {
            const d = await getJson('https://calendarific.com/api/v2/holidays', { api_key: env('CALENDARIFIC_KEY'), country: cc, year });
            list = (d?.response?.holidays || []).map((h) => ({ date: h.date?.iso?.slice(0, 10), localName: h.name, name: h.name }));
          } else return reply(`📅 No holiday data for *${cc}* (${short(e, 40)}).\nFor more countries add a free CALENDARIFIC_KEY to .env (calendarific.com).`), true;
        }
        if (!list?.length) return reply('📅 No holidays found.'), true;
        const rows = (cmd === 'nextholiday' ? list.slice(0, 5) : list).slice(0, 40).map((h) => `• ${fmtDate(h.date)} — ${h.localName === h.name ? h.name : `${h.name} (${h.localName})`}`);
        await reply(`📅 *${cmd === 'nextholiday' ? 'Upcoming' : `${year}`} holidays — ${COUNTRY_NAMES[cc.toLowerCase()] || cc}*\n${rows.join('\n')}`);
        return true;
      }
      case 'hijri': case 'islamicdate': {
        const t = todayParts();
        const d = await getJson(`https://api.aladhan.com/v1/gToH/${t.d}-${t.m}-${t.y}`);
        const h = d?.data?.hijri;
        if (!h) throw new Error('no data');
        await reply(`🌙 *Islamic date*\n${h.weekday?.en || ''}, ${h.day} ${h.month?.en} ${h.year} AH\n📅 ${t.d}-${t.m}-${t.y}\n_Moon sighting in Pakistan can differ by ±1 day._`);
        return true;
      }
      case 'namaz': case 'prayer': case 'salah': {
        const [city0, country0] = (q || env('DEFAULT_CITY', 'Karachi')).split(',').map((x) => x.trim());
        const country = country0 || (q ? '' : env('DEFAULT_COUNTRY_NAME', 'Pakistan')) || 'Pakistan';
        const d = await getJson('https://api.aladhan.com/v1/timingsByCity', { city: city0, country, method: 1 });
        const tm = d?.data?.timings;
        if (!tm) throw new Error('city not found');
        await reply(`🕌 *Prayer times — ${city0}${country ? `, ${country}` : ''}*\n${d.data.date?.readable || ''}  ·  ${d.data.date?.hijri?.day} ${d.data.date?.hijri?.month?.en} ${d.data.date?.hijri?.year} AH\n\n🌅 Fajr: *${to12(tm.Fajr)}*\n☀️ Sunrise: ${to12(tm.Sunrise)}\n🕛 Dhuhr: *${to12(tm.Dhuhr)}*\n🌤️ Asr: *${to12(tm.Asr)}*\n🌇 Maghrib: *${to12(tm.Maghrib)}*\n🌙 Isha: *${to12(tm.Isha)}*\n_Method: Univ. of Islamic Sciences, Karachi_`);
        return true;
      }

      // ───────────────────────── health ─────────────────────────
      case 'food': case 'calories': case 'nutrition': {
        if (!q) return reply(`🥗 Usage: ${P}food <food name in English>   e.g. ${P}food banana`), true;
        const d = await getJson('https://api.nal.usda.gov/fdc/v1/foods/search', { query: q, pageSize: 1, api_key: env('FDC_API_KEY', 'DEMO_KEY') });
        const f = d?.foods?.[0];
        if (!f) return reply('🤷 Food not found. Try the English name.'), true;
        const n = (re) => (f.foodNutrients || []).find((x) => re.test(x.nutrientName || ''));
        const val = (re, unit) => { const x = n(re); return x ? `${Math.round(x.value * 10) / 10} ${unit}` : '—'; };
        await reply(`🥗 *${clip(f.description, 80)}*\n_per 100 g_\n🔥 Calories: *${val(/^Energy$/i, 'kcal')}*\n💪 Protein: ${val(/^Protein/i, 'g')}\n🍞 Carbs: ${val(/^Carbohydrate/i, 'g')}\n🧈 Fat: ${val(/^Total lipid/i, 'g')}\n🌾 Fibre: ${val(/^Fiber/i, 'g')}\n🍬 Sugar: ${val(/^Sugars, total/i, 'g')}\n_Source: USDA FoodData Central_`);
        return true;
      }
      case 'bmi': {
        const nums = (q.match(/\d+(\.\d+)?/g) || []).map(Number);
        if (nums.length < 2) return reply(`⚖️ Usage: ${P}bmi <weight kg> <height cm>   e.g. ${P}bmi 70 175`), true;
        const [kg, cm] = nums;
        if (kg < 10 || kg > 400 || cm < 80 || cm > 250) return reply('⚖️ Check the numbers: weight in kg, height in cm.'), true;
        const v = kg / ((cm / 100) ** 2);
        const cat = v < 18.5 ? 'Underweight' : v < 25 ? 'Normal' : v < 30 ? 'Overweight' : 'Obese';
        await reply(`⚖️ *BMI: ${v.toFixed(1)}* — ${cat}\n${kg} kg · ${cm} cm\n_General guide only, not medical advice._`);
        return true;
      }
      case 'drug': case 'medicine': {
        if (!q) return reply(`💊 Usage: ${P}drug <medicine name>   e.g. ${P}drug paracetamol`), true;
        const name = DRUG_SYN[q.toLowerCase()] || q;
        let r = null;
        for (const field of ['openfda.generic_name', 'openfda.brand_name', 'openfda.substance_name']) {
          const d = await getJson('https://api.fda.gov/drug/label.json', { search: `${field}:"${name}"`, limit: 1 }).catch(() => null);
          if (d?.results?.[0]) { r = d.results[0]; break; }
        }
        if (!r) return reply('🤷 Not found in the US FDA database. Try the generic (salt) name.'), true;
        const one = (a) => clip(String((a || [])[0] || '—').replace(/\s+/g, ' '), 380);
        await reply(`💊 *${(r.openfda?.generic_name || [name])[0]}*${r.openfda?.brand_name ? `  (${r.openfda.brand_name.slice(0, 3).join(', ')})` : ''}\n\n*Used for:* ${one(r.indications_and_usage)}\n\n*Warnings:* ${one(r.warnings || r.warnings_and_cautions)}\n\n_US FDA label — general information only. Ask a doctor/pharmacist before taking any medicine._`);
        return true;
      }

      // ───────────────────────── fun / utility ─────────────────────────
      case 'weather': case 'mausam': {
        const city = q || env('DEFAULT_CITY', 'Karachi');
        const d = await getJson(`https://wttr.in/${encodeURIComponent(city)}`, { format: 'j1' });
        const cur = d?.current_condition?.[0];
        if (!cur) throw new Error('city not found');
        const area = d.nearest_area?.[0]?.areaName?.[0]?.value || city;
        const days = (d.weather || []).slice(0, 3).map((w) => `• ${w.date}: ${w.mintempC}°–${w.maxtempC}°C, ${w.hourly?.[4]?.weatherDesc?.[0]?.value || ''}`).join('\n');
        await reply(`🌤️ *${area}*\n🌡️ ${cur.temp_C}°C (feels ${cur.FeelsLikeC}°C)  ·  ${cur.weatherDesc?.[0]?.value || ''}\n💧 Humidity ${cur.humidity}%  ·  💨 Wind ${cur.windspeedKmph} km/h\n\n${days}`);
        return true;
      }
      case 'joke': {
        const d = await getJson('https://v2.jokeapi.dev/joke/Any', { blacklistFlags: 'nsfw,religious,political,racist,sexist,explicit' });
        await reply(`😂 ${d.type === 'twopart' ? `${d.setup}\n\n👉 ${d.delivery}` : d.joke}`);
        return true;
      }
      case 'fact': {
        const d = await getJson('https://uselessfacts.jsph.pl/api/v2/facts/random', { language: 'en' });
        await reply(`💡 ${d.text}`);
        return true;
      }
      case 'meme': {
        const d = await getJson('https://api.imgflip.com/get_memes');
        const memes = d?.data?.memes || [];
        if (!memes.length) throw new Error('no memes');
        const m = pick(memes.slice(0, 60));
        const [top, bottom] = q.split(/[;|]/).map((x) => x.trim());
        if (q && env('IMGFLIP_USER') && env('IMGFLIP_PASS')) {
          const body = new URLSearchParams({ template_id: m.id, username: env('IMGFLIP_USER'), password: env('IMGFLIP_PASS'), text0: top || '', text1: bottom || '' });
          const r = await axios.post('https://api.imgflip.com/caption_image', body, { timeout: 20000 });
          if (r.data?.success) { await sendImg({ url: r.data.data.url }, `😂 ${m.name}`); return true; }
        }
        await sendImg({ url: m.url }, `😂 ${m.name}${q ? '\n(captions need IMGFLIP_USER / IMGFLIP_PASS in .env)' : ''}`);
        return true;
      }
      case 'qr': {
        const text = q || quotedText(msg).trim();
        if (!text) return reply(`▦ Usage: ${P}qr <text or link>`), true;
        const QR = (await import('qrcode')).default;
        await sendImg(await QR.toBuffer(clip(text, 800), { width: 512, margin: 2 }), `▦ ${clip(text, 80)}`);
        return true;
      }

      // ───────────────────────── converters ─────────────────────────
      case 'toaudio': case 'tomp3': {
        const m = mediaOf(msg, groupJid);
        if (!m || !['video', 'audio'].includes(m.kind)) return reply(`🎧 Reply to a *video* (or voice note) with ${P}toaudio\nAdd the word *voice* to get a voice note: ${P}toaudio voice`), true;
        if (Number(m.node.seconds || 0) > 900) return reply('⏱️ Longer than 15 minutes.'), true;
        await withJob(reply, async () => {
          const buf = await downloadMedia(bot, m.holder);
          const mp3 = await toMp3(buf, m.kind === 'video' ? 'mp4' : 'ogg');
          if (/voice|ptt|note/i.test(q)) await bot.wa.sendVoice(groupJid, mp3);
          else await sock().sendMessage(groupJid, { audio: mp3, mimetype: 'audio/mpeg', ptt: false }, { quoted: msg });
        });
        return true;
      }
      case 'tovideo': case 'tomp4': {
        const m = mediaOf(msg, groupJid);
        if (!m || !['audio', 'image', 'sticker'].includes(m.kind)) return reply(`🎬 Reply to a *voice note / audio* (waveform video), a *photo* or a *sticker* with ${P}tovideo`), true;
        await withJob(reply, async () => {
          const buf = await downloadMedia(bot, m.holder);
          const bin = await findFfmpeg();
          const d = mkTmp();
          try {
            const o = path.join(d, 'out.mp4');
            if (m.kind === 'audio') {
              const i = path.join(d, 'in.audio'); fs.writeFileSync(i, buf);
              await runFfmpeg(bin, ['-y', '-t', '300', '-i', i, '-filter_complex', '[0:a]showwaves=s=640x360:mode=cline:colors=0x25D366,format=yuv420p[v]', '-map', '[v]', '-map', '0:a', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', o]);
            } else {
              const i = path.join(d, 'in.webp'); fs.writeFileSync(i, buf);
              let animated = false;
              try { const sharp = (await import('sharp')).default; const md = await sharp(buf, { animated: true }).metadata(); animated = (md.pages || 1) > 1; if (!animated) { fs.writeFileSync(path.join(d, 'in.png'), await sharp(buf).png().toBuffer()); } } catch { /* ffmpeg decides */ }
              if (animated) await runFfmpeg(bin, ['-y', '-i', i, '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-an', o]);
              else {
                const still = fs.existsSync(path.join(d, 'in.png')) ? path.join(d, 'in.png') : i;
                await runFfmpeg(bin, ['-y', '-loop', '1', '-t', '6', '-i', still, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-r', '25', '-an', '-movflags', '+faststart', o]);
              }
            }
            await sock().sendMessage(groupJid, { video: fs.readFileSync(o), mimetype: 'video/mp4', caption: '🎬 Done' }, { quoted: msg });
          } finally { rmTmp(d); }
        });
        return true;
      }
      case 'toimg': case 'topng': {
        const m = mediaOf(msg, groupJid);
        if (!m || m.kind !== 'sticker') return reply(`🖼️ Reply to a *sticker* with ${P}toimg`), true;
        const sharp = (await import('sharp')).default;
        await sendImg(await sharp(await downloadMedia(bot, m.holder)).png().toBuffer(), '🖼️ Done');
        return true;
      }

      // ───────────────────────── .songcard / .aicard / .cards  on|off (developers) ─────────────────────────
      case 'songcard': case 'aicard': case 'cards': {
        if (!isAuth) return true;
        const arg = (toks[0] || '').toLowerCase();
        const names = cmd === 'cards' ? ['songcard', 'aicard'] : [cmd];
        if (/^(on|off)$/.test(arg)) { names.forEach((n) => setCard(n, arg === 'on')); }
        else if (arg) return reply(`Usage: ${P}${cmd} on / off`), true;
        const st = cardState();
        await reply(`🎴 *Cards*\n┃ 🎵 Song card: *${st.songcard ? 'ON' : 'OFF'}*\n┃ 🤖 AI card: *${st.aicard ? 'ON' : 'OFF'}*\n\n${P}songcard on|off\n${P}aicard on|off\n${P}cards on|off`);
        return true;
      }

      // ───────────────────────── .apitest (developers) ─────────────────────────
      case 'apitest': case 'apicheck': {
        if (!isAuth) return true;
        await reply('🧪 Testing every service from this server … (about 20 s)');
        const T = (name, fn) => (async () => { const t0 = Date.now(); try { const note = await fn(); return `✅ ${name}${note ? ` — ${note}` : ''} (${Date.now() - t0} ms)`; } catch (e) { return `❌ ${name} — ${short(e, 60)}`; } })();
        const ping = (url, params) => async () => { await getJson(url, params); return ''; };
        const rows = await Promise.all([
          T('Nager.Date (holidays)', ping('https://date.nager.at/api/v3/PublicHolidays/2026/PK')),
          T('Aladhan (namaz / hijri)', ping('https://api.aladhan.com/v1/timingsByCity', { city: 'Karachi', country: 'Pakistan', method: 1 })),
          T('Jikan (anime)', ping('https://api.jikan.moe/v4/anime', { q: 'naruto', limit: 1 })),
          T('waifu.pics', ping('https://api.waifu.pics/sfw/waifu')),
          T('nekos.best', ping('https://nekos.best/api/v2/hug')),
          T('trace.moe', ping('https://api.trace.moe/me')),
          T('LRCLIB (lyrics)', ping('https://lrclib.net/api/search', { q: 'tum hi ho' })),
          T('USDA FoodData (food)', ping('https://api.nal.usda.gov/fdc/v1/foods/search', { query: 'banana', pageSize: 1, api_key: env('FDC_API_KEY', 'DEMO_KEY') })),
          T('openFDA (drug)', ping('https://api.fda.gov/drug/label.json', { search: 'openfda.generic_name:"ibuprofen"', limit: 1 })),
          T('wttr.in (weather)', ping('https://wttr.in/Karachi', { format: 'j1' })),
          T('JokeAPI', ping('https://v2.jokeapi.dev/joke/Any', { amount: 1 })),
          T('Imgflip (memes)', ping('https://api.imgflip.com/get_memes')),
          T('DiceBear (avatars)', async () => { await fetchBuf('https://api.dicebear.com/9.x/adventurer/png?seed=test&size=64'); return ''; }),
          T('JioSaavn (songs)', ping(`${SAAVN()}/search/songs`, { query: 'tum hi ho', limit: 1 })),
          T('Verome (YT music search)', ping(`${VEROME()}/api/yt_search`, { q: 'tum hi ho' })),
          T('yt-dlp (songs & videos)', async () => { const b = await getYtdlp(); if (!b) throw new Error('not installed / cannot download'); return 'ready'; }),
          T('ffmpeg (converters)', async () => { const b = await findFfmpeg(); if (!(await works(b, ['-version']))) throw new Error('not found — npm i ffmpeg-static'); return 'ready'; }),
          T('AI answer (.ask)', async () => { const r = await askText('Say OK', { maxTokens: 20, logger: bot.logger }); if (!r.text) throw new Error(clip(r.error || 'no brain', 80)); return r.via; }),
        ]);
        const keys = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'TOGETHER_API_KEY', 'HF_TOKEN', 'COBALT_API_URL', 'CALENDARIFIC_KEY', 'FDC_API_KEY'].map((k) => `${env(k) ? '🟢' : '⚪'} ${k}`).join('\n');
        await reply(`🧪 *API test*\n${rows.join('\n')}\n\n🔑 *Optional keys in .env*\n${keys}`);
        return true;
      }

      default:
        return false;
    }
  } catch (e) {
    bot.logger?.warn?.({ cmd, err: short(e, 200) }, 'apiCmds: command failed');
    await reply(`❌ ${P}${cmd} failed: ${short(e, 220)}`);
    return true;
  }
}

export const API_COMMANDS = new Set(['songcard', 'aicard', 'cards', 'song', 'play', 'gana', 'music', 'video', 'ytv', 'vid', 'lyrics', 'lyric', 'ask', 'ai', 'gpt', 'imagine', 'draw', 'dpai', 'avatar', 'pfp', 'robot', 'robohash', 'anime', 'animepic', 'waifu', 'animegif', 'findanime', 'whatanime', 'holiday', 'holidays', 'nextholiday', 'hijri', 'islamicdate', 'namaz', 'prayer', 'salah', 'food', 'calories', 'nutrition', 'bmi', 'drug', 'medicine', 'weather', 'mausam', 'joke', 'fact', 'meme', 'qr', 'toaudio', 'tomp3', 'tovideo', 'tomp4', 'toimg', 'topng', 'apitest', 'apicheck']);
