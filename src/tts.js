/**
 * Text → voice note. Uses Google Translate's public text-to-speech endpoint (no key needed, bot server needs
 * internet). Long text is split into <=180-character pieces and the MP3 parts are joined into one audio.
 */
import axios from 'axios';

export function detectLang(text) {
  if (/[\u0600-\u06FF]/.test(text)) return 'ur';
  if (/[\u0900-\u097F]/.test(text)) return 'hi';
  return 'en';
}

function chunk(text, max = 180) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const out = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max) { if (cur) out.push(cur); cur = w.slice(0, max); } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  return out.slice(0, 12); // ~2000 characters at most
}

export async function textToVoice(text, lang) {
  const tl = lang || detectLang(text);
  const parts = chunk(text);
  if (!parts.length) throw new Error('empty text');
  const bufs = [];
  for (const q of parts) {
    const res = await axios.get('https://translate.google.com/translate_tts', {
      params: { ie: 'UTF-8', q, tl, client: 'tw-ob', total: parts.length, idx: bufs.length, textlen: q.length },
      responseType: 'arraybuffer',
      timeout: 20_000,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://translate.google.com/' },
    });
    bufs.push(Buffer.from(res.data));
  }
  return Buffer.concat(bufs);
}
