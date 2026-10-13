/**
 * Button menu: `.menu` → tap a category → tap a command → tap ON / OFF / Delete / Warn / Kick …
 *
 * Button ids (all start with "mn:"):
 *   mn:h:<page>              home page (categories)
 *   mn:s:<section>:<page>    commands of one category
 *   mn:c:<cmd>               the card of one command (state + its buttons)
 *   mn:t:<cmd>:<op>          on | off | d | w | k   (switch it / toggle Delete, Warn, Kick)
 *   mn:r:<cmd>               run the command now (info / one-tap actions)
 *   mn:v:<cmd>:<value>       pick a value (e.g. mode public|private)
 */
import { MENU_SECTIONS, ROWMAP, SHOWN, ANTI_ACTION_KEYS, LINK_ALIASES } from './menu.js';

const PAGE = 5; // commands / categories per page (+ navigation buttons)
const RULE = '┗━━━━━━━━━━━━━━━';

// Plain on/off switches stored as gs[cmd] = true|false
const SIMPLE = new Set(['antilink', 'antisticker', 'autophoto', 'autovideo', 'antibot', 'antiforward', 'antimedia', 'antinsfw', 'antidelete', 'antivoice', 'antichannel', 'approve', 'antibadword']);
// Switches stored as gs[key].enabled
const NESTED = { antispam: 'antispam', antiflood: 'antiflood', antimention: 'antimention', antispecificword: 'antispecificword', welcome: 'welcome', goodbye: 'goodbye', autokick: 'autokick', badword: 'badword' };
// One tap runs the command (information, or an action that needs no extra input)
const RUN = new Set(['admins', 'groupinfo', 'activity', 'settings', 'groupstats', 'top', 'warnings', 'ping', 'devlist', 'filestatus', 'stats', 'files', 'folders', 'handouts', 'mids', 'finals', 'quizzes', 'grouplink', 'revokelink', 'groupopen', 'groupclose', 'statuscheck', 'rmstatus', 'purgestatus', 'groups', 'badwordlist', 'filestop', 'filestart', 'boton', 'menuall', 'utility']);
// Dangerous: ask for one more tap
const CONFIRM = new Set(['restart', 'botoff', 'gkick', 'leave']);
// Pick one of several values
const CHOICE = { mode: ['public', 'private'], cafe: ['on', 'off'], lock: ['chat', 'info'], unlock: ['chat', 'info'] };

const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
const shown = (c) => SHOWN[c] || c;
const emoji = (c) => ROWMAP[c]?.e || '▫️';
const desc = (c) => ROWMAP[c]?.d || '';

function actionsFromObj(o) { return { delete: o?.delete !== false, warn: o?.warn !== false, kick: o?.kick !== false }; }

/** Current state of one command for this group: { on: bool|null, acts: {delete,warn,kick}|null, label } */
export function stateOf(bot, cmd, groupJid) {
  const state = bot._loadState();
  const gs = groupJid ? bot._getGroupSettings(state, groupJid) : null;
  const base = actionsFromObj(gs?.modActions);
  if (SIMPLE.has(cmd) && gs) return { on: !!gs[cmd], acts: ANTI_ACTION_KEYS.has(cmd) ? actionsFromObj({ ...base, ...(gs.antiActions?.[cmd] || {}) }) : null };
  if (NESTED[cmd] && gs) return { on: !!gs[NESTED[cmd]]?.enabled, acts: ANTI_ACTION_KEYS.has(cmd) ? actionsFromObj({ ...base, ...(gs.antiActions?.[cmd] || {}) }) : null };
  if (LINK_ALIASES[cmd] && gs) { const r = gs.linkRules?.[LINK_ALIASES[cmd]]; return { on: !!r?.enabled, acts: actionsFromObj(r || base) }; }
  if (cmd === 'antistatus' && bot.antiStatus && groupJid) {
    const c = bot.antiStatus.reloadConfig();
    const ga = c.groupActions?.[groupJid] || { delete: c.deleteEnabled !== false, warn: false, kick: c.kickEnabled !== false };
    return { on: !!(c.enabled && c.groups?.[groupJid]), acts: actionsFromObj(ga) };
  }
  if (cmd === 'anticall') return { on: !!state.anticall?.enabled, acts: null };
  if ((cmd === 'fileon' || cmd === 'fileoff') && gs) return { on: !!gs.fileAccess?.enabled, acts: null };
  if (cmd === 'filecard' && gs) return { on: !!gs.fileCard?.enabled, acts: null };
  if (cmd === 'filecardlink' && gs) return { on: !!gs.fileCard?.showLink, acts: null };
  return null;
}

