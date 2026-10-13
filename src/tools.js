/**
 * Extra tools for the group bot: sticker maker, translator and the message-statistics store.
 *  - Image → sticker uses `sharp` (already installed with the WhatsApp library).
 *  - Video → animated sticker needs an ffmpeg binary: set FFMPEG_PATH, or `npm i ffmpeg-static`, or have ffmpeg on the server.
 *  - Translate uses Google Translate's public endpoint (needs internet, no key).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import axios from 'axios';

// ───────────────────────────── stickers ─────────────────────────────
export async function imageToSticker(buffer) {
  const sharp = (await import('sharp')).default;
  return sharp(buffer, { animated: true })
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 80 })
    .toBuffer();
}

export async function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try { const m = await import('ffmpeg-static'); if (m.default) return m.default; } catch { /* not installed */ }
  return 'ffmpeg';
}

export const runFfmpeg = (bin, args) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, _o, stderr) => (err ? reject(new Error(err.code === 'ENOENT' ? 'ffmpeg not found' : String(stderr || err.message).slice(-200))) : resolve()));
});

/** Video/GIF → animated WebP sticker. Input up to 25 s is accepted; the sticker keeps the first 10 s (WhatsApp's limit). */
export async function videoToSticker(buffer) {
  const bin = await findFfmpeg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-'));
  const inp = path.join(dir, 'in.mp4');
  const out = path.join(dir, 'out.webp');
  fs.writeFileSync(inp, buffer);
  try {
    const attempts = [{ fps: 15, size: 512, q: 40 }, { fps: 12, size: 400, q: 30 }, { fps: 10, size: 320, q: 22 }];
    for (const a of attempts) {
      await runFfmpeg(bin, ['-y', '-i', inp, '-t', '10', '-an', '-vf',
        `scale=${a.size}:${a.size}:force_original_aspect_ratio=decrease,fps=${a.fps},pad=${a.size}:${a.size}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
        '-vcodec', 'libwebp', '-lossless', '0', '-q:v', String(a.q), '-compression_level', '6', '-loop', '0', '-preset', 'default', out]);
      const buf = fs.readFileSync(out);
      if (buf.length <= 900 * 1024) return buf;
    }
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ───────────────────────────── translate ─────────────────────────────
export const TR_NAMES = { ur: 'Urdu', en: 'English', hi: 'Hindi', ar: 'Arabic', pa: 'Punjabi', fr: 'French', es: 'Spanish', de: 'German', tr: 'Turkish', fa: 'Persian', bn: 'Bengali', zh: 'Chinese', ru: 'Russian' };

/**
 * Translate with automatic fallback: Google (gtx) → Google (POST) → MyMemory → Lingva → the AI brains.
 * If one service is blocked / down the next one answers at once, so `.tr` keeps working.
 */
export async function translateText(text, to) {
  const src = String(text || '').trim().slice(0, 4000);
  if (!src) throw new Error('nothing to translate');
  const errs = [];
  const UA = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36' };
  const done = (out, from) => ({ text: String(out).trim(), from: from || 'auto' });

  // 1) Google translate (free web endpoint)
  try {
    const res = src.length < 1200
      ? await axios.get('https://translate.googleapis.com/translate_a/single', { params: { client: 'gtx', sl: 'auto', tl: to, dt: 't', q: src }, headers: UA, timeout: 8000 })
      : await axios.post(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(to)}&dt=t`, new URLSearchParams({ q: src }).toString(), { headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
    const out = (res.data?.[0] || []).map((p) => p?.[0] || '').join('');
    if (out.trim()) return done(out, res.data?.[2]);
    errs.push('google: empty');
  } catch (e) { errs.push(`google: ${e?.response?.status || e?.code || e?.message}`); }

  // 2) Google translate, second client name (some hosts only allow one of them)
  try {
    const res = await axios.get('https://clients5.google.com/translate_a/t', { params: { client: 'dict-chrome-ex', sl: 'auto', tl: to, q: src.slice(0, 1500) }, headers: UA, timeout: 8000 });
    const d = res.data;
    const out = Array.isArray(d) ? (Array.isArray(d[0]) ? d.map((x) => x?.[0] || '').join('') : String(d[0] || '')) : (d?.sentences || []).map((x) => x.trans || '').join('');
    if (out.trim()) return done(out);
    errs.push('google2: empty');
  } catch (e) { errs.push(`google2: ${e?.response?.status || e?.code || e?.message}`); }

  // 3) MyMemory (free, 500 chars per request)
  if (src.length <= 480) {
    try {
      const res = await axios.get('https://api.mymemory.translated.net/get', { params: { q: src, langpair: `Autodetect|${to}` }, headers: UA, timeout: 8000 });
      const out = res.data?.responseData?.translatedText;
      if (out && !/INVALID|MYMEMORY WARNING|QUERY LENGTH/i.test(out)) return done(out);
      errs.push('mymemory: empty');
    } catch (e) { errs.push(`mymemory: ${e?.response?.status || e?.code || e?.message}`); }
  }

  // 4) Lingva (open Google-translate proxy)
  for (const host of ['https://lingva.ml', 'https://lingva.lunar.icu']) {
    if (src.length > 900) break;
    try {
      const res = await axios.get(`${host}/api/v1/auto/${encodeURIComponent(to)}/${encodeURIComponent(src)}`, { headers: UA, timeout: 8000 });
      if (res.data?.translation) return done(res.data.translation);
      errs.push('lingva: empty');
    } catch (e) { errs.push(`lingva: ${e?.response?.status || e?.code || e?.message}`); }
  }

  // 5) the AI brains (Groq / Cerebras / Gemini / …) as the last resort
  try {
    const { askText } = await import('./aiBrains.js');
    const lang = TR_NAMES[to] || to;
    const r = await askText(`Translate the text below into ${lang}. Output ONLY the translation, nothing else.\n\n${src}`, { system: 'You are a precise translator. Output only the translated text, no notes, no quotes.', maxTokens: 900 });
    if (r?.text?.trim()) return done(r.text.replace(/^["“]|["”]$/g, ''));
    errs.push(`ai: ${r?.error || 'empty'}`);
  } catch (e) { errs.push(`ai: ${e?.message}`); }

  throw new Error(errs.slice(0, 3).join(' | ') || 'translation failed');
}

// ───────────────────────────── message statistics ─────────────────────────────
export function fmtDuration(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  const parts = [];
  if (d) parts.push(`${d} din`);
  if (h) parts.push(`${h} ghante`);
  if (mm || !parts.length) parts.push(`${mm} minute`);
  return parts.slice(0, 3).join(' ');
}

export class StatsStore {
  constructor(file, tz = process.env.BOT_TZ || 'Asia/Karachi') {
    this.file = file;
    this.tz = tz;
    this.fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = {}; }
    this.data.groups ||= {};
    this.data.startedAt ||= Date.now();
    this.dirty = false;
    this.timer = setInterval(() => this.flush(), 30_000);
    this.timer.unref?.();
  }

  /** → { day: 'YYYY-MM-DD', hour: 0-23 } in the bot's timezone */
  slot(ts = Date.now()) {
    const p = Object.fromEntries(this.fmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour === '24' ? 0 : p.hour) };
  }

  _g(jid) {
    return (this.data.groups[jid] ||= { since: Date.now(), total: 0, users: {}, state: null });
  }

  record(jid, bare, ts = Date.now(), senderJid = null) {
    const g = this._g(jid);
    const u = (g.users[bare] ||= { total: 0, days: {} });
    if (senderJid) u.jid = senderJid;
    const { day, hour } = this.slot(ts);
    g.total += 1; u.total += 1;
    const d = (u.days[day] ||= new Array(24).fill(0));
    d[hour] += 1;
    this.dirty = true;
  }

  setState(jid, announce, ts = Date.now()) {
    const g = this._g(jid);
    if (g.state && g.state.announce === !!announce) return;
    g.state = { announce: !!announce, since: ts };
    this.dirty = true;
  }

  getState(jid) { return this._g(jid).state; }

  flush() {
    if (!this.dirty) return;
    try {
      const cutoff = Date.now() - 40 * 86400_000; // keep hourly detail for 40 days
      for (const g of Object.values(this.data.groups)) for (const u of Object.values(g.users)) for (const day of Object.keys(u.days)) if (Date.parse(day) < cutoff) delete u.days[day];
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data), 'utf8');
      this.dirty = false;
    } catch { /* retry next tick */ }
  }

  _dayOffset(n) { return this.slot(Date.now() - n * 86400_000).day; }

  userReport(jid, bare) {
    const g = this._g(jid);
    const u = g.users[bare];
    const now = this.slot();
    const today = u?.days?.[now.day] || new Array(24).fill(0);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    let week = 0;
    for (let i = 0; i < 7; i++) week += sum(u?.days?.[this._dayOffset(i)] || []);
    return {
      today: sum(today),
      thisHour: today[now.hour] || 0,
      lastHour: now.hour > 0 ? today[now.hour - 1] || 0 : (u?.days?.[this._dayOffset(1)]?.[23] || 0),
      yesterday: sum(u?.days?.[this._dayOffset(1)] || []),
      week,
      total: u?.total || 0,
      hours: today,
      nowHour: now.hour,
      rank: Object.entries(g.users).sort((a, b) => b[1].total - a[1].total).findIndex(([k]) => k === bare) + 1,
    };
  }

  groupReport(jid, topN = 5) {
    const g = this._g(jid);
    const now = this.slot();
    const todayOf = (u) => (u.days?.[now.day] || []).reduce((x, y) => x + y, 0);
    const entries = Object.entries(g.users);
    return {
      total: g.total,
      today: entries.reduce((n, [, u]) => n + todayOf(u), 0),
      since: g.since,
      members: entries.length,
      topToday: entries.map(([k, u]) => [k, todayOf(u), u.jid]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, topN),
      topAll: entries.map(([k, u]) => [k, u.total, u.jid]).sort((a, b) => b[1] - a[1]).slice(0, topN),
      state: g.state,
    };
  }
}

