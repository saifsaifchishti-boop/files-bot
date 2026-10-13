/**
 * Group Command Bot — turns incoming WhatsApp group messages into a full
 * moderation/admin command set, driven by `.` commands (e.g. `.menu`,
 * `.antilink on`, `.kick @user`).
 *
 * ── Who can control it (read this first) ───────────────────────────────────
 * This is intentionally NOT admin-controlled. WhatsApp group-admin status is
 * granted by whoever runs the group and can change at any time, so this bot
 * never trusts it for anything more than "should auto-moderation leave this
 * person's messages alone" (see EXEMPT below). Every command that changes a
 * setting or takes an action (kick, promote, mute, antilink on/off, …) is
 * gated to exactly two identities, in EVERY bot mode (public or private):
 *
 *   1. OWNER  — the WhatsApp account this bot is connected to/running as
 *               (this is a self-bot: the number logged into the session).
 *   2. DEV    — one hardcoded developer number (see DEV_NUMBER below).
 *
 * No one else can change a setting or run an action command, no matter what
 * they say, even if they are a WhatsApp group admin, and even if they ask
 * repeatedly. This is enforced in code (_isAuthorized below), not just by
 * convention. The only exception is a short list of read-only info commands
 * (menu/admins/groupinfo/activity/warnings) which ordinary members MAY use
 * when the bot's mode is "public" — see PUBLIC_INFO_COMMANDS. Everything
 * else always requires OWNER or DEV, in both modes.
 *
 * "Auto-moderation" (deleting a link when Antilink is on, etc.) is not a
 * command from anyone — it's the bot enforcing settings OWNER/DEV already
 * turned on, against ordinary members. Current group admins and the
 * owner/dev are exempt from it (see EXEMPT below), the same way in most
 * moderation bots — admins can post normally without tripping the filters
 * they configured for everyone else.
 *
 * ── Known limitations (documented honestly, matches the rest of this repo)──
 * - Mute/Unmute: WhatsApp has no per-member mute. "Mute" here means the bot
 *   auto-deletes that member's future messages in this group until unmuted —
 *   a soft mute, not a protocol-level restriction.
 * - Antibot / Antinsfw: there is no reliable bot-detection or image-content
 *   classification available offline. Antibot only catches participants
 *   whose JID matches known non-human suffixes this fork exposes (rare in
 *   practice). Antinsfw is a wired-up but inert hook — classifyImageNSFW()
 *   always returns false until you plug in a real image-moderation model or
 *   API; see the comment on that function.
 * - Approve (auto-approve join requests) and Anticall (auto-reject calls)
 *   depend on the Baileys fork exposing groupRequestParticipantsList /
 *   sock.rejectCall — this was not verified against a live connection while
 *   building this (no network access in the build environment). Both fail
 *   silently and log at debug level if unsupported, instead of crashing.
 * - Kicking/muting relies on reconstructing a phone-number JID
 *   (`digits@s.whatsapp.net`). Accounts WhatsApp has switched to its @lid
 *   privacy system may not match this and could fail to kick — same
 *   limitation already documented in wa-client.js's checkAdminStatus.
 */
import fs from 'node:fs';
import path from 'node:path';
import { textToVoice } from './tts.js';
import { extraCommand, ADMIN_DENY } from './extraCmds.js';
import { API_COMMANDS } from './apiCmds.js';
import { babliHandle, isBabliMsg, defendBoss } from './babli.js';
import { renderMenu, ALL_COMMANDS, ANTI_ACTION_KEYS, LINK_ALIASES } from './menu.js';
import { buildView, applyOp } from './menuButtons.js';
import { imageToSticker, videoToSticker, emojiToSticker, isOnlyEmoji, parseClock, fmt12, translateText, TR_NAMES, StatsStore, fmtDuration } from './tools.js';
import { getBranding, saveBranding, renderCredit } from './branding.js';
import { restartServer } from './control.js';
import { CourseFiles, isReadCommand, parseRequest, setFilesPaused, markBossRequest, FILE_FLOW, STORE_NAME, clampBatchSize, DEFAULT_BATCH_SIZE, MIN_BATCH_SIZE, MAX_BATCH_SIZE } from './courseFiles.js';

// ── Owner / developer access ────────────────────────────────────────────────
// DEV_NUMBER is hardcoded so it always has full control of this bot, in every
// mode, and can't be edited away just by someone tampering with a running
// deployment's .env file. If you ever need to change it, edit
// HARDCODED_DEV_NUMBER below — everything else in this file reads from the
// exported DEV_NUMBER constant.
//
// Assumption made while building this: you gave the number as
// "03204854766" with no country code. That 03xx prefix is Pakistani mobile
// numbering, so it was converted to international format by dropping the
// leading 0 and prefixing +92: 923204854766. If that's wrong, fix the digits
// below (country code + number, digits only, no "+", no spaces, no leading 0).
const HARDCODED_DEV_NUMBER = '923204854766';
// An optional DEV_NUMBER in .env overrides the hardcoded value at runtime if
// you ever want to change it without editing code — but the hardcoded value
// above is always the fallback, so the bot never loses its developer override
// just because an .env file was deleted or edited.
export const DEV_NUMBER = String(process.env.DEV_NUMBER || HARDCODED_DEV_NUMBER).replace(/\D/g, '');

// WhatsApp's newer @lid privacy system can show a group member under an
// opaque pseudonymous ID instead of their real phone number, with NO
// reverse mapping exposed by this fork's groupMetadata() (confirmed from
// your own server log on 2026-09-27: the participant record for the
// developer number's account only carried the @lid form, nothing else to
// resolve DEV_NUMBER against). Pre-seeding the exact @lid captured from
// that log means the developer number is recognized immediately, without
// waiting for the more general fix below.
const HARDCODED_DEV_LIDS = ['274401887043599'];

/**
 * Extra developer/owner identities registered at runtime via `.setdev`
 * (reply to that person's message) — the durable fix for the @lid problem:
 * instead of guessing a phone<->lid mapping that this fork doesn't expose,
 * OWNER captures whatever raw identifier the account actually messages
 * with and the bot remembers it exactly, going forward, no matter which
 * form (phone JID or @lid) it is. Persisted in the same config file as
 * everything else, under state.devIds.
 */

let PREFIX = '.'; // changeable from the dashboard / .setprefix (refreshed on every message)
const USER_HELP_URDU = [
  '═══════════════════',
  '📚 *فائل حاصل کرنے کا آسان طریقہ* 📚',
  '═══════════════════',
  '',
  '👋 {user} بھائی! فائل لینا بہت آسان ہے، بس یہ مراحل فالو کریں 👇',
  '',
  '1️⃣ ✍️ اپنے سبجیکٹ کا *کورس کوڈ* لکھ کر بھیجیں',
  '      مثال: *cs101* یا *eng201* ✅',
  '      (کوڈ سے پہلے ڈاٹ لگانا ضروری نہیں)',
  '',
  '2️⃣ 🎯 صرف ایک قسم کی فائل چاہیے؟ کوڈ کے ساتھ لکھیں:',
  '      📝 *cs101 mid* ← مڈ ٹرم پیپرز',
  '      🎓 *cs101 final* ← فائنل پیپرز',
  '      ❓ *cs101 quiz* ← کوئز',
  '      📘 *cs101 handout* ← ہینڈ آؤٹس اور کتابیں',
  '',
  '3️⃣ 🔢 اگر بوٹ مینو دکھائے تو اپنی پسند کا *نمبر* لکھ کر بھیجیں، جیسے *2*',
  '',
  '4️⃣ 📥 فائلیں تھوڑی تھوڑی کر کے آتی ہیں۔ اگلی فائلوں کے لیے لکھیں: *more*',
  '',
  '5️⃣ 🖼️ کوڈ معلوم نہیں؟ اپنی ڈیٹ شیٹ یا سبجیکٹ لسٹ کی تصویر پر ریپلائی کر کے لکھیں *.read*',
  '      🤖 بوٹ خود کوڈ پہچان کر فائلیں بھیج دے گا',
  '',
  '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈',
  '⚠️ ایک ہی پیغام بار بار نہ بھیجیں، بوٹ کو تھوڑا وقت دیں ⏳',
  '🙋 فائل نہ ملے تو گروپ ایڈمن سے رابطہ کریں',
  '═══════════════════',
].join('\n');

// Read-only commands ordinary members may use while the bot is in "public"
// mode. In "private" mode (the default), even these require OWNER/DEV.
const PUBLIC_INFO_COMMANDS = new Set(['menu', 'safe', 'help', 'ping', 'admins', 'groupinfo', 'ginfo', 'activity', 'warnings']);
// Commands a plain GROUP ADMIN may run (everything else is developer / board-number only).
// (no `.add`, and no per-group extras: the old `.allowadmin` feature was removed on purpose)
const ADMIN_ALLOWED_COMMANDS = new Set(['kick', 'mute', 'unmute', 'schedule', 'autoclose', 'autoopen', 'open', 'close', 'groupopen', 'groupclose', 'lock', 'unlock', 'antilink', 'antisticker']);

// Small built-in list for Antibadword. Deliberately short/generic — extend it
// yourself below, or (better) use Antispecificword's per-group custom list
// from the .antispecificword command instead of editing this.
const DEFAULT_BAD_WORDS = ['madarchod', 'behenchod', 'bhosdike', 'chutiya', 'randi', 'fuck', 'bitch', 'asshole'];

// Per-type link rules (`.blocklink`). Order matters: specific services first, "website" = any other link, "all" = any link.
const LINK_TYPES = {
  wagroup: /chat\.whatsapp\.com\//i,
  channel: /whatsapp\.com\/channel\//i,
  whatsapp: /(wa\.me\/|api\.whatsapp\.com|whatsapp\.com)/i,
  fb: /(facebook\.com|fb\.com|fb\.watch|fb\.me|m\.me)\b/i,
  yt: /(youtube\.com|youtu\.be)\b/i,
  ig: /(instagram\.com|instagr\.am)\b/i,
  tg: /(t\.me|telegram\.me|telegram\.org)\b/i,
  tiktok: /tiktok\.com\b/i,
  twitter: /(twitter\.com|x\.com)\b/i,
};
const LINK_TYPE_NAMES = ['wagroup', 'channel', 'whatsapp', 'fb', 'yt', 'ig', 'tg', 'tiktok', 'twitter', 'website', 'all'];
function linkTypesIn(text) {
  const found = new Set();
  if (!text || !LINK_RE.test(text)) return found;
  found.add('all');
  let specific = false;
  for (const [k, re] of Object.entries(LINK_TYPES)) if (re.test(text)) { found.add(k); specific = true; }
  if (!specific || /(https?:\/\/|www\.)\S+/i.test(text)) {
    const stripped = text.replace(/\S*(whatsapp|facebook|fb\.|youtu|instagram|t\.me|telegram|tiktok|twitter|x\.com|wa\.me)\S*/gi, '');
    if (LINK_RE.test(stripped)) found.add('website');
  }
  return found;
}
const LINK_RE = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]{2,}\.(com|net|org|io|me|xyz|info|co|in|pk|link|club|shop|live|tv|gg|app)\b/i;
const CHANNEL_RE = /whatsapp\.com\/channel\/|chat\.whatsapp\.com\/[a-z0-9]{20,}/i;

const DEFAULT_BADWORD_MESSAGE = '⚠️ {user}, please keep the language respectful in *{group}*.\nBarah-e-meharbani ba-akhlaq zaban istemal karein.\n\n_Powered by Saif Chishti_';

const DEFAULT_GROUP_SETTINGS = () => ({
  antilink: false,
  antisticker: false,
  antispam: { enabled: false, limit: 3, windowSec: 15 }, // N identical messages in a row within windowSec
  antibadword: false,
  antispecificword: { enabled: false, words: [] },
  autophoto: false,
  autovideo: false,
  antimention: { enabled: false, limit: 5 },
  antiflood: { enabled: false, limit: 8, windowSec: 10 }, // N messages of any kind within windowSec
  antibot: false,
  antiforward: false,
  antimedia: false,
  antinsfw: false,
  welcome: { enabled: false, message: 'Welcome {user} to {group}! 🎉' },
  goodbye: { enabled: false, message: '{user} has left {group}. Goodbye! 👋' },
  approve: false,
  linkRules: {}, // { wagroup|channel|whatsapp|fb|yt|ig|tg|tiktok|twitter|website|all: { enabled, delete, warn, kick } }
  schedule: { closeAt: null, openAt: null, last: {} }, // 'HH:MM' in BOT_TZ (default Asia/Karachi)
  fileBlocked: [], // bare numbers that must not get course files in this group
  banned: [], // `.ban` — every message from these numbers is deleted instantly
  adminCmds: [], // extra commands this group's admins may use (`.allowadmin`)
  adminGuard: true, // anti promote / demote protection — ALWAYS ON
  cafe: { mode: 'off' }, // Caffy: off (super dev only) | admin | normal
  autokick: { enabled: false, bannedNumbers: [] },
  antidelete: false,
  antivoice: false,
  antichannel: false,
  warnLimit: 3,
  mutedMembers: [], // bare phone numbers, soft-muted in this group
  // Course files (see src/courseFiles.js) — per group, only active after `.fileon` in that group.
  fileAccess: { enabled: false, batchSize: DEFAULT_BATCH_SIZE },
  // Delivery card (`.filecard on|off`, `.filecardlink on|off`): after files are sent, post the group DP + a thank-you that
  // mentions the member, names the group and (optionally) includes the invite link. Separate switch, per group.
  fileCard: { enabled: false, showLink: false },
  // Custom bad-word list + reply, per group (`.addbadword`, `.delbadword`, `.badwordmsg`, or the dashboard).
  badword: { enabled: false, words: [], message: DEFAULT_BADWORD_MESSAGE },
  // What Antilink / Antibadword / bad-word filter do to a violating message (dashboard: Moderation section).
  modActions: { delete: true, warn: true, kick: true },
  // Per-filter override of the above, e.g. { antilink: { delete: true, warn: false, kick: true } } — set with `.antilink on delete kick`.
  antiActions: {},
});

const DEFAULT_STATE = () => ({
  mode: 'private', // 'public' | 'private' — see PUBLIC_INFO_COMMANDS. OWNER/DEV are never affected by this.
  botOff: false, // `.botoff` → the bot ignores everyone (even other developers) until a developer sends `.boton`
  anticall: { enabled: false }, // global — calls aren't scoped to a group
  devIds: [], // extra developer/owner identities registered via `.setdev` — see notes above HARDCODED_DEV_LIDS
  groups: {},
});

function loadJson(filePath, makeDefault) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      const fresh = makeDefault();
      fs.writeFileSync(filePath, JSON.stringify(fresh, null, 2), 'utf8');
      return fresh;
    }
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return makeDefault();
    return JSON.parse(raw);
  } catch {
    return makeDefault();
  }
}

function saveJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/** Bare digits from a jid ("923001234567@s.whatsapp.net" -> "923001234567"). */
function bareNumber(jid) {
  if (!jid) return null;
  return String(jid).split('@')[0].split(':')[0];
}

function getContextInfo(msg) {
  const m = msg.message || {};
  return (
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.stickerMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    m.audioMessage?.contextInfo ||
    null
  );
}

/** Id of a tapped button/list row (quick-reply, legacy buttons, template, list) or ''. */
function extractButtonId(msg) {
  const m = msg.message || {};
  const native = m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (native) {
    try { return String(JSON.parse(native).id || ''); } catch { /* fall through */ }
  }
  return String(m.buttonsResponseMessage?.selectedButtonId || m.templateButtonReplyMessage?.selectedId || m.listResponseMessage?.singleSelectReply?.selectedRowId || '');
}

const SHOWN_CMD = (c) => (c === 'antispecificword' ? 'antiword' : c === 'antiwachannel' ? 'antiwach' : c);

function extractText(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    ''
  );
}

function getMessageKind(msg) {
  const m = msg.message || {};
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.stickerMessage) return 'sticker';
  if (m.audioMessage) return m.audioMessage.ptt ? 'ptt' : 'audio';
  if (m.documentMessage) return 'document';
  if (m.protocolMessage) return 'protocol';
  if (m.conversation || m.extendedTextMessage) return 'text';
  return 'other';
}

function isForwarded(msg) {
  const ctx = getContextInfo(msg);
  return !!(ctx?.isForwarded || (ctx?.forwardingScore || 0) > 0);
}

function resolveTargetJid(msg, argText) {
  const ctx = getContextInfo(msg);
  if (ctx?.mentionedJid?.[0]) return ctx.mentionedJid[0];
  if (ctx?.participant) return ctx.participant;
  const digits = String(argText || '').replace(/[^0-9]/g, '');
  if (digits.length >= 8) return `${digits}@s.whatsapp.net`;
  return null;
}

function containsBadWord(text, words) {
  if (!text || !words?.length) return false;
  const lower = text.toLowerCase();
  return words.some((w) => w && lower.includes(String(w).toLowerCase()));
}

/** Whole-word (unicode-aware) match, so "ass" doesn't fire on "class". Phrases are matched as-is. */
function containsWholeWord(text, words) {
  if (!text || !words?.length) return false;
  const lower = text.toLowerCase();
  return words.some((w) => {
    const word = String(w || '').trim().toLowerCase();
    if (!word) return false;
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^\\p{L}\\p{N}])' + esc + '($|[^\\p{L}\\p{N}])', 'u').test(lower);
  });
}

function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : `{${k}}`));
}

/**
 * Stub extension point for Antinsfw. There is no offline/local NSFW image
 * classifier bundled here, and this project has no external ML API wired up.
 * This always returns false (never blocks anything) until you replace the
 * body with a real call to an image-moderation model or API of your choice
 * (pass it `imageBuffer`, return true if it should be treated as NSFW).
 * Leaving Antinsfw "on" right now enables the hook but changes no behavior.
 */
async function classifyImageNSFW(_imageBuffer) {
  return false;
}