/** Applies a tapped switch directly (no chat command needed). Returns true when handled here. */
export function applyOp(bot, cmd, op, groupJid) {
  const state = bot._loadState();
  const gs = groupJid ? bot._getGroupSettings(state, groupJid) : null;
  const on = op === 'on';
  const key = { d: 'delete', w: 'warn', k: 'kick' }[op];
  if (key) {
    const cur = stateOf(bot, cmd, groupJid)?.acts;
    if (!cur) return false;
    const next = { ...cur, [key]: !cur[key] };
    if (cmd === 'antistatus') { bot.antiStatus.saveConfig({ groupActions: { ...(bot.antiStatus.reloadConfig().groupActions || {}), [groupJid]: next } }); return true; }
    if (LINK_ALIASES[cmd]) { gs.linkRules = gs.linkRules || {}; gs.linkRules[LINK_ALIASES[cmd]] = { ...(gs.linkRules[LINK_ALIASES[cmd]] || { enabled: false }), ...next }; }
    else { gs.antiActions = gs.antiActions || {}; gs.antiActions[cmd] = next; }
    bot._saveState(state);
    return true;
  }
  if (op !== 'on' && op !== 'off') return false;
  if (SIMPLE.has(cmd) && gs) gs[cmd] = on;
  else if (NESTED[cmd] && gs) { gs[NESTED[cmd]] = gs[NESTED[cmd]] || {}; gs[NESTED[cmd]].enabled = on; }
  else if (LINK_ALIASES[cmd] && gs) { gs.linkRules = gs.linkRules || {}; const t = LINK_ALIASES[cmd]; gs.linkRules[t] = { delete: true, warn: true, kick: true, ...(gs.linkRules[t] || {}), enabled: on }; }
  else if (cmd === 'anticall') state.anticall = { enabled: on };
  else if (cmd === 'filecard' && gs) { gs.fileCard = gs.fileCard || {}; gs.fileCard.enabled = on; }
  else if (cmd === 'filecardlink' && gs) { gs.fileCard = gs.fileCard || {}; gs.fileCard.showLink = on; if (on) gs.fileCard.enabled = true; }
  else return false;
  bot._saveState(state);
  return true;
}

const head = (icon, title) => [`${icon} *${title}*`, '┈┈┈┈┈┈┈┈┈┈┈┈┈┈']; // no heavy blocks — a quiet header

function homeView(P, page) {
  const secs = MENU_SECTIONS;
  const pages = Math.ceil(secs.length / PAGE);
  const p = Math.min(Math.max(page, 0), pages - 1);
  const slice = secs.slice(p * PAGE, p * PAGE + PAGE);
  const text = [...head('◈', 'MEHFOOZ MENU'), '', `Pick a category 👇  _(${p + 1}/${pages})_`, '', '┏━「 ◈ *CATEGORIES* 」', ...slice.map(([ic, t]) => `┃ ${ic} *${t}*`), RULE].join('\n');
  const buttons = slice.map(([ic, t], i) => ({ id: `mn:s:${p * PAGE + i}:0`, text: clip(`${ic} ${t}`, 20) }));
  if (p > 0) buttons.push({ id: `mn:h:${p - 1}`, text: '⬅ Previous' });
  if (p < pages - 1) buttons.push({ id: `mn:h:${p + 1}`, text: '➡ More' });
  return { text, buttons };
}

function sectionView(P, si, page) {
  const sec = MENU_SECTIONS[si];
  if (!sec) return homeView(P, 0);
  const [ic, title, items] = sec;
  const pages = Math.ceil(items.length / PAGE);
  const p = Math.min(Math.max(page, 0), pages - 1);
  const slice = items.slice(p * PAGE, p * PAGE + PAGE);
  const text = [...head(ic, title), '', `Tap a command 👇  _(${p + 1}/${pages})_`, '', `┏━「 ${ic} *${title}* 」`, ...slice.map((c) => `┃ ${emoji(c)} *${P}${shown(c)}* ➜ *${desc(c)}*`), RULE].join('\n');
  const buttons = slice.map((c) => ({ id: `mn:c:${c}:${si}`, text: clip(`${emoji(c)} ${P}${shown(c)}`, 20) }));
  if (p > 0) buttons.push({ id: `mn:s:${si}:${p - 1}`, text: '⬅ Previous' });
  if (p < pages - 1) buttons.push({ id: `mn:s:${si}:${p + 1}`, text: '➡ More' });
  buttons.push({ id: 'mn:h:0', text: '🏠 Menu' });
  return { text, buttons };
}

