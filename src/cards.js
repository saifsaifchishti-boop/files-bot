/**
 * "Cards" — optional decorated replies. A developer switches each one ON / OFF:
 *   .songcard on|off   → song info card (thumbnail, title, channel, views, duration) before the audio
 *   .aicard on|off     → AI answers (Babli chat / .ask) wrapped in a neat card
 *   .cards on|off      → both together          (no argument = show the current state)
 * The choice is stored in data/cards.json, so it survives restarts.
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join((process.env.DATA_DIR || './data').toString().trim(), 'cards.json');
const DEFAULTS = { songcard: true, aicard: false };
const read = () => { try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return { ...DEFAULTS }; } };

export const cardOn = (name) => !!read()[name];
export function setCard(name, on) {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify({ ...read(), [name]: !!on })); } catch { /* ignore */ }
}
export const cardState = () => read();

const num = (n) => { const v = Number(String(n ?? '').replace(/[^\d]/g, '')); return v ? v.toLocaleString('en-US') : String(n || '—'); };

/** Song info card text. */
export function songCardText({ title, author, views, duration, url, via }) {
  return [
    '╭━━━━━━━━━━━━━━━━━━╮',
    '┃  🎵  *SONG CARD*',
    '╰━━━━━━━━━━━━━━━━━━╯',
    `📌 *${title || 'Song'}*`,
    author ? `👤 ${author}` : '',
    views ? `👁️ ${num(views)} views` : '',
    duration ? `⏱️ ${duration}` : '',
    url ? `🔗 ${url}` : '',
    '',
    `⏳ _audio aa raha hai…_${via ? `  ·  via ${via}` : ''}`,
  ].filter((x) => x !== '').join('\n');
}

/** Wraps an AI answer into a card (header on the first part, footer on the last). */
export const AI_HEAD = '╭━━━━━━━━━━━━━━━━━━╮\n┃  🤖  *BABLI AI*\n╰━━━━━━━━━━━━━━━━━━╯\n';
export const AI_FOOT = '\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n✨ _Mehfooz Bot_';
export const aiCard = (text) => AI_HEAD + String(text).trim() + AI_FOOT;