export class GroupBot {
  /**
   * @param {import('./wa-client.js').WhatsAppClient} wa
   * @param {object} opts
   * @param {string} opts.configPath
   * @param {string} opts.warningsPath
   * @param {import('./history.js').HistoryStore} opts.activityLog
   * @param {import('pino').Logger} opts.logger
   */
  constructor(wa, { configPath, warningsPath, activityLog, logger, antiStatus }) {
    this.wa = wa;
    this.antiStatus = antiStatus || null; // optional: enables `.purgestatus` (manual status removal)
    this.configPath = configPath;
    this.dataDir = path.dirname(configPath);
    this.stats = new StatsStore(path.join(path.dirname(configPath), 'group-stats.json'));
    this._onGroupsUpdate = (ups) => { for (const u of ups || []) if (u?.id && u.announce !== undefined) this.stats.setState(u.id, u.announce); };
    this.courseFiles = new CourseFiles(wa, { logger, credit: () => renderCredit('{poweredBy}', this.dataDir) }); // GITHUB_TOKEN (optional) is read from the environment
    this._badwordCooldown = new Map(); // "group|number" -> last reply timestamp
    this.warningsPath = warningsPath;
    this.activityLog = activityLog;
    this.logger = logger;

    this._floodTracker = new Map(); // "group|number" -> number[] timestamps
    this._spamTracker = new Map(); // "group|number" -> { lastText, streak }
    this._deletedCache = new Map(); // "group|id" -> { senderJid, text, kind, at }
    this._warnedOnceUnsupported = new Set(); // dedupe debug logs for unsupported features
    this._startedAt = Date.now();

    this._onMessages = this._onMessages.bind(this);
    this._onParticipantsUpdate = this._onParticipantsUpdate.bind(this);
    this._onCalls = this._onCalls.bind(this);
  }

  start() {
    this.wa.on('messages', this._onMessages);
    this.wa.on('group-participants-update', this._onParticipantsUpdate);
    this.wa.on('call', this._onCalls);
    this.wa.on('groups-update', this._onGroupsUpdate);
    // Polls for pending join requests every 20s in groups with Approve on.
    // Polling (not an event) because join-request events are not reliably
    // exposed across forks — see class-level doc comment.
    this._approveTimer = setInterval(() => this._pollApprovals().catch(() => {}), 20_000);
    this._scheduleTimer = setInterval(() => this._runSchedules().catch(() => {}), 30_000);
  }