const tick = (b) => (b ? '✅' : '❌');

function commandView(bot, P, cmd, si, groupJid, isGroup) {
  const back = { id: `mn:s:${si}:0`, text: '⬅ Back' };
  const home = { id: 'mn:h:0', text: '🏠 Menu' };
  const title = `${P}${shown(cmd)}`;
  const top = [...head(emoji(cmd), title.toUpperCase()), `◦ ${desc(cmd)}`, ''];

  if (CONFIRM.has(cmd)) {
    return { text: [...top, '⚠️ Are you sure?'].join('\n'), buttons: [{ id: `mn:r:${cmd}:${si}`, text: clip(`✅ Yes, ${shown(cmd)}`, 20) }, back, home] };
  }
  if (CHOICE[cmd]) {
    const state = bot._loadState();
    const cur = cmd === 'mode' ? state.mode : null;
    return { text: [...top, ...(cur ? [`┃ Now ➜ *${cur}*`] : []), 'Pick one 👇'].join('\n'), buttons: [...CHOICE[cmd].map((v) => ({ id: `mn:v:${cmd}:${v}:${si}`, text: clip(`${v === cur ? '✅ ' : ''}${v}`, 20) })), back, home] };
  }
  if (RUN.has(cmd)) {
    return { text: [...top, 'Tap *Run* to do it now 👇'].join('\n'), buttons: [{ id: `mn:r:${cmd}:${si}`, text: '▶️ Run' }, back, home] };
  }
  const st = isGroup ? stateOf(bot, cmd, groupJid) : null;
  const canBlock = cmd === 'blocklink';
  if (st) {
    const lines = [...top, '┏━「 📊 *STATE* 」', `┃ Switch ➜ ${st.on ? '🟢 *ON*' : '⚪ *OFF*'}`];
    const buttons = [{ id: `mn:t:${cmd}:on:${si}`, text: `${st.on ? '✅ ' : ''}🟢 ON` }, { id: `mn:t:${cmd}:off:${si}`, text: `${!st.on ? '✅ ' : ''}⚪ OFF` }];
    if (st.acts) {
      lines.push(`┃ 🗑️ Delete ➜ ${tick(st.acts.delete)}`, `┃ ⚠️ Warn ➜ ${tick(st.acts.warn)}`, `┃ 👢 Kick ➜ ${tick(st.acts.kick)}`);
      buttons.push({ id: `mn:t:${cmd}:d:${si}`, text: `🗑️ Delete ${tick(st.acts.delete)}` }, { id: `mn:t:${cmd}:w:${si}`, text: `⚠️ Warn ${tick(st.acts.warn)}` }, { id: `mn:t:${cmd}:k:${si}`, text: `👢 Kick ${tick(st.acts.kick)}` });
      lines.push('┃ _kick alone = instant remove_');
    }
    lines.push(RULE, '👇 tap to change');
    return { text: lines.join('\n'), buttons: [...buttons, back, home] };
  }
  if (canBlock) {
    const types = ['antialllinks', 'antiwa', 'antiwachannel', 'antiwagroup', 'antifb', 'antiyt', 'antitiktok', 'antiig', 'antitg', 'antitwitter', 'antiweb'];
    return { text: [...top, 'Pick a link type 👇'].join('\n'), buttons: [...types.slice(0, 8).map((c) => ({ id: `mn:c:${c}:${si}`, text: clip(`${emoji(c)} ${P}${shown(c)}`, 20) })), back, home] };
  }
  const usage = isGroup || !STATEFUL.has(cmd) ? `Type it in the chat:\n*${P}${shown(cmd)}* …` : 'Open this menu inside a group 🙂';
  return { text: [...top, usage].join('\n'), buttons: [back, home] };
}
const STATEFUL = new Set([...SIMPLE, ...Object.keys(NESTED), ...Object.keys(LINK_ALIASES), 'antistatus', 'filecard', 'filecardlink', 'fileon', 'fileoff']);

/** id like "h:0", "s:3:1", "c:antilink:3" → { text, buttons } */
export function buildView(bot, P, id, groupJid, isGroup) {
  const [k, a, b] = String(id).split(':');
  if (k === 's') return sectionView(P, Number(a) || 0, Number(b) || 0);
  if (k === 'c') return commandView(bot, P, a, Number(b) || 0, groupJid, isGroup);
  return homeView(P, Number(a) || 0);
}