// ───────────────────────────── emoji → sticker ─────────────────────────────
/** Renders a single emoji (Twemoji artwork, downloaded from the jsDelivr CDN) as a 512×512 WebP sticker. */
export async function emojiToSticker(emoji) {
  const cps = [...String(emoji).trim()].map((c) => c.codePointAt(0));
  const hasZwj = cps.includes(0x200d);
  const name = cps.filter((c) => hasZwj || c !== 0xfe0f).map((c) => c.toString(16)).join('-');
  const res = await axios.get(`https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.0.3/assets/72x72/${name}.png`, { responseType: 'arraybuffer', timeout: 15_000 });
  const sharp = (await import('sharp')).default;
  return sharp(Buffer.from(res.data)).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 90 }).toBuffer();
}

export const isOnlyEmoji = (t) => {
  const s = String(t || '').trim();
  if (!s || s.length > 30) return false;
  return /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}]|[0-9#*]\ufe0f?\u20e3)+$/u.test(s);
};

// ───────────────────────────── voice notes ─────────────────────────────
/** MP3 → OGG/Opus so WhatsApp plays it as a real voice note. Returns null when ffmpeg is not available. */
export async function mp3ToOpus(buffer) {
  const bin = await findFfmpeg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vn-'));
  const inp = path.join(dir, 'in.mp3');
  const out = path.join(dir, 'out.ogg');
  fs.writeFileSync(inp, buffer);
  try {
    await runFfmpeg(bin, ['-y', '-i', inp, '-vn', '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', '-f', 'ogg', out]);
    return fs.readFileSync(out);
  } catch { return null; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ───────────────────────────── voice → text ─────────────────────────────
/** Speech-to-text through Whisper (Groq or OpenAI). Needs GROQ_API_KEY (free at console.groq.com) or OPENAI_API_KEY in .env. */
export async function speechToText(buffer, mimetype = 'audio/ogg') {
  const groq = process.env.GROQ_API_KEY;
  const openai = process.env.OPENAI_API_KEY;
  if (!groq && !openai) throw new Error('NO_STT_KEY');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype }), 'voice.ogg');
  form.append('model', groq ? 'whisper-large-v3' : 'whisper-1');
  form.append('response_format', 'json');
  const res = await fetch(groq ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${groq || openai}` }, body: form,
  });
  if (!res.ok) throw new Error(`STT HTTP ${res.status}`);
  const j = await res.json();
  return String(j.text || '').trim();
}

// ───────────────────────────── 12-hour clock helpers (schedule) ─────────────────────────────
/** "10pm", "10:30 pm", "22:15", "7 am" → "HH:MM" (24h) or null */
export function parseClock(input) {
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/i.exec(String(input || '').trim());
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] || 0); const ap = (m[3] || '').toLowerCase();
  if (min > 59) return null;
  if (ap) { if (h < 1 || h > 12) return null; if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; }
  else if (h > 23) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
export function fmt12(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