  async _runSchedules() {
    if (this.wa.connectionStatus !== 'open' || this._loadState().botOff) return;
    const tz = process.env.BOT_TZ || 'Asia/Karachi';
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const g = (t) => parts.find((x) => x.type === t)?.value;
    const hhmm = `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
    const day = `${g('year')}-${g('month')}-${g('day')}`;
    const state = this._loadState();
    let dirty = false;
    for (const [jid, gs] of Object.entries(state.groups || {})) {
      const sc = gs?.schedule;
      if (!sc || !jid.endsWith('@g.us')) continue;
      for (const [kind, at, wantClosed] of [['close', sc.closeAt, true], ['open', sc.openAt, false]]) {
        if (!at || at !== hhmm || sc.last?.[kind] === day) continue;
        try {
          const isClosed = await this.wa.isGroupAnnounce(jid);
          sc.last = { ...(sc.last || {}), [kind]: day }; dirty = true;
          if (isClosed === wantClosed) continue; // already in that state (e.g. another linked number did it)
          await this.wa.setGroupAnnounceOnly(jid, wantClosed);
          await this._safeSendText(jid, wantClosed ? '🔒 *Group closed* by schedule. Only admins can message now.' : '🔓 *Group opened* by schedule. Everyone can message now.');
          this._log(jid, { type: 'schedule-' + kind, ok: true });
        } catch { /* not a member / not admin here — skip */ }
      }
    }
    if (dirty) this._saveState(state);
  }

  stop() {
    this.wa.off('messages', this._onMessages);
    this.wa.off('group-participants-update', this._onParticipantsUpdate);
    this.wa.off('call', this._onCalls);
    this.wa.off('groups-update', this._onGroupsUpdate);
    this.stats.flush();
    clearInterval(this._approveTimer);
    clearInterval(this._scheduleTimer);
  }

  // ── state I/O ──────────────────────────────────────────────────────────
  _loadState() {
    const st = loadJson(this.configPath, DEFAULT_STATE);
    // Older state files can lack these keys (a missing `devIds` made .setdev crash with "Something went wrong").
    if (!Array.isArray(st.devIds)) st.devIds = [];
    if (!st.groups || typeof st.groups !== 'object') st.groups = {};
    return st;
  }
  _saveState(state) {
    saveJson(this.configPath, state);
  }
  _getGroupSettings(state, jid) {
    if (!state.groups[jid]) state.groups[jid] = DEFAULT_GROUP_SETTINGS();
    // Groups saved before newer features existed: fill in the missing keys (existing values are never touched).
    const defaults = DEFAULT_GROUP_SETTINGS();
    for (const [k, v] of Object.entries(defaults)) {
      if (!(k in state.groups[jid])) state.groups[jid][k] = v;
      else if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v)) if (!(k2 in state.groups[jid][k])) state.groups[jid][k][k2] = v2;
      }
    }
    return state.groups[jid];
  }
  _loadWarnings() {
    return loadJson(this.warningsPath, () => ({}));
  }
  _saveWarnings(w) {
    saveJson(this.warningsPath, w);
  }

  _log(groupJid, entry) {
    try {
      this.activityLog.add({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'group-bot',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        total: 1,
        success: entry.ok !== false ? 1 : 0,
        failed: entry.ok === false ? 1 : 0,
        unavailable: 0,
        cancelled: false,
        items: [{ groupJid, ...entry }],
      });
    } catch (err) {
      this.logger?.error({ err }, 'group-bot: failed to write activity log');
    }
  }

  /** Is this bare number / raw jid one of: DEV_NUMBER, a pre-seeded @lid, or a `.setdev`-registered id? */
  _isDevId(senderBareNum, senderJid, state) {
    if (senderBareNum && senderBareNum === DEV_NUMBER) return true;
    if (senderBareNum && HARDCODED_DEV_LIDS.includes(senderBareNum)) return true;
    const registered = state?.devIds || [];
    if (registered.some((id) => id === senderJid || bareNumber(id) === senderBareNum)) return true;
    return false;
  }

  /**
   * Authorization is checked FOUR ways, any one of which is enough:
   *   1. `fromMe` — WhatsApp's own flag for "this session sent it". Checked
   *      first and sufficient alone, so the owner's own commands never
   *      depend on number-matching at all.
   *   2. _isDevId() — bare-digits match against DEV_NUMBER, a pre-seeded
   *      @lid, or a `.setdev`-registered id (see notes above the state
   *      default and HARDCODED_DEV_LIDS).
   *   3. wa.isSelfIdentifier(jid) — matches phone-JID vs. @lid forms for
   *      the OWNER's own identity.
   *   4. Resolve every identifier WhatsApp's group participant list has on
   *      record for this sender (via wa.getParticipantIdentifiers) and
   *      run _isDevId against each of them too — covers a fork that DOES
   *      expose a phone<->lid pairing on the participant record even when
   *      the message itself arrived under the other form.
   * Every denial is logged (server logs + .activity) with the raw
   * identifiers involved, specifically so a real developer-number mismatch
   * can be diagnosed from the logs instead of guessed at.
   */
  /**
   * Phone-number identities of a sender whose message arrived under an @lid. WhatsApp puts the phone JID in the
   * key (remoteJidAlt / participantAlt / senderPn …) and the socket keeps a lid→phone mapping — both are used.
   * Without this, the developer writing from a @lid never matched DEV_NUMBER and every command was ignored.
   */
  async _altIds(msg, senderJid) {
    const ids = new Set();
    const k = msg?.key || {};
    for (const v of [k.remoteJidAlt, k.participantAlt, k.senderPn, k.participantPn, msg?.senderPn]) if (v) ids.add(String(v));
    try {
      if (String(senderJid).endsWith('@lid')) {
        const pn = await this.wa.sock?.signalRepository?.lidMapping?.getPNForLID?.(senderJid);
        if (pn) ids.add(String(pn));
      }
    } catch { /* mapping not available in this fork */ }
    return [...ids];
  }

  async _isAuthorized({ fromMe, senderJid, senderBareNum, groupJid, state, msg }) {
    if (fromMe) return true;
    const rv = state?.revokedIds;
    if (rv?.length && senderBareNum !== DEV_NUMBER) {
      const bares = new Set([senderBareNum]);
      try { for (const id of await this._altIds(msg || { key: {} }, senderJid)) bares.add(bareNumber(id)); } catch { /* none */ }
      try { for (const b of await this._idBares(groupJid || null, senderJid)) bares.add(b); } catch { /* none */ }
      if (!bares.has(DEV_NUMBER) && [...bares].some((b) => rv.includes(b))) return false; // access was revoked for attacking the boss
    }
    if (this._isDevId(senderBareNum, senderJid, state)) return true;
    if (this.wa.isSelfIdentifier(senderJid)) return true;
    if (msg) {
      const alts = await this._altIds(msg, senderJid);
      const hit = alts.find((id) => this._isDevId(bareNumber(id), id, state) || this.wa.isSelfIdentifier(id));
      if (hit) {
        // Remember this @lid as the developer so later messages match instantly.
        if (String(senderJid).endsWith('@lid') && !(state.devIds || []).includes(senderJid)) {
          try { const st = this._loadState(); st.devIds = [...new Set([...(st.devIds || []), senderJid])]; this._saveState(st); } catch { /* non-fatal */ }
        }
        return true;
      }
    }
    if (groupJid) {
      try {
        const ids = await this._resolveParticipantIdentifiers(groupJid, senderJid);
        if (ids.some((id) => this._isDevId(bareNumber(id), id, state))) return true;
      } catch {
        /* fall through to unauthorized */
      }
    }
    return false;
  }

  /** getParticipantIdentifiers() result, cached briefly per (group, sender) — group membership/identifiers don't change every second, and this runs on every command from an unrecognized number. */
  async _resolveParticipantIdentifiers(groupJid, senderJid) {
    const key = `${groupJid}|${senderJid}`;
    const cached = this._idCache?.get(key);
    if (cached && Date.now() - cached.at < 30_000) return cached.ids;
    const ids = await this.wa.getParticipantIdentifiers(groupJid, senderJid);
    if (!this._idCache) this._idCache = new Map();
    this._idCache.set(key, { ids, at: Date.now() });
    return ids;
  }

  async _senderIsDeveloper({ senderJid, senderBareNum, groupJid, state, msg }) {
    if (this._isDevId(senderBareNum, senderJid, state)) return true;
    const alts = await this._altIds(msg, senderJid);
    if (alts.some((id) => this._isDevId(bareNumber(id), id, state))) return true;
    if (groupJid) {
      try { return (await this._resolveParticipantIdentifiers(groupJid, senderJid)).some((id) => this._isDevId(bareNumber(id), id, state)); } catch { /* no */ }
    }
    return false;
  }

  async _isDevTarget(groupJid, targetJid, state) {
    if (this._isDevId(bareNumber(targetJid), targetJid, state)) return true;
    if (groupJid) {
      try { return (await this._resolveParticipantIdentifiers(groupJid, targetJid)).some((id) => this._isDevId(bareNumber(id), id, state)); } catch { /* no */ }
    }
    return false;
  }

  async _safeSendText(jid, text, mentions = []) {
    try {
      await this.wa.sendText(jid, text, mentions);
    } catch (err) {
      this.logger?.error({ err, jid }, 'group-bot: sendText failed');
    }
  }

  async _groupName(jid) {
    try {
      const meta = await this.wa.getGroupMetadata(jid);
      return meta.subject || jid;
    } catch {
      return jid;
    }
  }

  // ── warnings (shared by manual .warn and every auto-moderation trigger) ──
  _warnKey(groupJid, bareNum) {
    return `${groupJid}|${bareNum}`;
  }

  /** @returns {{count:number, limit:number}} */
  _addWarning(groupJid, bareNum, limit) {
    const w = this._loadWarnings();
    const key = this._warnKey(groupJid, bareNum);
    w[key] = (w[key] || 0) + 1;
    this._saveWarnings(w);
    return { count: w[key], limit };
  }

  _resetWarning(groupJid, bareNum) {
    const w = this._loadWarnings();
    delete w[this._warnKey(groupJid, bareNum)];
    this._saveWarnings(w);
  }

  _getWarningCount(groupJid, bareNum) {
    const w = this._loadWarnings();
    return w[this._warnKey(groupJid, bareNum)] || 0;
  }

  // ── message pipeline ──────────────────────────────────────────────────
  async _onMessages(messages) {
    for (const msg of messages) {
      try {
        await this._handleMessage(msg);
      } catch (err) {
        this.logger?.error({ err }, 'group-bot: message handling failed');
      }
    }
  }

  async _handleMessage(msg) {
    if (!msg?.message || !msg?.key?.remoteJid) return;
    try { PREFIX = getBranding(this.dataDir).prefix || '.'; } catch { /* keep current */ }
    const groupJid = msg.key.remoteJid;
    const isGroup = groupJid.endsWith('@g.us');

    // Duplicate guard: the same WhatsApp message id is only ever processed once (reconnect/history replays,
    // two listeners firing, etc. used to make the bot answer the same request twice).
    if (msg.key.id) {
      if (!this._seenIds) this._seenIds = new Set();
      const sid = `${groupJid}|${msg.key.id}`;
      if (this._seenIds.has(sid)) return;
      this._seenIds.add(sid);
      if (this._seenIds.size > 3000) this._seenIds.delete(this._seenIds.values().next().value);
    }

    // Antidelete: a delete shows up as a NEW message whose content is a
    // protocolMessage of type REVOKE, referencing the original message's key.
    const proto = msg.message.protocolMessage;
    if (proto?.type === 'REVOKE' || proto?.type === 0) {
      if (isGroup) await this._handleRevoke(groupJid, proto);
      return;
    }

    const selfBareNum = bareNumber(this.wa.getSelfJid());
    const senderJid = msg.key.fromMe ? this.wa.getSelfJid() : msg.key.participant || msg.key.remoteJid;
    const senderBareNum = bareNumber(senderJid);
    // `.botoff`: nothing is obeyed (commands, filters, files) until a developer sends `.boton`.
    const stOff = this._loadState();
    if (stOff.botOff) {
      const t0 = extractText(msg).trim();
      if (t0.startsWith(PREFIX) && /^boton$/i.test(t0.slice(PREFIX.length).trim().split(/\s+/)[0] || '')) {
        const okDev = await this._isAuthorized({ fromMe: !!msg.key.fromMe, senderJid, senderBareNum, groupJid: isGroup ? groupJid : null, state: stOff, msg }).catch(() => false);
        if (okDev) { stOff.botOff = false; this._saveState(stOff); await this._safeSendText(groupJid, '▶️ *Bot ON.* Back to work.'); }
      }
      return;
    }
    if (isGroup && !msg.key.fromMe && msg.key.participant) {
      const statK = await this._statKey(groupJid, msg.key.participant, msg.key.participantAlt);
      this.stats.record(groupJid, statK, Date.now(), msg.key.participant);
      // `.ban`: every message from a banned member is deleted at once.
      const gsBan = this._getGroupSettings(this._loadState(), groupJid);
      if ((gsBan.banned || []).length) {
        const ids = new Set([statK, ...(await this._idBares(groupJid, msg.key.participant))]);
        if (msg.key.participantAlt) ids.add(bareNumber(msg.key.participantAlt));
        if ([...ids].some((b) => gsBan.banned.includes(b)) && !(await this._isSuperDev({ senderJid, senderBareNum, groupJid, msg }))) {
          await this.wa.deleteMessageForEveryone(groupJid, msg.key).catch(() => {});
          this._banNotice ||= new Map();
          const nk = `${groupJid}|${statK}`;
          if (Date.now() - (this._banNotice.get(nk) || 0) > 20_000) {
            this._banNotice.set(nk, Date.now());
            await this._safeSendText(groupJid, `🚫 @${senderBareNum} you disrespected the developer, so you are banned.\nYou cannot send messages in this group.`, [senderJid]);
          }
          return;
        }
      }
    }
    let text = extractText(msg).trim();

    // A tapped button of the button menu (`.menu`): navigate / switch / run.
    const mnId = extractButtonId(msg);
    if (mnId.startsWith('mn:')) {
      await this._menuButton({ msg, mnId, groupJid, isGroup, senderJid, senderBareNum, selfBareNum });
      return;
    }

    // A tapped course-files button behaves exactly like the member typing that request themselves.
    let viaButton = false;
    if (isGroup && !msg.key.fromMe) {
      const btnText = CourseFiles.buttonToText(extractButtonId(msg));
      if (btnText) {
        text = btnText;
        viaButton = true;
        const menuId = msg.message?.interactiveResponseMessage?.contextInfo?.stanzaId
          || msg.message?.buttonsResponseMessage?.contextInfo?.stanzaId
          || msg.message?.templateButtonReplyMessage?.contextInfo?.stanzaId
          || msg.message?.listResponseMessage?.contextInfo?.stanzaId;
        this.courseFiles.vanishMenu(groupJid, menuId).catch(() => {}); // not awaited: files start at the same moment
      }
    }

    // Cache every group message briefly, for Antidelete to reconstruct from.
    if (isGroup && !msg.key.fromMe) {
      this._cacheForAntidelete(groupJid, msg.key.id, {
        senderJid,
        text: text || `[${getMessageKind(msg)}]`,
        at: Date.now(),
      });
    }

    // `.help` — for EVERYONE: step-by-step Urdu guide on how to get files.
    if (!msg.key.fromMe && new RegExp('^[.!' + PREFIX.replace(/[\\\]\[\^-]/g, '\\$&') + ']help$', 'i').test(text)) {
      if (isGroup && !this._getGroupSettings(this._loadState(), groupJid).fileAccess?.enabled) {
        const okDev = await this._isAuthorized({ fromMe: false, senderJid, senderBareNum, groupJid, state: this._loadState(), msg }).catch(() => false);
        if (!okDev) return; // files are OFF → only developers get an answer
      }
      await this._safeSendText(groupJid, USER_HELP_URDU.replace('{user}', `@${senderBareNum}`), [senderJid]);
      return;
    }

    // Members the developer blocked from files (`.nofile @user`): answer their file requests with a polite refusal.
    if (isGroup && !msg.key.fromMe && text) {
      const gsB = this._getGroupSettings(this._loadState(), groupJid);
      if (gsB.fileAccess?.enabled && (gsB.fileBlocked || []).includes(senderBareNum)) {
        const rq = parseRequest(text);
        if ((rq && rq.code) || isReadCommand(text)) {
          await this._safeSendText(groupJid, `@${senderBareNum} sorry bro, there are no files available for you here ❌`, [senderJid]);
          return;
        }
      }
    }

    // Owner/dev course-file admin: .stats / .files / .folders / .mids … and .upload (+ the files sent while an upload is open).
    // Cheap pre-check first, so the (slower) authorization lookup only runs when it can matter.
    if ((text && CourseFiles.isAdminText(text)) || (getMessageKind(msg) === 'document' && this.courseFiles.hasOpenUpload(groupJid, senderBareNum))) {
      const st = this._loadState();
      const isAdmin = await this._isAuthorized({ fromMe: !!msg.key.fromMe, senderJid, senderBareNum, groupJid: isGroup ? groupJid : null, state: st, msg });
      if (isAdmin) {
        const done = await this.courseFiles
          .handleAdmin({ groupJid, senderBare: senderBareNum, senderJid, text, msg, isAdmin })
          .catch((err) => { this.logger?.error({ err }, 'group-bot: course files admin failed'); return false; });
        if (done) return;
      }
    }

    const isBoss = isGroup && !msg.key.fromMe ? await this._isSuperDev({ senderJid, senderBareNum, groupJid, msg }) : false;
    // The boss asked for files → raise the "boss first" flag RIGHT NOW (before any slow lookup) so nobody else is served ahead of him.
    if (isBoss && text && (parseRequest(text) || isReadCommand(text) || /^\.?more$/i.test(text.trim()))) markBossRequest();
    // Files switched OFF → only developers may still use them; ON → every member can.
    const filesUsable = async (fs0) => {
      if (fs0?.enabled || isBoss) return true;
      if (!isGroup || msg.key.fromMe) return !!msg.key.fromMe;
      if (!(parseRequest(text) || isReadCommand(text) || /^\.?more$/i.test(text.trim()))) return false;
      return !!(await this._isAuthorized({ fromMe: false, senderJid, senderBareNum, groupJid, state: this._loadState(), msg }).catch(() => false));
    };

    // Course files — picture reader: reply to a picture with `.read` (or caption a picture with it) and the bot
    // scans it for subject codes, then sends the files batch by batch (`more` for the next batch).
    if (isGroup && !msg.key.fromMe && text && isReadCommand(text)) {
      const groupSettings = this._getGroupSettings(this._loadState(), groupJid);
      const fileSettings = groupSettings.fileAccess;
      if (await filesUsable(fileSettings)) {
        const consumed = await this.courseFiles
          .handleRead({ groupJid, senderBare: senderBareNum, senderJid, msg, batchSize: fileSettings.batchSize, card: groupSettings.fileCard, log: (e) => this._log(groupJid, e), boss: isBoss })
          .catch((err) => { this.logger?.error({ err }, 'group-bot: course files .read failed'); return false; });
        if (consumed) return;
      }
    }

    // Course files: any member may type a course code (with or without ".") in a group where `.fileon` was
    // used — independent of public/private mode. Checked before command routing so ".cs101" / ".more" work
    // for everyone, but only a real folder / the sender's own open menu is ever consumed.
    if (isGroup && text && (viaButton || getMessageKind(msg) === 'text')) {
      const groupSettings = this._getGroupSettings(this._loadState(), groupJid);
      const fileSettings = groupSettings.fileAccess;
      if (await filesUsable(fileSettings)) {
        const consumed = await this.courseFiles
          .handle({ groupJid, senderBare: senderBareNum, senderJid, text, msg, batchSize: fileSettings.batchSize, card: groupSettings.fileCard, log: (e) => this._log(groupJid, e), boss: isBoss })
          .catch((err) => { this.logger?.error({ err }, 'group-bot: course files handler failed'); return false; });
        if (consumed) return;
      }
    }

    // "Babli" voice-style commands (developers only, no prefix needed) — see src/babli.js
    if (text && !text.startsWith(PREFIX) && isBabliMsg(msg, text)) {
      const handled = await babliHandle(this, { msg, text, groupJid, isGroup, senderJid, senderBareNum, selfBareNum, P: PREFIX });
      if (handled) return;
    }

    if (text.startsWith(PREFIX)) {
      await this._handleCommand({ msg, groupJid, isGroup, senderJid, senderBareNum, selfBareNum, fromMe: !!msg.key.fromMe, text });
      return;
    }

    if (!isGroup) return; // auto-moderation only applies inside groups
    if (text && !msg.key.fromMe) defendBoss(this, { msg, text, groupJid, senderJid, senderBareNum }).catch(() => {}); // never blocks moderation
    await this._autoModerate({ msg, groupJid, senderJid, senderBareNum, selfBareNum });
  }

  _cacheForAntidelete(groupJid, id, data) {
    const key = `${groupJid}|${id}`;
    this._deletedCache.set(key, data);
    if (this._deletedCache.size > 1000) {
      const oldest = this._deletedCache.keys().next().value;
      this._deletedCache.delete(oldest);
    }
  }

  async _handleRevoke(groupJid, proto) {
    const state = this._loadState();
    const settings = this._getGroupSettings(state, groupJid);
    if (!settings.antidelete) return;
    const originalId = proto.key?.id;
    if (!originalId) return;
    const cached = this._deletedCache.get(`${groupJid}|${originalId}`);
    if (!cached) return; // never seen it, or it was our own outgoing message
    const senderNum = bareNumber(cached.senderJid);
    await this._safeSendText(
      groupJid,
      `🗑️ *Antidelete*: @${senderNum} deleted a message:\n\n${cached.text}`,
      [cached.senderJid]
    );
    this._log(groupJid, { type: 'antidelete', sender: senderNum });
  }

  // ── auto-moderation (runs on ordinary messages, never on commands) ──────
  async _autoModerate({ msg, groupJid, senderJid, senderBareNum, selfBareNum }) {
    const state = this._loadState();
    const settings = this._getGroupSettings(state, groupJid);

    // Soft-muted members: delete everything from them, no other checks needed.
    if (settings.mutedMembers.includes(senderBareNum)) {
      await this.wa.deleteMessageForEveryone(groupJid, msg.key).catch(() => {});
      return;
    }

    // OWNER/DEV and current group admins are exempt from every auto-filter
    // below — they configured these filters for everyone else, not themselves.
    if (senderBareNum === selfBareNum || (await this._isAuthorized({ fromMe: !!msg.key.fromMe, senderJid, senderBareNum, groupJid, state, msg }))) return;
    let isAdmin = false;
    try {
      const status = await this.wa.checkAdminStatus(groupJid, senderJid);
      isAdmin = status.targetIsAdmin;
    } catch {
      /* if we can't verify, fall through and still apply filters */
    }
    if (isAdmin) return;

    const kind = getMessageKind(msg);
    const text = extractText(msg);
    const ctx = getContextInfo(msg);

    const violate = (reason) => this._violate({ msg, groupJid, senderJid, senderBareNum, settings, reason });

    if (settings.badword?.enabled && containsWholeWord(text, settings.badword.words)) {
      const act = { delete: true, warn: true, kick: true, ...(settings.modActions || {}) };
      if (act.delete) await this.wa.deleteMessageForEveryone(groupJid, msg.key).catch(() => {});
      const cdKey = `${groupJid}|${senderBareNum}`;
      if (Date.now() - (this._badwordCooldown.get(cdKey) || 0) > 10_000) {
        this._badwordCooldown.set(cdKey, Date.now());
        let count = 0;
        let limit = settings.warnLimit || 3;
        let kicked = false;
        if (act.warn) {
          ({ count, limit } = this._addWarning(groupJid, senderBareNum, limit));
          if (act.kick && count >= limit) {
            kicked = await this.wa.removeParticipant(groupJid, senderJid).then(() => true).catch(() => false);
            if (kicked) this._resetWarning(groupJid, senderBareNum);
          }
        } else if (act.kick) {
          kicked = await this.wa.removeParticipant(groupJid, senderJid).then(() => true).catch(() => false);
        }
        const groupName = await this._groupName(groupJid);
        const out = renderTemplate(settings.badword.message || DEFAULT_BADWORD_MESSAGE, { user: `@${senderBareNum}`, group: groupName, count: String(count), limit: String(limit) });
        await this._safeSendText(groupJid, out, [senderJid]);
        if (kicked) await this._safeSendText(groupJid, act.warn ? `🚫 @${senderBareNum} removed — reached ${limit} warnings.` : `🚫 @${senderBareNum} removed.`, [senderJid]);
        this._log(groupJid, { type: 'badword', sender: senderBareNum, warnCount: count, kicked, deleted: !!act.delete });
      }
      return;
    }
    if (settings.antichannel && CHANNEL_RE.test(text)) return void (await violate('Antichannel: channel link is not allowed here'));
    if (settings.linkRules && text) {
      const types = linkTypesIn(text);
      for (const t of types) {
        const r = settings.linkRules[t];
        if (r?.enabled) return void (await this._violate({ msg, groupJid, senderJid, senderBareNum, settings, reason: `Link blocked (${t}) — not allowed here`, actOverride: { delete: r.delete !== false, warn: r.warn !== false, kick: r.kick !== false } }));
      }
    }
    if (settings.antilink && LINK_RE.test(text)) return void (await violate('Antilink: links are not allowed here'));
    if (settings.antisticker && kind === 'sticker') return void (await violate('Antisticker: stickers are not allowed here'));
    if (settings.antimedia && ['image', 'video', 'sticker', 'audio', 'ptt', 'document'].includes(kind))
      return void (await violate('Antimedia: media is not allowed here'));
    if (settings.autophoto && kind === 'image') return void (await violate('Autophoto: photos are not allowed here'));
    if (settings.autovideo && kind === 'video') return void (await violate('Autovideo: videos are not allowed here'));
    if (settings.antivoice && kind === 'ptt') return void (await violate('Antivoice: voice notes are not allowed here'));
    if (settings.antiforward && isForwarded(msg)) return void (await violate('Antiforward: forwarded messages are not allowed here'));
    if (settings.antibadword && containsBadWord(text, DEFAULT_BAD_WORDS)) return void (await violate('Antibadword: watch your language'));
    if (settings.antispecificword?.enabled && containsBadWord(text, settings.antispecificword.words))
      return void (await violate('Antispecificword: that word is not allowed here'));
    if (settings.antimention?.enabled) {
      const n = ctx?.mentionedJid?.length || 0;
      if (n > settings.antimention.limit) return void (await violate(`Antimention: tagged too many members at once (${n})`));
    }
    if (kind === 'image' && settings.antinsfw) {
      // Hook only — see classifyImageNSFW() doc comment above. Buffer is not
      // downloaded here (no media-download pipeline wired to this handler);
      // this is left as a clearly-marked stub, not a working filter.
      const flagged = await classifyImageNSFW(null);
      if (flagged) return void (await violate('Antinsfw: image flagged as inappropriate'));
    }

    // Antispam: same text repeated back-to-back by the same sender.
    if (settings.antispam?.enabled && text) {
      const key = `${groupJid}|${senderBareNum}`;
      const prev = this._spamTracker.get(key);
      const now = Date.now();
      if (prev && prev.lastText === text && now - prev.at <= settings.antispam.windowSec * 1000) {
        prev.streak += 1;
        prev.at = now;
        if (prev.streak >= settings.antispam.limit) {
          prev.streak = 0;
          return void (await violate('Antispam: repeated message spam'));
        }
      } else {
        this._spamTracker.set(key, { lastText: text, streak: 1, at: now });
      }
    }

    // Antiflood: too many messages (any content) in a short window.
    if (settings.antiflood?.enabled) {
      const key = `${groupJid}|${senderBareNum}`;
      const now = Date.now();
      const windowMs = settings.antiflood.windowSec * 1000;
      const arr = (this._floodTracker.get(key) || []).filter((t) => now - t <= windowMs);
      arr.push(now);
      this._floodTracker.set(key, arr);
      if (arr.length > settings.antiflood.limit) {
        this._floodTracker.set(key, []);
        return void (await violate('Antiflood: sending messages too fast'));
      }
    }
  }

  async _violate({ msg, groupJid, senderJid, senderBareNum, settings, reason, actOverride }) {
    const antiKey = String(reason || '').split(':')[0].toLowerCase();
    const act = { delete: true, warn: true, kick: true, ...(settings.modActions || {}), ...(settings.antiActions?.[antiKey] || {}), ...(actOverride || {}) };
    if (act.delete) await this.wa.deleteMessageForEveryone(groupJid, msg.key).catch(() => {});
    let count = 0;
    let limit = settings.warnLimit || 3;
    let kicked = false;
    let instant = false;
    if (act.warn) {
      ({ count, limit } = this._addWarning(groupJid, senderBareNum, limit));
      if (act.kick && count >= limit) {
        kicked = await this.wa.removeParticipant(groupJid, senderJid).then(() => true).catch(() => false);
        if (kicked) this._resetWarning(groupJid, senderBareNum);
      }
    } else if (act.kick) { // kick without warn → removed straight away
      instant = true;
      kicked = await this.wa.removeParticipant(groupJid, senderJid).then(() => true).catch(() => false);
    }
    this._log(groupJid, { type: 'auto-moderation', reason, sender: senderBareNum, warnCount: count, kicked, deleted: !!act.delete });
    if (kicked) {
      await this._safeSendText(groupJid, instant ? `🚫 @${senderBareNum} removed.\n${reason}` : `🚫 @${senderBareNum} removed — reached ${limit} warnings.\nLast reason: ${reason}`, [senderJid]);
    } else if (act.warn) {
      await this._safeSendText(groupJid, `⚠️ @${senderBareNum} — ${reason}\nWarning ${count}/${limit}.`, [senderJid]);
    }
  }

  // ── remote control from the developer's inbox ───────────────────────────
  _remoteStore() { return (this._remote ||= { groups: [], scan: null }); }

  async _remoteLoadGroups() {
    const list = await this.wa.getGroups();
    const R = this._remoteStore();
    R.groups = list.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return R.groups;
  }

  async _remoteCommand({ cmd, argText, chatJid, reply, inGroup = false }) {
    const R = this._remoteStore();
    const toks = argText.split(/\s+/).filter(Boolean);
    const pick = async (token) => {
      const n = Number(token);
      if (!Number.isInteger(n) || n < 1) return null;
      if (!R.groups.length) await this._remoteLoadGroups();
      return R.groups[n - 1] || null;
    };

    if (cmd === 'groups' || cmd === 'mygroups') {
      const list = await this._remoteLoadGroups();
      if (!list.length) return reply('No groups found.'), true;
      // In a group the invite links are left out unless asked for (`.groups links`) so members don't see them by accident.
      const withLinks = inGroup ? toks.some((t) => /^links?$/i.test(t)) : !toks.some((t) => /^(short|nolinks)$/i.test(t));
      const admins = list.filter((g) => g.isSelfAdmin).length;
      if (withLinks) await reply(`⏳ Building the list of ${list.length} groups…`);
      // invite links only exist where this number is admin — fetched 5 at a time so it stays fast
      const links = new Map();
      if (withLinks) {
        const adminGroups = list.filter((g) => g.isSelfAdmin);
        for (let i = 0; i < adminGroups.length; i += 5) {
          await Promise.all(adminGroups.slice(i, i + 5).map(async (g) => links.set(g.jid, await this.wa.getInviteLink(g.jid))));
        }
      }
      const locked = list.filter((g) => g.announce).length;
      const head = [
        '╔══════════════════╗',
        `   📋 *MY GROUPS* · ${list.length}`,
        '╚══════════════════╝',
        `🛡️ Admin *${admins}*  ·  👤 Member *${list.length - admins}*  ·  🔒 Locked *${locked}*`,
        '',
      ].join('\n');
      const rows = list.map((g, i) => [
        `╭─ *${String(i + 1).padStart(2, '0')}* ─────────────`,
        `│ 📛 *${g.name}*`,
        `│ ${g.isSelfAdmin ? '🛡️ Admin' : '👤 Member'} · ${g.announce ? '🔒 Locked' : '🔓 Open'} · 👥 ${g.participants}`,
        withLinks ? `│ 🔗 ${links.get(g.jid) || (g.isSelfAdmin ? 'link unavailable' : '— (bot is not admin)')}` : null,
        '╰───────────────────',
      ].filter(Boolean).join('\n'));
      let buf = head;
      for (const r of rows) { if ((buf + r).length > 3300) { await reply(buf.trimEnd()); buf = ''; } buf += r + '\n'; }
      await reply(`${buf}\n✏️ *Control by number*\n${PREFIX}lock 3 · ${PREFIX}unlock 3\n${PREFIX}lock 3 t <text>  → lock + text\n${PREFIX}lock 3 <text>  → lock + voice\n${PREFIX}at 3 antilink on  → any command\n${PREFIX}settings 3 · ${PREFIX}poststatus 3 · ${PREFIX}rmstatus 3`);
      return true;
    }

    if (['lock', 'unlock', 'mute', 'unmute', 'close', 'open'].includes(cmd) && /^\d+$/.test(toks[0] || '')) {
      const g = await pick(toks[0]);
      if (!g) return reply(`❌ No group number ${toks[0]}. Send ${PREFIX}groups first.`), true;
      const lockIt = ['lock', 'mute', 'close'].includes(cmd);
      const note = toks.slice(1).join(' ');
      try {
        await this.wa.setGroupAnnounceOnly(g.jid, lockIt);
        g.announce = lockIt;
        this._log(g.jid, { type: 'remote-' + cmd, ok: true });
      } catch {
        return reply(`❌ Could not ${lockIt ? 'lock' : 'unlock'} *${g.name}* — I need to be admin there.`), true;
      }
      let voiceInfo = '';
      const flag = /^(t|v|vt)$/i.test(toks[1] || '') ? toks[1].toLowerCase() : null;
      const msgText = flag ? toks.slice(2).join(' ') : note;
      if (msgText) {
        const wantText = flag === 't' || flag === 'vt';
        const wantVoice = flag !== 't';
        if (wantText) { await this._safeSendText(g.jid, msgText); voiceInfo += ' · 💬 text sent'; }
        if (wantVoice) {
          try { await this.wa.sendVoice(g.jid, await textToVoice(msgText)); voiceInfo += ' · 🎙️ voice sent'; }
          catch { voiceInfo += ' · ⚠️ voice failed'; if (!wantText) await this._safeSendText(g.jid, msgText); }
        }
      }
      return reply(`${lockIt ? '🔒 Locked' : '🔓 Unlocked'}: *${g.name}*${voiceInfo}`), true;
    }

    if (cmd === 'voice' || cmd === 'say') {
      const g = await pick(toks[0]);
      const note = toks.slice(1).join(' ');
      if (!g || !note) return reply(`Usage: ${PREFIX}${cmd} <group number> <text>`), true;
      try {
        if (cmd === 'say') await this._safeSendText(g.jid, note);
        else await this.wa.sendVoice(g.jid, await textToVoice(note));
        return reply(`✅ ${cmd === 'say' ? 'Message' : '🎙️ Voice'} sent to *${g.name}*.`), true;
      } catch (e) { return reply(`❌ Failed: ${String(e?.message || e).slice(0, 120)}`), true; }
    }

    if (cmd === 'scan' || cmd === 'findnumber') {
      const digits = argText.replace(/\D/g, '');
      if (digits.length < 8) return reply(`Usage: ${PREFIX}scan <phone number with country code>`), true;
      await reply(`🔎 Scanning groups for +${digits} …`);
      const found = await this.wa.findNumberInGroups(digits);
      R.scan = { number: digits, groups: found };
      if (!found.length) return reply(`+${digits} is not in any of my groups.`), true;
      const rows = found.map((g, i) => `${i + 1}. ${g.name}${g.isAdmin ? ' (🛡️ admin there)' : ''}${g.selfAdmin ? '' : ' — ⚠️ I am not admin'}`);
      await reply(`🎯 Target set: +${digits} is in ${found.length} group(s):\n\n${rows.join('\n')}\n\nRemove with: ${PREFIX}remove 2  ·  ${PREFIX}remove all`);
      return true;
    }

    if (cmd === 'remove' || cmd === 'removefrom') {
      if (!R.scan?.groups?.length) return reply(`First set a target: ${PREFIX}scan <number>`), true;
      if (R.scan.number === DEV_NUMBER || this._isDevId(R.scan.number, `${R.scan.number}@s.whatsapp.net`, this._loadState())) return reply('🛡️ That is *Saif Boss*. He cannot be removed from any group.'), true;
      const which = toks[0] === 'all' ? R.scan.groups : toks.map((t) => R.scan.groups[Number(t) - 1]).filter(Boolean);
      if (!which.length) return reply(`Usage: ${PREFIX}remove <number from the scan list> | all`), true;
      const lines = [];
      for (const g of which) {
        const ok = await this.wa.removeParticipant(g.jid, g.participantJid).then(() => true).catch(() => false);
        this._log(g.jid, { type: 'remote-remove', target: R.scan.number, ok });
        lines.push(`${ok ? '✅ Removed from' : '❌ Could not remove from'} ${g.name}`);
      }
      return reply(lines.join('\n')), true;
    }
    return false;
  }

  // ── group-membership events (Welcome/Goodbye/Autokick) ──────────────────
  /** Newer Baileys versions send participants as objects ({id, phoneNumber, lid, admin}) instead of plain JID strings. */
  _normParticipant(p) {
    if (!p) return null;
    if (typeof p === 'string') return { jid: p, bare: bareNumber(p) };
    const jid = p.id || p.jid || p.lid || p.phoneNumber;
    const phone = p.phoneNumber || (String(p.id || '').endsWith('@s.whatsapp.net') ? p.id : null) || (String(p.jid || '').endsWith('@s.whatsapp.net') ? p.jid : null);
    if (!jid) return null;
    return { jid, bare: bareNumber(phone || jid) };
  }

  async _onParticipantsUpdate({ id: groupJid, participants, action, author }) {
    if (!groupJid?.endsWith('@g.us') || !participants?.length) return;
    if (this._loadState().botOff) return;
    this.logger?.info({ groupJid, action, n: participants.length }, 'group-bot: participants update');
    // This account was just made admin → switch Anti-Status ON for this group automatically.
    if (action === 'promote' && this.antiStatus && participants.some((raw) => { const np = this._normParticipant(raw); return np && (this.wa.isSelfIdentifier?.(np.jid) || np.bare === bareNumber(this.wa.getSelfJid())); })) {
      try {
        if (this.antiStatus.enableForNewAdminGroup(groupJid)) {
          this._log(groupJid, { type: 'antistatus-auto-on', ok: true });
          await this._safeSendText(groupJid, '🛡️ Main is group mein admin ban gaya — *Anti-Status* automatically ON ho gaya.\nAb koi status mein group ko mention karega to status delete + warning milegi, aur admins ko alert jayega.');
        }
      } catch (e) { this.logger?.warn({ e: String(e?.message || e) }, 'antistatus auto-enable failed'); }
    }
    // The bot itself was removed as admin → say who did it and leave the group right away.
    if (action === 'demote' && participants.some((raw) => { const np = this._normParticipant(raw); return np && (this.wa.isSelfIdentifier?.(np.jid) || np.bare === bareNumber(this.wa.getSelfJid())); })) {
      const ab = author ? bareNumber(author) : null;
      await this._safeSendText(groupJid, ab ? `⚠️ @${ab} removed my admin rights, so I am leaving this group. 👋` : '⚠️ My admin rights were removed, so I am leaving this group. 👋', author ? [author] : []);
      await new Promise((r) => setTimeout(r, 800));
      await this.wa.leaveGroup(groupJid).catch((e) => this.logger?.warn({ e: String(e?.message || e) }, 'leave after demote failed'));
      this._log(groupJid, { type: 'left-after-demote', ok: true });
      return;
    }
    // ── Admin guard: undo unauthorised promotions / demotions and alert everyone ──
    if ((action === 'promote' || action === 'demote') && author) {
      const st0 = this._loadState();
      const gs0 = this._getGroupSettings(st0, groupJid);
      const targets = participants.map((raw) => this._normParticipant(raw)).filter(Boolean);
      const hitsBoss = (await Promise.all(targets.map((t) => this._isSuperTarget(groupJid, t.jid)))).some(Boolean);
      const aN = this._normParticipant(author);
      const authorJid = aN?.jid || author;
      const authorBare = aN?.bare || bareNumber(author);
      const privileged = this.wa.isSelfIdentifier?.(author) || (await this._isAuthorized({ fromMe: false, senderJid: author, senderBareNum: authorBare, groupJid, state: st0 }));
      if (!privileged) { // Master Guard: always on in every group
        const meta = await this.wa.getGroupMetadata(groupJid).catch(() => null);
        const admins = (meta?.participants || []).filter((p) => p.admin).map((p) => p.id).filter((id) => id && id !== author && id !== authorJid);
        const ping = [...new Set([...admins, `${DEV_NUMBER}@s.whatsapp.net`])];
        const pingText = ping.map((j) => `@${bareNumber(j)}`).join(' ');
        const tText = targets.map((t) => `@${t.bare}`).join(' ');
        const mentionList = [...new Set([authorJid, ...targets.map((t) => t.jid), ...ping])];
        const authorIsSuper = await this._isSuperTarget(groupJid, authorJid).catch(() => false);
        if (action === 'promote') {
          // Undo: the one who got promoted loses admin AND the admin who promoted him loses admin too.
          for (const t of targets) if (!this.wa.isSelfIdentifier?.(t.jid) && !(await this._isSuperTarget(groupJid, t.jid).catch(() => false))) await this.wa.demoteParticipant(groupJid, t.jid).catch(() => {});
          if (!authorIsSuper) await this.wa.demoteParticipant(groupJid, authorJid).catch(() => {});
          await this._safeSendText(groupJid, `🚨 *ADMIN GUARD*\n@${authorBare} tried to make ${tText} an admin.\n↩️ Reversed: ${tText} is not an admin, and @${authorBare} was removed from admin too.\n\n👀 ${pingText}\nPlease keep an eye on this.`, mentionList);
        } else {
          // Undo: the dismissed admin(s) get admin back AND the one who demoted them loses admin.
          for (const t of targets) await this.wa.promoteParticipant(groupJid, t.jid).catch(() => {});
          if (!authorIsSuper) await this.wa.demoteParticipant(groupJid, authorJid).catch(() => {});
          await this._safeSendText(groupJid, `🚨 *ADMIN GUARD*\n@${authorBare} tried to demote ${tText}.\n↩️ Reversed: ${tText} restored as admin, and @${authorBare} was removed from admin.\n\n👀 ${pingText}\nPlease keep an eye on this.`, mentionList);
        }
        this._log(groupJid, { type: 'admin-guard-' + action, target: targets.map((t) => t.bare).join(','), by: authorBare, ok: true });
        return;
      }
    }
    // ── Always tell the group's admins when someone is made admin / dismissed from admin ──
    if ((action === 'promote' || action === 'demote') && author && !this.wa.isSelfIdentifier?.(author) && !(await this._isSuperTarget(groupJid, author).catch(() => false))) {
      const aBare = bareNumber(author);
      const tg = participants.map((raw) => this._normParticipant(raw)).filter(Boolean).filter((t) => !this.wa.isSelfIdentifier?.(t.jid));
      if (tg.length) {
        const meta = await this.wa.getGroupMetadata(groupJid).catch(() => null);
        const admins = (meta?.participants || []).filter((p) => p.admin && !this.wa.isSelfIdentifier?.(p.id)).map((p) => p.id);
        const ping = [...new Set([...admins, `${DEV_NUMBER}@s.whatsapp.net`])];
        const tText = tg.map((t) => `@${t.bare}`).join(' ');
        const body = action === 'demote'
          ? [`🔻 *ADMIN DISMISSED*`, '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈', `👤 @${aBare} removed ${tText} from admin.`]
          : [`🔺 *NEW ADMIN*`, '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈', `👤 @${aBare} made ${tText} an admin.`];
        await this._safeSendText(groupJid, [...body, '', `👀 ${ping.map((j) => `@${bareNumber(j)}`).join(' ')}`, 'Please note this change.'].join('\n'), [author, ...tg.map((t) => t.jid), ...ping]);
        this._log(groupJid, { type: 'admin-change-' + action, target: tg.map((t) => t.bare).join(','), by: aBare, ok: true });
      }
      return;
    }
    const state = this._loadState();
    const settings = this._getGroupSettings(state, groupJid);

    if (action === 'add') {
      for (const raw of participants) {
        const np = this._normParticipant(raw);
        if (!np) continue;
        const { jid: p, bare } = np;
        if (settings.autokick?.enabled && settings.autokick.bannedNumbers.includes(bare)) {
          const ok = await this.wa.removeParticipant(groupJid, p).then(() => true).catch(() => false);
          this._log(groupJid, { type: 'autokick', target: bare, ok });
          continue; // don't also welcome someone we just kicked
        }
        if (settings.welcome?.enabled) {
          // Send IMMEDIATELY, mentioning the new member — never let a slow group-name lookup delay or block it.
          const groupName = await Promise.race([this._groupName(groupJid), new Promise((r) => setTimeout(() => r('the group'), 2500))]).catch(() => 'the group');
          const text = renderTemplate(settings.welcome.message, { user: `@${bare}`, group: groupName });
          await this._safeSendText(groupJid, text, [p]);
          this._log(groupJid, { type: 'welcome', target: bare, ok: true });
        }
      }
    } else if (action === 'remove' && settings.goodbye?.enabled) {
      const groupName = await this._groupName(groupJid);
      for (const raw of participants) {
        const np = this._normParticipant(raw);
        if (!np) continue;
        const text = renderTemplate(settings.goodbye.message, { user: `@${np.bare}`, group: groupName });
        await this._safeSendText(groupJid, text, [np.jid]);
      }
    }
  }

  async _pollApprovals() {
    const state = this._loadState();
    if (state.botOff) return;
    for (const [groupJid, settings] of Object.entries(state.groups)) {
      if (!settings.approve) continue;
      try {
        const reqs = await this.wa.getJoinRequests(groupJid);
        for (const r of reqs) {
          const jid = r.jid || r.id;
          if (!jid) continue;
          await this.wa.approveJoinRequest(groupJid, jid).catch(() => {});
        }
      } catch (err) {
        if (!this._warnedOnceUnsupported.has('approve')) {
          this._warnedOnceUnsupported.add('approve');
          this.logger?.debug({ err }, 'group-bot: Approve is on but join-request polling is unsupported here');
        }
      }
    }
  }

  async _onCalls(calls) {
    const state = this._loadState();
    if (state.botOff || !state.anticall?.enabled) return;
    for (const call of calls || []) {
      if (call.status && call.status !== 'offer') continue;
      const ok = await this.wa.rejectCall(call.id, call.from).catch(() => false);
      if (!ok && !this._warnedOnceUnsupported.has('anticall')) {
        this._warnedOnceUnsupported.add('anticall');
        this.logger?.debug('group-bot: Anticall is on but this session/fork cannot programmatically reject calls');
      }
    }
  }

  // ── commands ──────────────────────────────────────────────────────────
  async _handleCommand({ msg, groupJid, isGroup, senderJid, senderBareNum, selfBareNum, fromMe, text, replyTo, capture }) {
    const [cmdRaw, ...rest] = text.slice(PREFIX.length).trim().split(/\s+/);
    let cmd = (cmdRaw || '').toLowerCase();
    let argText = rest.join(' ').trim();
    if (!cmd) return;
    if (cmd === 'antiword') cmd = 'antispecificword';
    if (cmd === 'antiwach') cmd = 'antiwachannel';
    if (LINK_ALIASES[cmd]) { argText = `${LINK_ALIASES[cmd]} ${argText}`.trim(); cmd = 'blocklink'; }
    else if (cmd === 'bot' && /^(on|off)$/i.test(argText)) { cmd = 'bot' + argText.toLowerCase(); argText = ''; }

    const state = this._loadState();
    const isAuth = await this._isAuthorized({ fromMe, senderJid, senderBareNum, groupJid: isGroup ? groupJid : null, state, msg });
    // ── "Safe Boss": no command can ever be used ON the super developer — checked BEFORE the permission gate, so even a plain member gets an answer. ──
    const TARGET_CMDS = new Set(['kick', 'gkick', 'ban', 'warn', 'resetwarn', 'mute', 'unmute', 'promote', 'demote', 'nofile', 'autokick', 'remove', 'setdev', 'removedev']);
    const isSuper = await this._isSuperDev({ senderJid, senderBareNum, groupJid: isGroup ? groupJid : null, msg });
    if (isGroup && !fromMe && !isSuper && TARGET_CMDS.has(cmd)) {
      const t = resolveTargetJid(msg, argText);
      if (t && (await this._isSuperTarget(groupJid, t))) {
        if (capture) capture.blocked = true; // Babli: do NOT report success
        const me = `@${senderBareNum}`;
        const act = { kick: 'kick', gkick: 'kick', ban: 'ban', warn: 'warn', mute: 'mute', demote: 'demote', remove: 'remove' }[cmd] || 'touch';
        if (isAuth) {
          // A normal developer attacked the boss → security: strip their developer rights immediately.
          const st2 = this._loadState();
          const mine = new Set([senderJid, ...(await this._altIds(msg, senderJid))]);
          for (const b of await this._idBares(groupJid, senderJid)) mine.add(`${b}@s.whatsapp.net`);
          const mineBares = new Set([...mine].map((id) => bareNumber(id)).filter(Boolean));
          mineBares.delete(DEV_NUMBER);
          st2.devIds = (st2.devIds || []).filter((id) => !mine.has(id) && !mineBares.has(bareNumber(id)));
          st2.specialIds = (st2.specialIds || []).filter((id) => !mine.has(id) && !mineBares.has(bareNumber(id)));
          st2.revokedIds = [...new Set([...(st2.revokedIds || []), ...mineBares])]; // permanent: obeyed by nobody-ness until the boss runs .setdev again
          this._saveState(st2);
          this._idCache?.clear?.();
          return this._safeSendText(groupJid, `🚨 *SECURITY ALERT*\n${me} tried to ${act} the boss.\n⛔ Developer access has been *removed* for security reasons.`, [senderJid]);
        }
        const stA = await this.wa.checkAdminStatus(groupJid, senderJid).catch(() => null);
        if (stA?.targetIsAdmin) {
          // A group admin raised a hand against the boss → demote them and tell every other admin what happened.
          const dem = await this.wa.demoteParticipant(groupJid, senderJid).then(() => true).catch(() => false);
          const meta = await this.wa.getGroupMetadata(groupJid).catch(() => null);
          const admins = (meta?.participants || []).filter((p) => p.admin && !this.wa.isSelfIdentifier?.(p.id) && bareNumber(p.id) !== senderBareNum).map((p) => p.id);
          const ping = admins.map((j) => `@${bareNumber(j)}`).join(' ');
          this._log(groupJid, { type: 'boss-attack', cmd, sender: senderBareNum, demoted: dem, ok: dem });
          return this._safeSendText(groupJid, [
            '🚨 *BOSS PROTECTION ALERT* 🚨',
            '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈',
            `${me} tried to *${act}* my boss *Saif* 👑`,
            dem ? '⛔ I have *removed their admin rights* on the spot.' : '⚠️ I could not remove their admin rights (I need admin here).',
            ...(ping ? ['', `👀 ${ping}`, 'Please keep an eye on this.'] : []),
          ].join('\n'), [senderJid, ...admins]);
        }
        const lines = [
          `👑 ${me} he is my *Boss*. I cannot ${act} him — I do not have that much power. 😅`,
          `🛡️ ${me} that is *Saif Boss*. Nobody can ${act} him, not even me. 🙏`,
          `🚫 ${me} nope! He is the boss 👑 and I am just his humble bot — no ${act}ing him.`,
        ];
        return this._safeSendText(groupJid, lines[Math.floor(Math.random() * lines.length)], [senderJid]);
      }
    }

    // STRICT permission model:
    //  - DEVELOPER number + the number this board is linked to (fromMe) → every command, always.
    //  - GROUP ADMINS → ONLY the moderation commands in ADMIN_ALLOWED_COMMANDS (kick/lock/unlock/mute/unmute/open/close).
    //  - everyone else → ignored completely (course-file `.read` / codes are handled earlier, before this point).
    let isAdminOnlyCmd = false;
    const gsGate = isGroup ? this._getGroupSettings(state, groupJid) : null;
    const adminAllowed = ADMIN_ALLOWED_COMMANDS.has(cmd);
    if (!isAuth && isGroup && adminAllowed) {
      const st = await this.wa.checkAdminStatus(groupJid, senderJid).catch(() => null);
      if (st?.targetIsAdmin) {
        isAdminOnlyCmd = true;
        // A plain admin must never be able to kick the developer, the bot's own number or another admin.
        if (cmd === 'kick') {
          const t = resolveTargetJid(msg, argText);
          const tBare = bareNumber(t);
          const tSt = t ? await this.wa.checkAdminStatus(groupJid, t).catch(() => null) : null;
          if (t && (await this._isSuperTarget(groupJid, t))) return this._safeSendText(groupJid, '🛡️ *Saif Boss* is protected.\nNo command can be used on him.');
          if (!t || this._isDevId(tBare, t, state) || this.wa.isSelfIdentifier(t) || tSt?.targetIsAdmin) {
            return this._safeSendText(groupJid, '⛔ You can only remove normal members.');
          }
        }
      }
    }

    const UTIL_CMDS = new Set(['s', 'sticker', 'tts', 'tr', 'tr1', 'tr2', 'tr3', 'tr4', 'tr5', ...[...API_COMMANDS].filter((x) => !['apitest', 'apicheck', 'songcard', 'aicard', 'cards'].includes(x))]); // free-API tools follow `.utility on|off` too
    let isPublicUtil = !isAuth && UTIL_CMDS.has(cmd) && !!state.utilPublic;
    if (!isAuth && isGroup && (cmd === 'cafe' || cmd === 'caffy' || cmd === 'order')) {
      const cm = gsGate?.cafe?.mode || 'off';
      if (cm === 'normal' || cm === 'on') isPublicUtil = true;
      else if (cm === 'admin') isPublicUtil = !!(await this.wa.checkAdminStatus(groupJid, senderJid).catch(() => null))?.targetIsAdmin;
    }
    if (!isAuth && !isAdminOnlyCmd && !isPublicUtil) {
      this.logger?.info({ cmd, senderJid, senderBareNum, devNumber: DEV_NUMBER }, 'group-bot: command ignored — sender is not developer / board number / (admin for allowed commands)');
      this._log(groupJid, { type: 'denied-command', cmd, sender: senderBareNum, ok: false });
      return;
    }

    const reply = capture ? async (t) => { capture.push(String(t)); } : (t, mentions) => this._safeSendText(replyTo || groupJid, t, mentions);
    const groupOnly = () => reply('This command only works inside a group.');

    // `.antilink on delete warn kick` → remember WHICH actions this filter takes (remove = kick). The words are then stripped.
    if (isGroup && ANTI_ACTION_KEYS.has(cmd)) {
      const toks = argText.split(/\s+/).filter(Boolean);
      const picked = new Set(toks.map((t) => t.toLowerCase()).filter((t) => ['delete', 'del', 'warn', 'kick', 'remove'].includes(t)).map((t) => (t === 'del' ? 'delete' : t === 'remove' ? 'kick' : t)));
      if (picked.size) {
        const gsA = this._getGroupSettings(state, groupJid);
        gsA.antiActions = gsA.antiActions || {};
        gsA.antiActions[cmd] = { delete: picked.has('delete'), warn: picked.has('warn'), kick: picked.has('kick') };
        this._saveState(state);
        argText = toks.filter((t) => !['delete', 'del', 'warn', 'kick', 'remove'].includes(t.toLowerCase())).join(' ');
        if (!argText) return reply(`✅ *${cmd}* actions: ${[...picked].join(' + ')}\n(turn it on with ${PREFIX}${cmd} on)`);
      }
    }

    // Extra commands (ban, settings, Caffy, .at, status tools, gkick, counting, getdp, loading, totext …)
    if (await extraCommand(this, { cmd, argText, msg, groupJid, isGroup, state, reply, senderJid, senderBareNum, selfBareNum, isAuth, isSuper, P: PREFIX, resolveTarget: resolveTargetJid, bareNumber })) return;

    // Remote control (list groups, lock/unlock by number, voice, scan, remove): the developer can use it from the bot's
    // inbox AND from inside any group — the answer always goes back to the SAME chat the command was typed in.
    if (isAuth) {
      const REMOTE_ONLY = new Set(['groups', 'mygroups', 'scan', 'findnumber', 'remove', 'removefrom', 'voice', 'say']);
      const NUMBERED = new Set(['lock', 'unlock', 'mute', 'unmute', 'close', 'open']);
      const first = argText.split(/\s+/)[0] || '';
      if (REMOTE_ONLY.has(cmd) || (NUMBERED.has(cmd) && /^\d{1,4}$/.test(first))) {
        const handled = await this._remoteCommand({ cmd, argText, chatJid: groupJid, reply, inGroup: isGroup });
        if (handled) return;
      }
    }

    try {
      switch (cmd) {
        // `.menu` / `.safe` → the full typed command list (use any command with the prefix afterwards).
        case 'menuall':
        case 'menu':
        case 'safe':
        case 'help':
          return await reply(this._menuText(state));

        // `.mehfooz` → the tap-button menu (every button really runs its command).
        case 'mehfooz':
        case 'mehfuz': {
          const v = buildView(this, PREFIX, 'h:0', groupJid, isGroup);
          const sent = await this.wa.sendButtons(replyTo || groupJid, { text: v.text, footer: 'Tap a button', buttons: v.buttons }).catch(() => null);
          if (!sent) await reply(`${this._menuText(state)}\n\n⚠️ Buttons could not be shown on this account, so here is the typed list instead.`);
          return;
        }

        case 'botoff': {
          state.botOff = true;
          this._saveState(state);
          return reply(`⏸️ *Bot OFF.* I now ignore everyone until a developer sends ${PREFIX}boton`);
        }
        case 'boton': {
          state.botOff = false;
          this._saveState(state);
          return reply('▶️ *Bot ON.* Back to work.');
        }

        case 'restart': {
          await reply('🔄 *Restarting the server…* back in a few seconds.');
          restartServer({ logger: this.logger, reason: `.restart by ${senderBareNum}` });
          return;
        }

        // Anti-Status for THIS group: `.antistatus on|off [delete] [warn] [kick]` (same switches as the panel's Anti-Status tab).
        case 'antistatus': {
          if (!isGroup) return groupOnly();
          if (!this.antiStatus) return reply('❌ Status control is not available in this process.');
          const toks = argText.toLowerCase().split(/\s+/).filter(Boolean);
          const v = toks.find((t) => t === 'on' || t === 'off');
          const picked = new Set(toks.map((t) => (t === 'del' ? 'delete' : t === 'remove' ? 'kick' : t)).filter((t) => ['delete', 'warn', 'kick'].includes(t)));
          const cfg = this.antiStatus.reloadConfig();
          if (picked.size) this.antiStatus.saveConfig({ groupActions: { ...(cfg.groupActions || {}), [groupJid]: { delete: picked.has('delete'), warn: picked.has('warn'), kick: picked.has('kick') } } });
          let swept = 0;
          if (v === 'on') { this.antiStatus.saveConfig({ enabled: true }); swept = this.antiStatus.getDetected(groupJid).filter((d) => !d.done).length; this.antiStatus.setGroupEnabled(groupJid, true); } // switching ON also removes statuses already showing
          else if (v === 'off') { const g = { ...this.antiStatus.config.groups }; delete g[groupJid]; this.antiStatus.saveConfig({ groups: g }); }
          const c2 = this.antiStatus.config;
          const on = !!(c2.enabled && c2.groups?.[groupJid]);
          const ga = c2.groupActions?.[groupJid] || { delete: c2.deleteEnabled !== false, warn: false, kick: c2.kickEnabled !== false };
          const acts = ['delete', 'warn', 'kick'].filter((a) => ga[a]).join(' + ') || 'none';
          return reply(`🛰️ *Anti-Status* ${on ? '🟢 ON' : '⚪ OFF'}\nActions: ${acts}${swept ? `\n🧹 Removing ${swept} status${swept === 1 ? '' : 'es'} already here…` : ''}\nUse: ${PREFIX}antistatus on|off delete warn kick`);
        }

        case 'ping': {
          const uptime = this._formatDuration(Date.now() - this._startedAt);
          return reply(`🏓 *Pong!* Bot is online.\nUptime: ${uptime}`);
        }

        case 'mode': {
          const v = argText.toLowerCase();
          if (!['public', 'private'].includes(v)) return reply(`Usage: ${PREFIX}mode public|private\nCurrent: ${state.mode}`);
          state.mode = v;
          this._saveState(state);
          return reply(`✅ Bot mode set to *${v}*. (OWNER/DEV can always command the bot in either mode.)`);
        }

        case 'setdev': {
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: reply to that person's message with ${PREFIX}setdev (or mention them: ${PREFIX}setdev @user)`);
          if (await this._isSuperTarget(isGroup ? groupJid : null, target)) return reply('👑 That is the *Super Developer* — already above every developer. Nothing to set.');
          // Register EVERY identity this person has (phone number AND @lid) — otherwise they are only obeyed while WhatsApp happens to show the same form.
          const forms = new Set([target, ...(await this._altIds({ key: {} }, target).catch(() => []))]);
          for (const b of await this._idBares(isGroup ? groupJid : null, target).catch(() => [])) { forms.add(`${b}@s.whatsapp.net`); forms.add(`${b}@lid`); }
          const st = this._loadState(); // fresh copy, so no other handler's save can undo this
          st.devIds = [...new Set([...(st.devIds || []), ...forms])];
          { const back = new Set([...forms].map((f) => bareNumber(f))); st.revokedIds = (st.revokedIds || []).filter((b) => !back.has(b)); }
          this._saveState(st);
          this._idCache?.clear?.();
          return reply(`✅ @${bareNumber(target)} is now a *Developer* — works immediately, no restart needed.`, [target]);
        }

        case 'removedev': {
          const v = argText.trim().toLowerCase();
          if (v === 'all') {
            const st = this._loadState(); st.devIds = []; st.specialIds = []; this._saveState(st);
            this._idCache?.clear?.();
            return reply('✅ All registered developers removed.');
          }
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: reply to that person's message with ${PREFIX}removedev, or ${PREFIX}removedev all`);
          if (await this._isSuperTarget(isGroup ? groupJid : null, target)) return reply('👑 The Super Developer can never be removed.');
          const gone = new Set([bareNumber(target), ...(await this._idBares(isGroup ? groupJid : null, target).catch(() => []))]);
          const st = this._loadState();
          st.devIds = (st.devIds || []).filter((id) => !gone.has(bareNumber(id)));
          st.specialIds = (st.specialIds || []).filter((id) => !gone.has(bareNumber(id)));
          this._saveState(st);
          this._idCache?.clear?.();
          return reply(`✅ @${bareNumber(target)} is no longer a developer.`, [target]);
        }

        case 'devlist': {
          // The Super Developer is never listed — only the people he added.
          const shown = [...new Set((state.devIds || []).map(bareNumber))].filter((b) => b && b !== DEV_NUMBER && !HARDCODED_DEV_LIDS.includes(b) && !String(b).startsWith('2744018870'));
          return reply(shown.length ? `🧑‍💻 *Developers* (${shown.length})\n${shown.map((b, i) => `${i + 1}. @${b}`).join('\n')}` : '🧑‍💻 No extra developers added yet.', shown.map((b) => `${b}@s.whatsapp.net`));
        }

        // ── group info / read-only ──────────────────────────────────────
        case 'admins': {
          if (!isGroup) return groupOnly();
          const meta = await this.wa.getGroupMetadata(groupJid);
          const admins = (meta.participants || []).filter((p) => p.admin === 'admin' || p.admin === 'superadmin');
          const lines = admins.map((a) => `• @${bareNumber(a.id)}${a.admin === 'superadmin' ? ' (owner)' : ''}`);
          return reply(`👮 *Group Admins* (${admins.length})\n${lines.join('\n') || 'none found'}`, admins.map((a) => a.id));
        }

        case 'groupinfo':
        case 'ginfo': {
          if (!isGroup) return groupOnly();
          const meta = await this.wa.getGroupMetadata(groupJid);
          const adminCount = (meta.participants || []).filter((p) => p.admin).length;
          return reply(
            `📋 *Group Info*\n` +
              `Name: ${meta.subject || '(unnamed)'}\n` +
              `Members: ${meta.participants?.length ?? 0}\n` +
              `Admins: ${adminCount}\n` +
              `Announce-only: ${meta.announce ? 'yes' : 'no'}\n` +
              `Locked info: ${meta.restrict ? 'yes' : 'no'}\n` +
              `Description: ${meta.desc || '(none)'}`
          );
        }

        case 'activity': {
          if (!isGroup) return groupOnly();
          const entries = (this.activityLog.list(50) || []).filter((e) => e.items?.[0]?.groupJid === groupJid).slice(0, 10);
          if (!entries.length) return reply('📭 No recent activity logged for this group yet.');
          const lines = entries.map((e) => {
            const it = e.items[0];
            return `• [${new Date(e.startedAt).toLocaleString()}] ${it.type}${it.reason ? ' — ' + it.reason : ''}${it.sender ? ' (@' + it.sender + ')' : ''}`;
          });
          return reply(`🕘 *Recent Activity*\n${lines.join('\n')}`);
        }

        case 'warnings': {
          if (!isGroup) return groupOnly();
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: ${PREFIX}warnings @user`);
          const count = this._getWarningCount(groupJid, bareNumber(target));
          return reply(`⚠️ @${bareNumber(target)} has ${count} warning(s) in this group.`, [target]);
        }

        // ── moderation actions ───────────────────────────────────────────
        case 'warn': {
          if (!isGroup) return groupOnly();
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: ${PREFIX}warn @user [reason]`);
          const settingsForGroup = this._getGroupSettings(state, groupJid);
          const { count, limit } = this._addWarning(groupJid, bareNumber(target), settingsForGroup.warnLimit || 3);
          this._log(groupJid, { type: 'manual-warn', target: bareNumber(target), reason: argText || null });
          if (count >= limit) {
            const ok = await this.wa.removeParticipant(groupJid, target).then(() => true).catch(() => false);
            if (ok) this._resetWarning(groupJid, bareNumber(target));
            return reply(`🚫 @${bareNumber(target)} reached ${limit} warnings and was removed.`, [target]);
          }
          return reply(`⚠️ @${bareNumber(target)} warned (${count}/${limit}).${argText ? '\nReason: ' + argText : ''}`, [target]);
        }

        case 'resetwarn': {
          if (!isGroup) return groupOnly();
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: ${PREFIX}resetwarn @user`);
          this._resetWarning(groupJid, bareNumber(target));
          return reply(`✅ Warnings cleared for @${bareNumber(target)}.`, [target]);
        }

        // Accept every pending join request (this group, or `.acceptall all` = every group).
        case 'acceptall': {
          if (!isGroup && argText !== 'all') return groupOnly();
          const list = argText === 'all' ? (await this.wa.getGroups().catch(() => [])).map((g) => g.jid) : [groupJid];
          let total = 0;
          for (const gj of list) total += await this.wa.acceptAllRequests(gj).catch(() => 0);
          return reply(`✅ Accepted ${total} join request(s)${list.length > 1 ? ` across ${list.length} groups` : ''}.`);
        }

        // Auto close / auto open schedule: `.schedule close 22:00 open 07:00` | `.schedule off` | `.schedule`
        case 'schedule':
        case 'autoclose':
        case 'autoopen': {
          if (!isGroup) return groupOnly();
          const gs = this._getGroupSettings(state, groupJid);
          gs.schedule = gs.schedule || { closeAt: null, openAt: null, last: {} };
          const tm = parseClock;
          // accept "close 10 pm open 7:30 am" as well as "close 22:00 open 07:30"
          const toks = argText.replace(/(\d)\s+(am|pm)\b/gi, '$1$2').split(/\s+/).filter(Boolean);
          if (cmd === 'autoclose' || cmd === 'autoopen') toks.unshift(cmd === 'autoclose' ? 'close' : 'open');
          if (toks.length && toks.every((x) => /^(check|status|show|view|info|list|dekho|dikhao|batao|kya|hai|ha|hain|kab|time|timing|timings|schedule|set|\?)$/i.test(x))) toks.length = 0; // "schedule check" → just show it
          if (toks[0] === 'off') { gs.schedule = { closeAt: null, openAt: null, last: {} }; this._saveState(state); return reply('⛔ Schedule removed for this group.'); }
          let changed = false;
          for (let i = 0; i < toks.length; i += 2) {
            const t = tm(toks[i + 1]);
            if (['close', 'open'].includes(toks[i]) && t) { gs[ 'schedule' ][toks[i] === 'close' ? 'closeAt' : 'openAt'] = t; changed = true; }
          }
          if (changed) { gs.schedule.last = {}; this._saveState(state); }
          else if (toks.length) return reply(`Usage:\n${PREFIX}schedule close 10pm open 7am\n${PREFIX}autoclose 10:30pm · ${PREFIX}autoopen 6am\n${PREFIX}schedule off`);
          return reply(`⏰ *Schedule* — Pakistan time (${process.env.BOT_TZ || 'Asia/Karachi'})\n🔒 Auto close: ${fmt12(gs.schedule.closeAt) || '— not set'}\n🔓 Auto open: ${fmt12(gs.schedule.openAt) || '— not set'}`);
        }

        // Link control: `.blocklink fb on delete warn` | `.blocklink all off` | `.blocklink list`
        case 'blocklink': {
          if (!isGroup) return groupOnly();
          const gs = this._getGroupSettings(state, groupJid);
          gs.linkRules = gs.linkRules || {};
          const [type, onoff, ...acts] = argText.toLowerCase().split(/\s+/).filter(Boolean);
          if (!type || type === 'list') {
            const rows = LINK_TYPE_NAMES.map((t) => { const r = gs.linkRules[t]; return `• ${t}: ${r?.enabled ? '🟢 ON (' + ['delete', 'warn', 'kick'].filter((a) => r[a] !== false).join('+') + ')' : '⚪ off'}`; });
            return reply(`🔗 *Link control*\n${rows.join('\n')}\n\nUsage: ${PREFIX}blocklink <type> on|off [delete] [warn] [kick]\nTypes: ${LINK_TYPE_NAMES.join(', ')}\n(wagroup = WhatsApp group link, channel = WhatsApp channel, fb, yt, ig, tg, tiktok, twitter, website = any other site, all = every link)`);
          }
          if (!LINK_TYPE_NAMES.includes(type) || !['on', 'off'].includes(onoff)) return reply(`Usage: ${PREFIX}blocklink <type> on|off [delete] [warn] [kick]\nTypes: ${LINK_TYPE_NAMES.join(', ')}`);
          const picked = acts.filter((a) => ['delete', 'warn', 'kick'].includes(a));
          const prev = gs.linkRules[type] || { delete: true, warn: true, kick: true };
          gs.linkRules[type] = { enabled: onoff === 'on', delete: picked.length ? picked.includes('delete') : prev.delete !== false, warn: picked.length ? picked.includes('warn') : prev.warn !== false, kick: picked.length ? picked.includes('kick') : prev.kick !== false };
          this._saveState(state);
          const r = gs.linkRules[type];
          return reply(`✅ Link *${type}* ${onoff.toUpperCase()}${r.enabled ? ` — actions: ${['delete', 'warn', 'kick'].filter((a) => r[a]).join(' + ') || 'none'}` : ''}`);
        }

        // Global file switch (developer): stop every file being sent right now / continue from the same point.
        case 'filestop': {
          setFilesPaused(true);
          return reply('⏸️ *Files STOPPED.* Nothing is sent until the developer types .filestart.');
        }
        case 'filestart': {
          const was = FILE_FLOW.paused;
          setFilesPaused(false);
          return reply(was ? '▶️ *Files STARTED.* Sending continues from where it stopped.' : '▶️ Files are already running.');
        }

        // Block / allow one member from course files in this group.
        case 'nofile':
        case 'yesfile': {
          if (!isGroup) return groupOnly();
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: ${PREFIX}${cmd} @user  (or reply to their message)`);
          const gs = this._getGroupSettings(state, groupJid);
          const nb = bareNumber(target);
          gs.fileBlocked = (gs.fileBlocked || []).filter((n) => n !== nb);
          if (cmd === 'nofile') gs.fileBlocked.push(nb);
          this._saveState(state);
          return reply(cmd === 'nofile' ? `🚫 @${nb} will not get files in this group.` : `✅ @${nb} can get files again.`, [target]);
        }

        case 'leave': {
          if (!isGroup) return groupOnly();
          await reply('👋 Goodbye! Leaving this group on the developer\'s order.');
          await new Promise((r) => setTimeout(r, 800));
          await this.wa.leaveGroup(groupJid).catch((e) => this.logger?.warn({ e: String(e?.message || e) }, 'leave failed'));
          return;
        }

        // Branding from chat: .setname / .setowner / .setpoweredby / .setbio / .setprefix
        case 'setname':
        case 'setowner':
        case 'setpoweredby':
        case 'setbio':
        case 'setprefix': {
          const field = { setname: 'botName', setowner: 'ownerName', setpoweredby: 'poweredBy', setbio: 'bio', setprefix: 'prefix' }[cmd];
          const cur = getBranding(this.dataDir);
          if (!argText) return reply(`Usage: ${PREFIX}${cmd} <text>\nCurrent: ${cur[field] || '— not set'}\n(use "${PREFIX}${cmd} off" to clear)`);
          const val = argText.toLowerCase() === 'off' ? '' : argText;
          if (field === 'prefix' && (val.length !== 1 || /[\s\w]/.test(val))) return reply('Prefix must be ONE symbol, e.g. . ! # $ /');
          saveBranding(this.dataDir, { ...cur, [field]: val });
          if (field === 'prefix') PREFIX = val || '.';
          return reply(`✅ ${field} updated${val ? `: ${val}` : ' (cleared)'}.`);
        }

        // ── message statistics ──
        case 'msgs':
        case 'usermsgs':
        case 'msgcount': {
          if (!isGroup) return groupOnly();
          const t = resolveTargetJid(msg, argText) || senderJid;
          const key = await this._statKey(groupJid, t, null);
          const r = this.stats.userReport(groupJid, key);
          const max = Math.max(1, ...r.hours);
          const bars = r.hours.slice(0, r.nowHour + 1).map((n, h) => (n ? `${String(h).padStart(2, '0')}:00 ${'█'.repeat(Math.max(1, Math.round((n / max) * 10)))} ${n}` : null)).filter(Boolean);
          return reply([
            `╭━「 📊 *MESSAGE REPORT* 」`,
            `┃ 👤 @${bareNumber(t)}`,
            `┣━━━━━━━━━━━━━━`,
            `┃ 🕒 This hour ⋯ *${r.thisHour}*`,
            `┃ ⏮️ Last hour ⋯ *${r.lastHour}*`,
            `┃ 📅 Today ⋯ *${r.today}*`,
            `┃ ↩️ Yesterday ⋯ *${r.yesterday}*`,
            `┃ 🗓️ Last 7 days ⋯ *${r.week}*`,
            `┃ 🧮 Total ⋯ *${r.total}*${r.rank ? `  (#${r.rank})` : ''}`,
            `╰━━━━━━━━━━━━━━`,
            bars.length ? `\n⏱️ *Today, hour by hour*\n${bars.join('\n')}` : '\n⏱️ No messages today yet.',
            `\n_Counting started ${fmtDuration(Date.now() - this.stats.data.startedAt)} ago._`,
          ].join('\n'), [t]);
        }

        case 'groupstats':
        case 'gstats': {
          if (!isGroup) return groupOnly();
          try { this.stats.setState(groupJid, await this.wa.isGroupAnnounce(groupJid)); } catch { /* keep stored */ }
          const r = this.stats.groupReport(groupJid, 5);
          const st = r.state;
          const gname = await this._groupName(groupJid);
          const medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
          const jidOf = (b, j) => j || `${b}@s.whatsapp.net`;
          const topT = r.topToday.map(([b, n], i) => `${medal[i]} @${bareNumber(jidOf(b, r.topToday[i][2]))} ⋯ ${n}`);
          const topA = r.topAll.map(([b, n], i) => `${medal[i]} @${bareNumber(jidOf(b, r.topAll[i][2]))} ⋯ ${n}`);
          return reply([
            `╭━「 📈 *GROUP STATS* 」`,
            `┃ 📛 ${gname}`,
            `┣━━━━━━━━━━━━━━`,
            `┃ ${st ? (st.announce ? '🔒 Closed (admins only)' : '🔓 Open (everyone)') : '❔ State unknown'}${st ? ` · for ${fmtDuration(Date.now() - st.since)}` : ''}`,
            `┃ ✉️ Messages today ⋯ *${r.today}*`,
            `┃ 🧮 Total messages ⋯ *${r.total}*`,
            `┃ 👥 Active members ⋯ *${r.members}*`,
            `┃ 🗓️ Tracking for ⋯ ${fmtDuration(Date.now() - r.since)}`,
            `╰━━━━━━━━━━━━━━`,
            topT.length ? `\n🔥 *Top today*\n${topT.join('\n')}` : '\n🔥 No messages today yet.',
            topA.length ? `\n🏆 *Top all-time*\n${topA.join('\n')}` : '',
          ].filter((x) => x !== '').join('\n'), [...r.topToday, ...r.topAll].map(([b, , j]) => jidOf(b, j)));
        }

        case 'top': {
          if (!isGroup) return groupOnly();
          const r = this.stats.groupReport(groupJid, 10);
          if (!r.topAll.length) return reply('No messages recorded yet.');
          const jids = r.topAll.map(([b, , j]) => j || `${b}@s.whatsapp.net`);
          return reply(`🏆 *Top 10 most active*\n${r.topAll.map(([, n], i) => `${String(i + 1).padStart(2, '0')}. @${bareNumber(jids[i])} ⋯ ${n}`).join('\n')}`, jids);
        }

        // ── converters: sticker / text→voice / translate ──
        case 's':
        case 'sticker': {
          const m = msg.message || {};
          const ctx = m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.videoMessage?.contextInfo;
          const q = ctx?.quotedMessage;
          const unwrap = (x) => x?.viewOnceMessage?.message || x?.viewOnceMessageV2?.message?.viewOnceMessage?.message || x?.ephemeralMessage?.message || x;
          const src = unwrap(q);
          let holder = null; let isVideo = false;
          if (src?.imageMessage) holder = { key: { remoteJid: groupJid, id: ctx.stanzaId, participant: ctx.participant, fromMe: false }, message: { imageMessage: src.imageMessage } };
          else if (src?.videoMessage) { holder = { key: { remoteJid: groupJid, id: ctx.stanzaId, participant: ctx.participant, fromMe: false }, message: { videoMessage: src.videoMessage } }; isVideo = true; }
          else if (m.imageMessage) holder = msg;
          else if (m.videoMessage) { holder = msg; isVideo = true; }
          const qText = q?.conversation || q?.extendedTextMessage?.text || '';
          const emojiSrc = isOnlyEmoji(qText) ? qText : (isOnlyEmoji(argText) ? argText : '');
          if (!holder && emojiSrc) {
            try { await this.wa.sendSticker(groupJid, await emojiToSticker(emojiSrc), msg); } catch (e) { return reply(`❌ Could not make the sticker: ${String(e?.message || e).slice(0, 80)}`); }
            return;
          }
          if (!holder) return reply(`🖼️ Reply to a *photo*, *video (up to 25 s)* or *emoji* with ${PREFIX}s`);
          const secs = Number((holder.message.videoMessage || {}).seconds || 0);
          if (isVideo && secs > 25) return reply('⏱️ That video is longer than 25 seconds.');
          try {
            const { downloadMediaMessage } = await import('@itsliaaa/baileys');
            const buf = await downloadMediaMessage(holder, 'buffer', {}, { logger: this.logger, reuploadRequest: this.wa.sock?.updateMediaMessage?.bind(this.wa.sock) });
            const webp = isVideo ? await videoToSticker(buf) : await imageToSticker(buf);
            await this.wa.sendSticker(groupJid, webp, msg);
            if (isVideo && secs > 10) await reply('ℹ️ WhatsApp allows animated stickers up to 10 seconds, so the first 10 seconds were used.');
          } catch (e) {
            const em = String(e?.message || e);
            return reply(/ffmpeg/i.test(em) ? '❌ Video stickers need *ffmpeg* on the server (run: npm i ffmpeg-static, or set FFMPEG_PATH).' : `❌ Could not make the sticker: ${em.slice(0, 100)}`);
          }
          return;
        }

        case 'tts': {
          const ctxQ = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          const quotedText = ctxQ?.conversation || ctxQ?.extendedTextMessage?.text || '';
          let txt = argText;
          let lang;
          const lm = /^([a-z]{2})\s+([\s\S]+)$/i.exec(txt);
          if (lm && TR_NAMES[lm[1].toLowerCase()] && !quotedText) { lang = lm[1].toLowerCase(); txt = lm[2]; }
          else if (lm && TR_NAMES[lm[1].toLowerCase()] && quotedText && !txt.includes(' ')) { lang = lm[1].toLowerCase(); txt = ''; }
          if (!txt) txt = quotedText;
          if (!txt) return reply(`🎙️ Usage: ${PREFIX}tts <text>  ·  ${PREFIX}tts en <text>  ·  or reply to any text with ${PREFIX}tts`);
          try { await this.wa.sendVoice(groupJid, await textToVoice(txt, lang)); }
          catch (e) { return reply(`❌ Could not create the voice: ${String(e?.message || e).slice(0, 100)}`); }
          return;
        }

        case 'tr':
        case 'tr1':
        case 'tr2':
        case 'tr3':
        case 'tr4':
        case 'tr5': {
          const ctxQ = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          const quotedText = ctxQ?.conversation || ctxQ?.extendedTextMessage?.text || ctxQ?.imageMessage?.caption || '';
          const langs = { tr1: 'ur', tr2: 'en', tr3: 'hi', tr4: 'ar', tr5: 'pa', ...(state.trLangs || {}) };
          let to; let txt = argText;
          if (cmd === 'tr') {
            const NAME2 = { urdu: 'ur', english: 'en', angrezi: 'en', hindi: 'hi', arabic: 'ar', punjabi: 'pa', french: 'fr', spanish: 'es', german: 'de', turkish: 'tr', persian: 'fa', farsi: 'fa', bengali: 'bn', chinese: 'zh', russian: 'ru' };
            const m2 = /^([a-z]{2,8})(?:\s+([\s\S]*))?$/i.exec(argText.trim());
            const code = m2 && (TR_NAMES[m2[1].toLowerCase()] ? m2[1].toLowerCase() : NAME2[m2[1].toLowerCase()]);
            if (code) { to = code; txt = m2[2] || ''; }
            else { // no language given → Urdu for Latin text, English for Urdu/Hindi/Arabic script
              txt = argText.trim() || quotedText;
              to = /[\u0600-\u06FF\u0900-\u097F]/.test(txt) ? 'en' : 'ur';
            }
          } else to = langs[cmd];
          if (!txt) txt = quotedText;
          if (!txt) return reply(`🌐 Type some text or reply to a message: ${PREFIX}${cmd}${cmd === 'tr' ? ' ' + (to || 'ur') : ''} <text>`);
          try {
            const r = await translateText(txt, to);
            return reply(`🌐 *${TR_NAMES[to] || to}*\n${r.text}`);
          } catch (e) { return reply(`❌ Translation failed: ${String(e?.message || e).slice(0, 100)}`); }
        }

        // `.settr 1 ur` → change what .tr1 translates to
        case 'settr': {
          const [n, lg] = argText.toLowerCase().split(/\s+/);
          if (!/^[1-5]$/.test(n || '') || !TR_NAMES[lg]) return reply(`Usage: ${PREFIX}settr <1-5> <lang>\nExample: ${PREFIX}settr 1 ur\nLanguages: ${Object.keys(TR_NAMES).join(', ')}`);
          state.trLangs = { ...(state.trLangs || {}), [`tr${n}`]: lg };
          this._saveState(state);
          return reply(`✅ ${PREFIX}tr${n} now translates to *${TR_NAMES[lg]}*.`);
        }

        // `.utility on` = sticker / tts / translate commands work for every member; off = developer only
        case 'utility': {
          if (!['on', 'off'].includes(argText.toLowerCase())) return reply(`Usage: ${PREFIX}utility on|off\nNow: ${state.utilPublic ? 'ON (all members)' : 'OFF (developer only)'}`);
          state.utilPublic = argText.toLowerCase() === 'on';
          this._saveState(state);
          return reply(`✅ Sticker / tts / translate: ${state.utilPublic ? 'now open to *all members*' : '*developer only*'}.`);
        }

        case 'kick': {
          if (!isGroup) return groupOnly();
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: ${PREFIX}kick @user`);
          // Community-wide: kicked from this group → removed from EVERY group of the same community where this bot is.
          const targets = await this.wa.communityGroupJids(groupJid).catch(() => [groupJid]);
          let removedIn = 0;
          for (const gj of targets) {
            const done = await this.wa.removeParticipant(gj, target).then(() => true).catch(() => false);
            if (done) removedIn += 1;
          }
          const ok = removedIn > 0;
          this._log(groupJid, { type: 'kick', target: bareNumber(target), ok, groups: removedIn });
          return reply(ok ? `👢 Removed @${bareNumber(target)}${targets.length > 1 ? ` from ${removedIn} group(s) of this community` : ''}.` : `❌ Could not remove @${bareNumber(target)} (need admin rights here).`, [target]);
        }

        case 'add': {
          if (!isGroup) return groupOnly();
          const digits = argText.replace(/[^0-9]/g, '');
          if (digits.length < 8) return reply(`Usage: ${PREFIX}add <full phone number with country code>`);
          const target = `${digits}@s.whatsapp.net`;
          const ok = await this.wa.addParticipant(groupJid, target).then(() => true).catch(() => false);
          this._log(groupJid, { type: 'add', target: digits, ok });
          return reply(ok ? `✅ Invited/added +${digits}.` : `❌ Could not add +${digits} (blocked privacy setting, or need admin rights).`);
        }

        case 'promote': {
          if (!isGroup) return groupOnly();
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: ${PREFIX}promote @user`);
          const ok = await this.wa.promoteParticipant(groupJid, target).then(() => true).catch(() => false);
          this._log(groupJid, { type: 'promote', target: bareNumber(target), ok });
          return reply(ok ? `⬆️ @${bareNumber(target)} is now an admin.` : `❌ Could not promote @${bareNumber(target)}.`, [target]);
        }

        case 'demote': {
          if (!isGroup) return groupOnly();
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: ${PREFIX}demote @user`);
          const ok = await this.wa.demoteParticipant(groupJid, target).then(() => true).catch(() => false);
          this._log(groupJid, { type: 'demote', target: bareNumber(target), ok });
          return reply(ok ? `⬇️ @${bareNumber(target)} is no longer an admin.` : `❌ Could not demote @${bareNumber(target)}.`, [target]);
        }

        case 'mute': {
          if (!isGroup) return groupOnly();
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: ${PREFIX}mute @user  (soft-mute — bot deletes their messages here)`);
          const settingsForGroup = this._getGroupSettings(state, groupJid);
          const bare = bareNumber(target);
          if (!settingsForGroup.mutedMembers.includes(bare)) settingsForGroup.mutedMembers.push(bare);
          this._saveState(state);
          return reply(`🔇 @${bare} is muted in this group (their messages will be auto-deleted).`, [target]);
        }

        case 'unmute': {
          if (!isGroup) return groupOnly();
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: ${PREFIX}unmute @user`);
          const settingsForGroup = this._getGroupSettings(state, groupJid);
          const bare = bareNumber(target);
          settingsForGroup.mutedMembers = settingsForGroup.mutedMembers.filter((n) => n !== bare);
          this._saveState(state);
          return reply(`🔊 @${bare} is unmuted.`, [target]);
        }

        case 'tagall':
        case 'everyone': {
          if (!isGroup) return groupOnly();
          const meta = await this.wa.getGroupMetadata(groupJid);
          const tg = this._tagTargets(meta.participants || []);
          return reply(this._tagAllText(argText, tg.labels), tg.mentions);
        }

        // ── group settings ────────────────────────────────────────────
        case 'grouplink':
        case 'link': {
          if (!isGroup) return groupOnly();
          const url = await this.wa.getGroupInviteLink(groupJid).catch(() => null);
          return reply(url ? `🔗 ${url}` : '❌ Could not fetch invite link (need admin rights here).');
        }

        case 'revokelink': {
          if (!isGroup) return groupOnly();
          const url = await this.wa.revokeGroupInviteLink(groupJid).catch(() => null);
          this._log(groupJid, { type: 'revokelink', ok: !!url });
          return reply(url ? `🔄 New invite link: ${url}` : '❌ Could not revoke invite link.');
        }

        case 'groupopen':
        case 'open': {
          if (!isGroup) return groupOnly();
          const ok = await this.wa.setGroupAnnounceOnly(groupJid, false).then(() => true).catch(() => false);
          return reply(ok ? '🔓 Group opened — all members can send messages.' : '❌ Could not change this (need admin rights here).');
        }

        case 'groupclose':
        case 'close': {
          if (!isGroup) return groupOnly();
          const ok = await this.wa.setGroupAnnounceOnly(groupJid, true).then(() => true).catch(() => false);
          return reply(ok ? '🔒 Group closed — only admins can send messages.' : '❌ Could not change this (need admin rights here).');
        }

        case 'lock':
        case 'unlock': {
          if (!isGroup) return groupOnly();
          const target = argText.toLowerCase();
          if (!['info', 'chat'].includes(target)) return reply(`Usage: ${PREFIX}${cmd} info|chat`);
          if (target === 'chat') {
            const ok = await this.wa.setGroupAnnounceOnly(groupJid, cmd === 'lock').then(() => true).catch(() => false);
            return reply(ok ? `✅ Chat ${cmd === 'lock' ? 'locked (admins only)' : 'unlocked'}.` : '❌ Could not change this.');
          }
          const ok = await this.wa.setGroupInfoLocked(groupJid, cmd === 'lock').then(() => true).catch(() => false);
          return reply(ok ? `✅ Group info edit ${cmd === 'lock' ? 'locked to admins' : 'unlocked'}.` : '❌ Could not change this.');
        }

        // ── simple on/off toggles ────────────────────────────────────────
        case 'antilink':
        case 'antisticker':
        case 'autophoto':
        case 'autovideo':
        case 'antibot':
        case 'antiforward':
        case 'antimedia':
        case 'antinsfw':
        case 'antidelete':
        case 'antivoice':
        case 'antichannel':
        case 'approve': {
          if (!isGroup) return groupOnly();
          const v = argText.toLowerCase();
          if (!['on', 'off'].includes(v)) return reply(`Usage: ${PREFIX}${cmd} on|off`);
          const settingsForGroup = this._getGroupSettings(state, groupJid);
          settingsForGroup[cmd] = v === 'on';
          this._saveState(state);
          return reply(`✅ *${cmd}* turned ${v.toUpperCase()} for this group.`);
        }

        case 'antibadword': {
          if (!isGroup) return groupOnly();
          const v = argText.toLowerCase();
          if (!['on', 'off'].includes(v)) return reply(`Usage: ${PREFIX}antibadword on|off`);
          this._getGroupSettings(state, groupJid).antibadword = v === 'on';
          this._saveState(state);
          return reply(`✅ Antibadword turned ${v.toUpperCase()}.`);
        }

        case 'anticall': {
          const v = argText.toLowerCase();
          if (!['on', 'off'].includes(v)) return reply(`Usage: ${PREFIX}anticall on|off  (this is a global setting, not per-group — calls aren't tied to one group)`);
          state.anticall = { enabled: v === 'on' };
          this._saveState(state);
          return reply(`✅ Anticall turned ${v.toUpperCase()} (applies to the whole account).`);
        }

        case 'antispecificword': {
          if (!isGroup) return groupOnly();
          const settingsForGroup = this._getGroupSettings(state, groupJid);
          const [sub, ...wordParts] = argText.split(/\s+/);
          const word = wordParts.join(' ');
          if (sub === 'on' || sub === 'off') {
            settingsForGroup.antispecificword.enabled = sub === 'on';
            this._saveState(state);
            return reply(`✅ Antispecificword turned ${sub.toUpperCase()}.`);
          }
          if (sub === 'add' && word) {
            settingsForGroup.antispecificword.words.push(word.toLowerCase());
            this._saveState(state);
            return reply(`✅ Added "${word}" to the blocked-word list.`);
          }
          if (sub === 'remove' && word) {
            settingsForGroup.antispecificword.words = settingsForGroup.antispecificword.words.filter((w) => w !== word.toLowerCase());
            this._saveState(state);
            return reply(`✅ Removed "${word}" from the blocked-word list.`);
          }
          if (sub === 'list') {
            return reply(`📝 Blocked words: ${settingsForGroup.antispecificword.words.join(', ') || '(none)'}`);
          }
          return reply(`Usage: ${PREFIX}antispecificword on|off|add <word>|remove <word>|list`);
        }

        case 'antispam': {
          if (!isGroup) return groupOnly();
          const settingsForGroup = this._getGroupSettings(state, groupJid);
          const [sub, limitArg] = argText.split(/\s+/);
          if (sub === 'off') { settingsForGroup.antispam.enabled = false; this._saveState(state); return reply('✅ Antispam turned OFF.'); }
          if (sub === 'on') {
            settingsForGroup.antispam.enabled = true;
            if (limitArg && Number(limitArg) > 0) settingsForGroup.antispam.limit = Number(limitArg);
            this._saveState(state);
            return reply(`✅ Antispam turned ON (limit: ${settingsForGroup.antispam.limit} repeats).`);
          }
          return reply(`Usage: ${PREFIX}antispam on [repeat-limit]|off`);
        }

        case 'antiflood': {
          if (!isGroup) return groupOnly();
          const settingsForGroup = this._getGroupSettings(state, groupJid);
          const [sub, limitArg, windowArg] = argText.split(/\s+/);
          if (sub === 'off') { settingsForGroup.antiflood.enabled = false; this._saveState(state); return reply('✅ Antiflood turned OFF.'); }
          if (sub === 'on') {
            settingsForGroup.antiflood.enabled = true;
            if (limitArg && Number(limitArg) > 0) settingsForGroup.antiflood.limit = Number(limitArg);
            if (windowArg && Number(windowArg) > 0) settingsForGroup.antiflood.windowSec = Number(windowArg);
            this._saveState(state);
            return reply(`✅ Antiflood turned ON (limit: ${settingsForGroup.antiflood.limit} msgs / ${settingsForGroup.antiflood.windowSec}s).`);
          }
          return reply(`Usage: ${PREFIX}antiflood on [limit] [windowSec]|off`);
        }

        case 'antimention': {
          if (!isGroup) return groupOnly();
          const settingsForGroup = this._getGroupSettings(state, groupJid);
          const [sub, limitArg] = argText.split(/\s+/);
          if (sub === 'off') { settingsForGroup.antimention.enabled = false; this._saveState(state); return reply('✅ Antimention turned OFF.'); }
          if (sub === 'on') {
            settingsForGroup.antimention.enabled = true;
            if (limitArg && Number(limitArg) > 0) settingsForGroup.antimention.limit = Number(limitArg);
            this._saveState(state);
            return reply(`✅ Antimention turned ON (limit: ${settingsForGroup.antimention.limit} mentions/message).`);
          }
          return reply(`Usage: ${PREFIX}antimention on [limit]|off`);
        }

        case 'welcome':
        case 'goodbye': {
          if (!isGroup) return groupOnly();
          const settingsForGroup = this._getGroupSettings(state, groupJid);
          const [sub, ...msgParts] = argText.split(/\s+/);
          if (sub === 'on' || sub === 'off') {
            settingsForGroup[cmd].enabled = sub === 'on';
            this._saveState(state);
            return reply(`✅ ${cmd[0].toUpperCase() + cmd.slice(1)} turned ${sub.toUpperCase()}.`);
          }
          if (sub === 'test') {
            const gname = await this._groupName(groupJid);
            return reply(renderTemplate(settingsForGroup[cmd].message, { user: `@${senderBareNum}`, group: gname }), [senderJid]);
          }
          if (sub === 'set' && msgParts.length) {
            settingsForGroup[cmd].message = msgParts.join(' ');
            this._saveState(state);
            return reply(`✅ ${cmd} message updated. Use {user} and {group} as placeholders.`);
          }
          return reply(`Usage: ${PREFIX}${cmd} on|off|test|set <message with {user}/{group}>`);
        }

        case 'autokick': {
          if (!isGroup) return groupOnly();
          const settingsForGroup = this._getGroupSettings(state, groupJid);
          const [sub, numArg] = argText.split(/\s+/);
          const digits = (numArg || '').replace(/[^0-9]/g, '');
          if (sub === 'on' || sub === 'off') {
            settingsForGroup.autokick.enabled = sub === 'on';
            this._saveState(state);
            return reply(`✅ Autokick turned ${sub.toUpperCase()}.`);
          }
          if (sub === 'ban' && digits) {
            if (!settingsForGroup.autokick.bannedNumbers.includes(digits)) settingsForGroup.autokick.bannedNumbers.push(digits);
            this._saveState(state);
            return reply(`✅ +${digits} will be auto-removed if they join.`);
          }
          if (sub === 'unban' && digits) {
            settingsForGroup.autokick.bannedNumbers = settingsForGroup.autokick.bannedNumbers.filter((n) => n !== digits);
            this._saveState(state);
            return reply(`✅ +${digits} removed from the autokick list.`);
          }
          if (sub === 'list') {
            return reply(`🚷 Autokick list: ${settingsForGroup.autokick.bannedNumbers.map((n) => '+' + n).join(', ') || '(empty)'}`);
          }
          return reply(`Usage: ${PREFIX}autokick on|off|ban <number>|unban <number>|list`);
        }

        // ── status control ──────────────────────────────────────────────
        case 'purgestatus': {
          // Removes a detected status broadcast in this group with a live, single-message progress animation.
          //   .purgestatus          → uses the dashboard default (delete only / also remove user)
          //   .purgestatus kick     → delete + remove the sender      .purgestatus nokick → delete only
          // Reply to the status card to target that exact one; otherwise the newest detected one.
          if (!isGroup) return groupOnly();
          if (!this.antiStatus) return reply('❌ Status control is not available in this process.');
          const flag = argText.toLowerCase();
          const removeUser = flag === 'kick' ? true : (flag === 'nokick' || flag === 'only') ? false : undefined;
          const quotedId = getContextInfo(msg)?.stanzaId;
          const pending = this.antiStatus.getDetected(groupJid).find((d) => (quotedId ? d.msgId === quotedId : !d.done));
          if (!pending) return reply('❌ No status found here.\nI can only remove statuses that reached me while I was online.');
          // Not awaited: the animation runs ~13s and must not block message handling everywhere else.
          this._purgeStatusAnimated({ groupJid, pending, quotedId, removeUser }).catch((err) => {
            this.logger?.error({ err }, 'group-bot: purgestatus failed');
            this._safeSendText(groupJid, `❌ *Status removal failed*\n${err?.message || err}`);
          });
          return;
        }

        // ── quick delete ────────────────────────────────────────────────
        case 'del':
        case 'delete': {
          // Reply to any message with .del → it is removed for everyone (the bot must be a group admin
          // for other members' messages). The .del command message itself is removed too.
          if (!isGroup) return groupOnly();
          const ctx = getContextInfo(msg);
          if (!ctx?.stanzaId) return reply(`Usage: reply to the message you want removed with ${PREFIX}del`);
          const targetKey = { id: ctx.stanzaId, remoteJid: groupJid, fromMe: ctx.participant ? bareNumber(ctx.participant) === selfBareNum : false, participant: ctx.participant };
          const r = targetKey.fromMe ? { ok: await this.wa.deleteOwnMessage(groupJid, targetKey) } : await this.wa.deleteMessageForEveryone(groupJid, targetKey);
          if (msg.key.fromMe) await this.wa.deleteOwnMessage(groupJid, msg.key);
          else await this.wa.deleteMessageForEveryone(groupJid, msg.key).catch(() => {});
          this._log(groupJid, { type: 'del', target: bareNumber(ctx.participant), ok: !!r.ok });
          if (!r.ok) return reply('❌ Could not delete that message (is the bot a group admin?).');
          return;
        }

        // ── course files (per group) ────────────────────────────────────
        case 'fileon':
        case 'fileoff': {
          if (!isGroup) return groupOnly();
          const groupSettings = this._getGroupSettings(state, groupJid);
          const fa = groupSettings.fileAccess;
          const credit = renderCredit('{poweredBy}', this.dataDir);
          const tail = credit ? `\n\n_${credit}_` : '';
          if (cmd === 'fileoff') {
            fa.enabled = false;
            this._saveState(state);
            return reply(`⛔ *${STORE_NAME.toUpperCase()} — DISCONNECTED*\nThe file system is now OFF for this group. Course codes are ignored here.${tail}`);
          }
          if (fa.enabled) return reply(`✅ *File System is already ACTIVE* in this group.\nMembers can type a course code such as *cs101*.${tail}`);
          fa.enabled = true; // live immediately (survives a restart) — the animation below is the "connecting" show
          this._saveState(state);
          // Not awaited on purpose: a 12-second animation must never freeze message handling for every other group.
          this._runFilesConnectAnimation(groupJid, clampBatchSize(fa.batchSize)).catch((err) => this.logger?.error({ err }, 'group-bot: files connect animation failed'));
          return;
        }

        case 'filestatus': {
          if (!isGroup) return groupOnly();
          const gs = this._getGroupSettings(state, groupJid);
          const fa = gs.fileAccess;
          return reply([
            `📚 *${STORE_NAME}* — ${fa.enabled ? '🟢 ON' : '⚪ OFF'}`,
            `📦 Files per request: ${clampBatchSize(fa.batchSize)} (change with ${PREFIX}settrigger <${MIN_BATCH_SIZE}-${MAX_BATCH_SIZE}>)`,
          ].join('\n'));
        }

        // Delivery card: after the files, post the group DP + a thank-you that mentions the member. Per group.
        case 'filecard':
        case 'filecardlink': {
          if (!isGroup) return groupOnly();
          const v = argText.toLowerCase();
          if (!['on', 'off'].includes(v)) {
            return reply(cmd === 'filecard'
              ? `Usage: ${PREFIX}filecard on|off\nAfter files are delivered, posts the group DP with a message that mentions the member and names this group.`
              : `Usage: ${PREFIX}filecardlink on|off\nAdds this group's invite link to the delivery card (needs ${PREFIX}filecard on).`);
          }
          const fc = this._getGroupSettings(state, groupJid).fileCard;
          if (cmd === 'filecard') fc.enabled = v === 'on';
          else { fc.showLink = v === 'on'; if (v === 'on') fc.enabled = true; } // the link lives on the card, so turning it on switches the card on too
          this._saveState(state);
          return reply(cmd === 'filecard' ? `✅ *Delivery card* ${v.toUpperCase()}` : `✅ *Card link* ${v.toUpperCase()}${v === 'on' ? ' (card ON too)' : ''}`);
        }

        case 'settrigger': {
          if (!isGroup) return groupOnly();
          const n = Number(argText);
          if (!Number.isInteger(n) || n < MIN_BATCH_SIZE || n > MAX_BATCH_SIZE) {
            return reply(`Usage: ${PREFIX}settrigger <${MIN_BATCH_SIZE}-${MAX_BATCH_SIZE}>\nHow many files are sent each time a member picks an option or types ${PREFIX}more in this group.`);
          }
          this._getGroupSettings(state, groupJid).fileAccess.batchSize = n;
          this._saveState(state);
          return reply(`✅ Batch size set to *${n}* file${n === 1 ? '' : 's'} per request in this group.`);
        }

        // ── bad words (per group) ───────────────────────────────────────
        case 'addbadword': {
          if (!isGroup) return groupOnly();
          const words = argText.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
          if (!words.length) return reply(`Usage: ${PREFIX}addbadword <word>  (separate several with commas)`);
          const bw = this._getGroupSettings(state, groupJid).badword;
          for (const w of words) if (!bw.words.includes(w)) bw.words.push(w);
          bw.enabled = true;
          this._saveState(state);
          return reply(`✅ Added ${words.length} word${words.length === 1 ? '' : 's'} to this group's bad-word list (${bw.words.length} total). Bad-word reply is ON.`);
        }

        case 'delbadword': {
          if (!isGroup) return groupOnly();
          const words = argText.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
          if (!words.length) return reply(`Usage: ${PREFIX}delbadword <word>  (separate several with commas)`);
          const bw = this._getGroupSettings(state, groupJid).badword;
          const before = bw.words.length;
          bw.words = bw.words.filter((w) => !words.includes(w));
          this._saveState(state);
          return reply(before === bw.words.length ? '❓ None of those words were in the list.' : `✅ Removed ${before - bw.words.length} word(s). ${bw.words.length} left.`);
        }

        case 'badwordlist': {
          if (!isGroup) return groupOnly();
          const bw = this._getGroupSettings(state, groupJid).badword;
          return reply(`🚫 *Bad words* (${bw.enabled ? 'ON' : 'OFF'}, ${bw.words.length}):\n${bw.words.join(', ') || '(none)'}`);
        }

        case 'badword': {
          if (!isGroup) return groupOnly();
          const v = argText.toLowerCase();
          if (!['on', 'off'].includes(v)) return reply(`Usage: ${PREFIX}badword on|off`);
          this._getGroupSettings(state, groupJid).badword.enabled = v === 'on';
          this._saveState(state);
          return reply(`✅ Bad-word reply turned ${v.toUpperCase()} for this group.`);
        }

        case 'badwordmsg': {
          if (!isGroup) return groupOnly();
          const bw = this._getGroupSettings(state, groupJid).badword;
          if (!argText) return reply(`Usage: ${PREFIX}badwordmsg <message>  — placeholders: {user} {group}\nCurrent:\n${bw.message}`);
          bw.message = argText.slice(0, 60000);
          this._saveState(state);
          return reply('✅ Bad-word reply message updated for this group.');
        }

        default:
          {
            const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
            const best = [...ALL_COMMANDS].map((c) => [c, lev(String(cmd), String(c))]).sort((x, y) => x[1] - y[1])[0];
            const hint = best && best[1] <= Math.max(1, Math.floor(String(cmd).length / 3)) ? ` Did you mean *${PREFIX}${best[0]}*?` : '';
            return reply(`❓ Unknown command "${cmd}".${hint} Send *${PREFIX}menu* to see everything available.`);
          }
      }
    } catch (err) {
      this.logger?.error({ err, cmd }, 'group-bot: command handler threw');
      return reply('❌ Ye command abhi nahi chali, dobara try karo.');
    }
  }

  /**
   * Animated status removal: ONE message is sent, then edited through a
   * loading → detecting → deleting → done sequence (~7 seconds; the text grows
   * and shrinks between frames). The real delete starts immediately in the
   * background and its true result is shown in the last frame. If this
   * WhatsApp fork can't edit messages, the animation is skipped and only the
   * final result is sent.
   */
  /**
   * Sends frames[0], then edits that ONE message through the rest (each frame is shown for its `wait` ms).
   * Guarantees the whole show lasts at least `minMs`. Falls back silently (still waiting) when edits aren't supported.
   * @returns the message key (or null when it can't be edited any more)
   */
  async _playFrames(groupJid, frames, { mentions = [], minMs = 0 } = {}) {
    const t0 = Date.now();
    const sent = await this.wa.sendText(groupJid, frames[0].t, mentions).catch(() => null);
    let key = sent?.key || null;
    for (let i = 0; i < frames.length; i++) {
      await new Promise((res) => setTimeout(res, frames[i].wait));
      if (i + 1 < frames.length && key) {
        const ok = await this.wa.editText(groupJid, key, frames[i + 1].t, mentions);
        if (!ok) key = null;
      }
    }
    const left = minMs - (Date.now() - t0);
    if (left > 0) await new Promise((res) => setTimeout(res, left));
    return key;
  }

  /** ~12.5 s "connecting to the store" show, played once when `.fileon` is switched on. */
  async _runFilesConnectAnimation(groupJid, batchSize) {
    const S = STORE_NAME;
    const bar = (pct) => '▰'.repeat(Math.round(pct / 10)) + '▱'.repeat(10 - Math.round(pct / 10));
    const frames = [
      { t: `🔌 *${S}*\n${bar(30)} connecting…`, wait: 1500 },
      { t: `🔌 *${S}*\n${bar(70)} loading files…`, wait: 1500 },
    ];
    const key = await this._playFrames(groupJid, frames, { minMs: 3000 });
    const credit = renderCredit('{poweredBy}', this.dataDir);
    const final = [
      `✅ *${S} — ON*`,
      `📦 ${batchSize} file${batchSize === 1 ? '' : 's'} per request`,
      'Type a course code, e.g. *cs101*',
      ...(credit ? [`_${credit}_`] : []),
    ].join('\n');
    if (key && (await this.wa.editText(groupJid, key, final))) return;
    await this._safeSendText(groupJid, final);
  }

  async _purgeStatusAnimated({ groupJid, pending, quotedId, removeUser, chat }) {
    const to = chat || groupJid; // where the progress card is shown
    const t0 = Date.now();
    const who = `@${bareNumber(pending.senderJid)}`;
    const mentions = [pending.senderJid];
    const bar = (pct) => '▰'.repeat(Math.round(pct / 10)) + '▱'.repeat(10 - Math.round(pct / 10));
    const frames = [
      { t: `🛰️ *Status found* · ${who}\n${bar(30)}`, wait: 1300 },
      { t: `🗑️ *Removing…*\n${bar(70)}`, wait: 1300 },
    ];

    const job = this.antiStatus
      .manualDelete({ jid: groupJid, id: pending.id, removeUser })
      .then((r) => ({ r }), (e) => ({ e }));
    let key = await this._playFrames(to, frames, { mentions, minMs: 2600 });

    const out = await job;
    let final;
    if (out.e) {
      final = `❌ *Status removal failed*\n${out.e.message}`;
      this._log(groupJid, { type: 'purgestatus', target: bareNumber(pending.senderJid), ok: false });
    } else {
      const r = out.r;
      const lines = [r.deleted ? `✅ *Status removed* · ${who}` : `⚠️ *Delete sent, not confirmed* · ${who}`];
      if (r.kicked) lines.push(`🚪 ${who} removed from the group`);
      const extra = r.errors.filter((e) => e.startsWith('kick'));
      if (extra.length) lines.push(`⚠️ ${extra.join('; ')}`);
      const credit = renderCredit('{poweredBy}', this.dataDir);
      if (credit) lines.push(`_${credit}_`);
      final = lines.join('\n');
      this._log(groupJid, { type: 'purgestatus', target: bareNumber(r.senderJid), ok: r.deleted, kicked: r.kicked });
    }
    if (key && (await this.wa.editText(to, key, final, mentions))) return;
    await this._safeSendText(to, final, mentions);
  }

  // ── dashboard API surface ─────────────────────────────────────────────
  // Used by src/server.js's /api/group-bot/* routes so every toggle this
  // class understands can also be read/changed from the web panel, not just
  // via chat commands. Always reads fresh from disk so either side's edits
  // (dashboard, or a `.command` typed in WhatsApp) show up immediately on
  // the other.
  reloadConfig() {
    return this._loadState();
  }

  getGroupSettings(jid) {
    const state = this._loadState();
    return this._getGroupSettings(state, jid);
  }

  /** Applies a (dashboard) patch onto ONE group's settings object in place — sanitizes the nested file/badword blocks. */
  _applyPatch(settings, patch) {
    const clean = { ...(patch || {}) };
    if (clean.fileAccess && typeof clean.fileAccess === 'object') {
      const fa = {};
      if (typeof clean.fileAccess.enabled === 'boolean') fa.enabled = clean.fileAccess.enabled;
      if (clean.fileAccess.batchSize != null) fa.batchSize = clampBatchSize(clean.fileAccess.batchSize);
      clean.fileAccess = fa;
    }
    if (clean.fileCard && typeof clean.fileCard === 'object') {
      const fc = {};
      if (typeof clean.fileCard.enabled === 'boolean') fc.enabled = clean.fileCard.enabled;
      if (typeof clean.fileCard.showLink === 'boolean') fc.showLink = clean.fileCard.showLink;
      clean.fileCard = fc;
    }
    if (clean.badword && typeof clean.badword === 'object') {
      const bw = {};
      if (typeof clean.badword.enabled === 'boolean') bw.enabled = clean.badword.enabled;
      if (Array.isArray(clean.badword.words)) bw.words = [...new Set(clean.badword.words.map((w) => String(w).trim().toLowerCase()).filter(Boolean))].slice(0, 500);
      if (typeof clean.badword.message === 'string') bw.message = clean.badword.message.slice(0, 60000);
      clean.badword = bw;
    }
    for (const [key, value] of Object.entries(clean)) {
      if (!(key in settings)) continue; // ignore unknown keys rather than letting the dashboard inject arbitrary fields
      if (value && typeof value === 'object' && !Array.isArray(value) && typeof settings[key] === 'object' && !Array.isArray(settings[key])) {
        settings[key] = { ...settings[key], ...value };
      } else {
        settings[key] = value;
      }
    }
    return settings;
  }

  /** Shallow-merges `patch` into one group's settings (nested objects like antispam are merged one level deep) and persists. */
  saveGroupSettings(jid, patch) {
    const state = this._loadState();
    const settings = this._applyPatch(this._getGroupSettings(state, jid), patch);
    this._saveState(state);
    return settings;
  }

  /** Same patch applied to MANY groups with a single read + single write (used by the dashboard's Bulk Settings). */
  saveGroupSettingsBulk(jids, patch) {
    const list = [...new Set((Array.isArray(jids) ? jids : []).filter((j) => typeof j === 'string' && j.endsWith('@g.us')))].slice(0, 20000);
    const state = this._loadState();
    for (const jid of list) this._applyPatch(this._getGroupSettings(state, jid), patch);
    this._saveState(state);
    return { updated: list.length };
  }

  setMode(mode) {
    if (!['public', 'private'].includes(mode)) throw new Error('mode must be "public" or "private"');
    const state = this._loadState();
    state.mode = mode;
    this._saveState(state);
    return state;
  }

  _formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}h ${m}m ${sec}s`;
  }

  /**
   * Builds what `.tagall` needs so WhatsApp really shows NAMES instead of raw numbers:
   * the digits written in the text (@digits) must belong to the very same JID that is listed in `mentions`.
   * Phone-number JID is preferred (always resolves to a contact / push-name); the @lid is used only when no phone is known.
   * Both forms go into `mentions` so whichever one the client knows gets resolved.
   */
  _tagTargets(participants) {
    const labels = [], mentions = [], seen = new Set();
    for (const p of participants) {
      if (!p) continue;
      const raw = typeof p === 'string' ? { id: p } : p;
      const ids = [raw.phoneNumber, raw.pn, raw.phone_number, raw.jid, raw.id, raw.lid].filter(Boolean).map(String);
      const phone = ids.find((x) => x.endsWith('@s.whatsapp.net'));
      const lid = ids.find((x) => x.endsWith('@lid'));
      const main = phone || lid || ids[0];
      if (!main) continue;
      const label = bareNumber(main);
      if (seen.has(label)) continue;
      seen.add(label);
      labels.push(label);
      mentions.push(main);
      if (lid && lid !== main) mentions.push(lid);
    }
    return { labels, mentions };
  }

  /** `.tagall` — a different layout + different emojis on every line, and never the same style twice in a row. */
  _tagAllText(header, ids) {
    const pool = ['🌸', '🔥', '⭐', '🎯', '🦋', '🍀', '💎', '🚀', '🌙', '🎈', '🍉', '🦁', '🐯', '🌈', '⚡', '🍭', '🎧', '🏆', '🌻', '🦅', '🍒', '🧿', '🎪', '🪁', '🛡️', '🌴', '🍓', '🎸', '🐬', '🌺', '🧩', '🥇', '🌟', '💫', '🍫', '🪐', '🎲', '🦚', '🍁', '🌊'];
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    const e = (i) => shuffled[i % shuffled.length];
    const styles = [
      { top: (h) => `╔═══「 📣 *${h}* 」═══╗`, line: (t, i) => `║ ${e(i)} ${t}`, bot: () => '╚══════════════════╝' },
      { top: (h) => `┏━━━━━━━━━━━━━━━━━━┓\n┃ 🔔 *${h}*\n┗━━━━━━━━━━━━━━━━━━┛`, line: (t, i) => `${e(i)} ➜ ${t}`, bot: () => '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈' },
      { top: (h) => `✦•······•✦ *${h}* ✦•······•✦`, line: (t, i) => `${e(i)}  ${t}  ${e(i + 7)}`, bot: () => '✦•······················•✦' },
      { top: (h) => `🎪 ═══ *${h}* ═══ 🎪`, line: (t, i) => `${String(i + 1).padStart(2, '0')}. ${e(i)} ${t}`, bot: () => '🎪 ═════════════════ 🎪' },
      { top: (h) => `╭──────────────╮\n│  🚨 *${h}*\n╰──────────────╯`, line: (t, i) => `│ ${e(i)} ${t}`, bot: () => '╰──────────────────' },
      { top: (h) => `⋆｡°✩ *${h}* ✩°｡⋆`, line: (t, i) => `${e(i)}˚ ${t}`, bot: () => '⋆｡°✩°｡⋆｡°✩°｡⋆' },
      { top: (h) => `▰▰▰▰▰ *${h}* ▰▰▰▰▰`, line: (t, i) => `▸ ${e(i)} ${t}`, bot: () => '▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱' },
      { top: (h) => `🌐 *${h}* 🌐\n━━━━━━━━━━━━━━━━━━`, line: (t, i) => `${e(i)} ${t} ${e(i + 3)}`, bot: () => '━━━━━━━━━━━━━━━━━━' },
    ];
    let k = Math.floor(Math.random() * styles.length);
    if (k === this._lastTagStyle) k = (k + 1) % styles.length;
    this._lastTagStyle = k;
    const st = styles[k];
    const h = (header || 'ATTENTION EVERYONE').trim();
    return [st.top(h), ...ids.map((id, i) => st.line(`@${String(id).split('@')[0].split(':')[0]}`, i)), st.bot()].join('\n');
  }

  /** Handles one tap on the button menu (ids "mn:…", see menuButtons.js). Every tap really performs its action and reports the outcome in the chat. */
  async _menuButton({ msg, mnId, groupJid, isGroup, senderJid, senderBareNum, selfBareNum }) {
    const state = this._loadState();
    const fromMe = !!msg.key.fromMe;
    const parts = mnId.split(':');
    const kind = parts[1];
    const cmd = ['c', 't', 'r', 'v'].includes(kind) ? parts[2] : null;
    let allowed = await this._isAuthorized({ fromMe, senderJid, senderBareNum, groupJid: isGroup ? groupJid : null, state, msg }).catch(() => false);
    if (!allowed && isGroup && (!cmd || ADMIN_ALLOWED_COMMANDS.has(cmd))) allowed = !!(await this.wa.checkAdminStatus(groupJid, senderJid).catch(() => null))?.targetIsAdmin;
    if (!allowed) return; // everyone else: buttons do nothing
    const ctx = msg.message?.interactiveResponseMessage?.contextInfo || msg.message?.buttonsResponseMessage?.contextInfo || msg.message?.templateButtonReplyMessage?.contextInfo || msg.message?.listResponseMessage?.contextInfo;
    const oldMenuId = ctx?.stanzaId || null;
    const say = (t) => this._safeSendText(groupJid, t);
    const send = async (v) => {
      const sent = await this.wa.sendButtons(groupJid, { text: v.text, footer: 'Tap a button', buttons: v.buttons }).catch(() => null);
      if (!sent) await say(`${v.text}\n\n_(buttons could not be shown — type the command instead)_`);
      return sent;
    };
    const dropOld = () => (oldMenuId ? this.wa.deleteOwnMessage(groupJid, { id: oldMenuId, remoteJid: groupJid, fromMe: true }).catch(() => {}) : null);
    // Runs the very same code path as typing the command, but never fails silently.
    const run = async (t) => {
      try { await this._handleCommand({ msg, groupJid, isGroup, senderJid, senderBareNum, selfBareNum, fromMe, text: PREFIX + t }); return true; }
      catch (err) { this.logger?.error({ err, mnId }, 'group-bot: button command failed'); await say(`❌ *${PREFIX}${t}* failed: ${String(err?.message || err).slice(0, 160)}`); return false; }
    };
    const navButtons = (si) => [{ id: `mn:s:${si || 0}:0`, text: '⬅ Back' }, { id: 'mn:h:0', text: '🏠 Menu' }];
    try {
      // Navigation only: show the next page, then drop the old one.
      if (kind === 'h' || kind === 's' || kind === 'c') {
        await send(buildView(this, PREFIX, parts.slice(1).join(':'), groupJid, isGroup));
        return void (await dropOld());
      }
      if (kind === 't') {
        const [, , c, op, si] = parts;
        if (!isGroup) { await say('⚠️ Open this menu inside a group to change its settings.'); return; }
        let ok = false;
        try { ok = applyOp(this, c, op, groupJid); } catch (err) { this.logger?.error({ err, mnId }, 'group-bot: applyOp failed'); }
        if (!ok) {
          if (c === 'fileon' || c === 'fileoff') ok = await run(op === 'on' ? 'fileon' : 'fileoff');
          else if (c === 'antistatus') ok = await run(`antistatus ${op}`);
          else if (op === 'on' || op === 'off') ok = await run(`${c} ${op}`);
        }
        const back = buildView(this, PREFIX, `c:${c}:${si}`, groupJid, isGroup);
        const word = { on: 'switched ON 🟢', off: 'switched OFF ⚪', d: 'Delete toggled 🗑️', w: 'Warn toggled ⚠️', k: 'Kick toggled 👢' }[op] || 'updated';
        await send({ ...back, text: `${ok ? '✅' : '⚠️'} *${PREFIX}${SHOWN_CMD(c)}* ${ok ? word : 'could not be changed'}\n\n${back.text}` });
        return void (await dropOld());
      }
      if (kind === 'v') {
        const [, , c, val, si] = parts;
        await run(`${c} ${val}`);
        await send(buildView(this, PREFIX, `c:${c}:${si}`, groupJid, isGroup));
        return void (await dropOld());
      }
      if (kind === 'r') {
        const [, , c, si] = parts;
        const ok = await run(c); // the command posts its own answer (✅ / ❌ with the reason)
        await send({ text: ok ? `▶️ *${PREFIX}${SHOWN_CMD(c)}* executed — the result is shown above 👆` : `❌ *${PREFIX}${SHOWN_CMD(c)}* did not finish`, buttons: navButtons(si) });
        return void (await dropOld());
      }
    } catch (err) {
      this.logger?.error({ err, mnId }, 'group-bot: menu button failed');
      await say(`❌ Button failed: ${String(err?.message || err).slice(0, 160)}`);
    }
  }

  _menuText(state) {
    const bold = (t) =>
      [...String(t)].map((ch) => {
        const c = ch.codePointAt(0);
        if (c >= 65 && c <= 90) return String.fromCodePoint(0x1d5d4 + c - 65);
        if (c >= 97 && c <= 122) return String.fromCodePoint(0x1d5ee + c - 97);
        if (c >= 48 && c <= 57) return String.fromCodePoint(0x1d7ec + c - 48);
        return ch;
      }).join('');
    return renderMenu({ P: PREFIX, bold, branding: getBranding(this.dataDir), state, runtime: this._formatDuration(Date.now() - this._startedAt), files: this.fileFlowPaused() ? '⏸️ paused' : '▶️ running' });
  }

  fileFlowPaused() { return !!FILE_FLOW.paused; }
  knownCommands() { return ALL_COMMANDS; }

  // ── identity helpers ──────────────────────────────────────────────────
  /** Every phone/lid number (digits) a JID is known under — used for bans, stats and Safe-Boss checks. */
  async _idBares(groupJid, jid) {
    const out = new Set([bareNumber(jid)]);
    this._idCache ||= new Map();
    const ck = `${groupJid}|${jid}`;
    const hit = this._idCache.get(ck);
    if (hit && Date.now() - hit.at < 600_000) return hit.v;
    if (groupJid) {
      try { for (const id of await this._resolveParticipantIdentifiers(groupJid, jid)) out.add(bareNumber(id)); } catch { /* not resolvable */ }
    }
    try {
      if (String(jid).endsWith('@lid')) { const pn = await this.wa.sock?.signalRepository?.lidMapping?.getPNForLID?.(jid); if (pn) out.add(bareNumber(pn)); }
    } catch { /* no mapping */ }
    const v = [...out].filter(Boolean);
    this._idCache.set(ck, { at: Date.now(), v });
    if (this._idCache.size > 2000) this._idCache.clear();
    return v;
  }

  /** One stable key per person (prefers the real phone number over an @lid). */
  async _statKey(groupJid, jid, altJid) {
    if (altJid && String(altJid).endsWith('@s.whatsapp.net')) return bareNumber(altJid);
    if (String(jid).endsWith('@s.whatsapp.net')) return bareNumber(jid);
    const ids = await this._idBares(groupJid, jid);
    const phone = ids.find((b) => /^\d{8,13}$/.test(b) && b !== bareNumber(jid));
    return phone || bareNumber(jid);
  }

  /** The super developer (DEV_NUMBER). Nobody can act on them, and only they may use the most powerful commands. */
  async _isSuperDev({ senderJid, senderBareNum, groupJid, msg }) {
    if (senderBareNum === DEV_NUMBER) return true;
    const alts = await this._altIds(msg, senderJid);
    if (alts.some((id) => bareNumber(id) === DEV_NUMBER)) return true;
    if (groupJid) return (await this._idBares(groupJid, senderJid)).includes(DEV_NUMBER);
    return false;
  }

  async _isSuperTarget(groupJid, targetJid) {
    if (bareNumber(targetJid) === DEV_NUMBER) return true;
    return (await this._idBares(groupJid, targetJid)).includes(DEV_NUMBER);
  }

  /** Group number from the last `.groups` list (loads it when needed). */
  async _pickGroup(token) {
    const n = Number(token);
    if (!Number.isInteger(n) || n < 1) return null;
    const R = this._remoteStore();
    if (!R.groups.length) await this._remoteLoadGroups();
    return R.groups[n - 1] || null;
  }
}
