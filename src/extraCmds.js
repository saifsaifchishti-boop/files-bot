/**
 * Extra developer / utility commands, kept out of groupBot.js so that file stays readable.
 * `extraCommand(bot, c)` returns true when it handled the command.
 */
import { textToVoice } from './tts.js';
import { babliIgnore, babliIgnoreList, babliAllow, babliAllowList, babliAnswerQuoted } from './babli.js';
import { apiCommand } from './apiCmds.js';
import { speechToText, fmt12 } from './tools.js';
import { runSim, isSpecial } from './sim.js';
import { cafeMenuText, cafeStages, findCafeItem, CAFE_ITEMS } from './cafe.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ago = (ts) => { const s = Math.max(1, Math.floor((Date.now() - ts) / 1000)); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
const ON = (v) => (v ? '🟢 ON' : '⚪ off');

/** Commands a group admin can NEVER be given through `.allowadmin` (developer-only, dangerous or cross-group). */
export const ADMIN_DENY = new Set(['sim', 'setspecial', 'removespecial', 'speciallist', 'setdev', 'removedev', 'devlist', 'allowadmin', 'denyadmin', 'leave', 'gkick', 'mode', 'setprefix', 'setname', 'setowner', 'setpoweredby', 'setbio', 'filestop', 'filestart', 'groups', 'mygroups', 'scan', 'remove', 'voice', 'say', 'at', 'poststatus', 'rmstatus', 'repeat', 'ginti', 'menu', 'ban', 'unban', 'ignore', 'unignore', 'ignorelist', 'cafe', 'order']);

const downloadFrom = async (bot, holder) => {
  const { downloadMediaMessage } = await import('@itsliaaa/baileys');
  return downloadMediaMessage(holder, 'buffer', {}, { logger: bot.logger, reuploadRequest: bot.wa.sock?.updateMediaMessage?.bind(bot.wa.sock) });
};

export async function extraCommand(bot, c) {
  const { cmd, argText, msg, groupJid, isGroup, state, reply, senderJid, senderBareNum, selfBareNum, isAuth, isSuper, P, resolveTarget, bareNumber } = c;
  const toks = argText.split(/\s+/).filter(Boolean);
  const gOnly = () => reply('This command only works inside a group.');
  const quotedOf = () => msg.message?.extendedTextMessage?.contextInfo || msg.message?.imageMessage?.contextInfo || msg.message?.videoMessage?.contextInfo || null;

  switch (cmd) {
    // ───────────────────────── .sim (Super Dev + Special Devs only) ─────────────────────────
    case 'sim': {
      if (!(await isSpecial(bot, { state, groupJid: isGroup ? groupJid : null, senderJid, senderBareNum, msg, isSuper }))) return true; // everyone else: silently ignored
      await runSim(bot, { argText, reply, senderBareNum, P });
      return true;
    }

    // ───────────────────────── .setspecial / .removespecial / .speciallist (Super Dev only) ─────────────────────────
    case 'setspecial':
    case 'removespecial':
    case 'speciallist': {
      if (!isSuper && !msg.key.fromMe) return true;
      const st = bot._loadState(); st.specialIds = st.specialIds || [];
      if (cmd === 'speciallist') {
        const shown = [...new Set(st.specialIds.map(bareNumber))];
        return reply(shown.length ? `⭐ *Special Devs* (${shown.length})\n${shown.map((b, i) => `${i + 1}. @${b}`).join('\n')}` : '⭐ No special devs yet.', shown.map((b) => `${b}@s.whatsapp.net`)), true;
      }
      const t = resolveTarget(msg, argText);
      if (!t) return reply(`Usage: reply to that person's message with ${P}${cmd} (or mention them)`), true;
      if (await bot._isSuperTarget(isGroup ? groupJid : null, t)) return reply('👑 He is the Super Developer — already has everything.'), true;
      const forms = new Set([t]);
      for (const b of await bot._idBares(isGroup ? groupJid : null, t).catch(() => [])) { forms.add(`${b}@s.whatsapp.net`); forms.add(`${b}@lid`); }
      if (cmd === 'setspecial') {
        st.specialIds = [...new Set([...st.specialIds, ...forms])];
        st.devIds = [...new Set([...(st.devIds || []), ...forms])]; // a special dev is a developer too
        { const back = new Set([...forms].map((f) => bareNumber(f))); st.revokedIds = (st.revokedIds || []).filter((b) => !back.has(b)); }
        bot._saveState(st); bot._idCache?.clear?.();
        return reply(`⭐ @${bareNumber(t)} is now a *Special Dev* — can use ${P}sim. Normal developers cannot.`, [t]), true;
      }
      const gone = new Set([...forms].map(bareNumber));
      st.specialIds = st.specialIds.filter((id) => !gone.has(bareNumber(id)));
      bot._saveState(st);
      return reply(`✅ @${bareNumber(t)} is no longer a Special Dev (still a normal developer).`, [t]), true;
    }

    // ───────────────────────── .replyon / .replyoff / .replylist (Babli answers ONLY developers, unless a developer allows someone) ─────────────────────────
    case 'replyon':
    case 'replyoff': {
      if (!isAuth && !isSuper && !msg.key.fromMe) return true;
      const t = resolveTarget(msg, argText);
      if (!t) return reply(`Usage: reply to their message (or mention them) with ${P}${cmd}`), true;
      await babliAllow(bot, isGroup ? groupJid : null, t, cmd === 'replyon');
      if (cmd === 'replyoff') return reply(`🤐 Babli will no longer answer @${bareNumber(t)}.`, [t]), true;
      await reply(`💬 Babli will now answer @${bareNumber(t)}. (${P}replyoff to stop)`, [t]);
      await babliAnswerQuoted(bot, { msg, groupJid, isGroup }).catch(() => {}); // also answers the message you replied to
      return true;
    }
    case 'replylist': {
      if (!isAuth && !isSuper && !msg.key.fromMe) return true;
      const l = [...new Set(babliAllowList())];
      return reply(l.length ? `💬 *Babli answers these people* (${l.length})\n${l.map((n, i) => `${i + 1}. +${n}`).join('\n')}\n\nEveryone else is ignored. Developers always get answers.` : '💬 Babli answers developers only. Use replyon (reply to someone) to allow a person.'), true;
    }

    // ───────────────────────── .ignore / .unignore / .ignorelist (Babli stops / resumes answering a person) ─────────────────────────
    case 'ignore':
    case 'unignore': {
      if (!isAuth && !isSuper && !msg.key.fromMe) return true;
      const t = resolveTarget(msg, argText);
      if (!t) return reply(`Usage: reply to their message (or mention them) with ${P}${cmd}`), true;
      if (cmd === 'ignore' && (await bot._isSuperTarget(isGroup ? groupJid : null, t).catch(() => false))) return reply('🛡️ *Saif Boss* can never be ignored.'), true;
      await babliIgnore(bot, isGroup ? groupJid : null, t, cmd === 'ignore');
      return reply(cmd === 'ignore' ? `🙈 Babli will no longer answer @${bareNumber(t)}.` : `🙂 Babli will answer @${bareNumber(t)} again.`, [t]), true;
    }
    case 'ignorelist': {
      if (!isAuth && !isSuper && !msg.key.fromMe) return true;
      const l = babliIgnoreList();
      return reply(l.length ? `🙈 *Babli ignores* (${l.length})\n${l.map((n, i) => `${i + 1}. +${n}`).join('\n')}` : '🙈 Nobody is ignored.'), true;
    }

    // ───────────────────────── .ban / .unban ─────────────────────────
    case 'ban':
    case 'unban': {
      if (!isGroup) return gOnly(), true;
      const t = resolveTarget(msg, argText);
      if (!t) return reply(`Usage: ${P}${cmd} @user  (or reply to their message)`), true;
      if (cmd === 'ban' && (await bot._isSuperTarget(groupJid, t))) return reply('🛡️ *Saif Boss* is protected and cannot be banned.'), true;
      const bares = await bot._idBares(groupJid, t);
      const gs = bot._getGroupSettings(state, groupJid);
      gs.banned = (gs.banned || []).filter((b) => !bares.includes(b));
      if (cmd === 'ban') gs.banned.push(...bares);
      bot._saveState(state);
      await reply(cmd === 'ban'
        ? `🚫 *BANNED*\n@${bareNumber(t)} can no longer send messages here.\nEvery message they send will be deleted instantly.`
        : `✅ *UNBANNED*\n@${bareNumber(t)} may send messages again.`, [t]);
      return true;
    }

    // ───────────────────────── .settings ─────────────────────────
    case 'settings':
    case 'gsettings': {
      let gj = groupJid;
      if (/^\d{1,4}$/.test(toks[0] || '')) {
        const g = await bot._pickGroup(toks[0]);
        if (!g) return reply(`❌ No group number ${toks[0]}. Send ${P}groups first.`), true;
        gj = g.jid;
      } else if (!isGroup) return reply(`Usage: ${P}settings <group number>  (see ${P}groups)`), true;
      const gs = bot._getGroupSettings(state, gj);
      const name = await bot._groupName(gj);
      const rules = Object.entries(gs.linkRules || {}).filter(([, r]) => r?.enabled).map(([k]) => k);
      const sc = gs.schedule || {};
      const L = (icon, label, val) => `${icon} ${label} ⋯ ${val}`;
      const lines = [
        '╭━━━「 ⚙️ *SETTINGS* 」━━━╮',
        `📛 ${name}`,
        '╰━━━━━━━━━━━━━━━╯',
        '',
        '┏━ 🤖 *BOT* ━━━━━━━',
        L('🟢', 'Status', `Active · ${bot._formatDuration(Date.now() - bot._startedAt)}`),
        L('🔐', 'Mode', state.mode),
        L('⌨️', 'Prefix', P),
        L('📞', 'Anticall', ON(state.anticall?.enabled)),
        '┗━━━━━━━━━━━━━━━',
        '',
        '┏━ 🛡️ *PROTECTION* ━━',
        L('🔗', 'Antilink', ON(gs.antilink)),
        L('🏷️', 'Antisticker', ON(gs.antisticker)),
        L('💬', 'Antispam', ON(gs.antispam?.enabled)),
        L('🤬', 'Antibadword', ON(gs.antibadword || gs.badword?.enabled)),
        L('📣', 'Antimention', ON(gs.antimention?.enabled)),
        L('🌊', 'Antiflood', ON(gs.antiflood?.enabled)),
        L('🤖', 'Antibot', ON(gs.antibot)),
        L('↪️', 'Antiforward', ON(gs.antiforward)),
        L('🖼️', 'Antimedia', ON(gs.antimedia)),
        L('🔞', 'Antinsfw', ON(gs.antinsfw)),
        L('🗑️', 'Antidelete', ON(gs.antidelete)),
        L('🎙️', 'Antivoice', ON(gs.antivoice)),
        L('📢', 'Antichannel', ON(gs.antichannel)),
        L('🧷', 'Link rules', rules.length ? rules.join(', ') : 'none'),
        '┗━━━━━━━━━━━━━━━',
        '',
        '┏━ 👥 *MEMBERS* ━━━━',
        L('👋', 'Welcome', ON(gs.welcome?.enabled)),
        L('🚪', 'Goodbye', ON(gs.goodbye?.enabled)),
        L('✅', 'Auto-approve', ON(gs.approve)),
        L('⛔', 'Autokick', ON(gs.autokick?.enabled)),
        L('🔇', 'Muted', `${(gs.mutedMembers || []).length}`),
        L('🚫', 'Banned', `${(gs.banned || []).length}`),
        L('⚠️', 'Warn limit', `${gs.warnLimit ?? 3}`),
        L('🛂', 'Admin guard', ON(gs.adminGuard)),
        '┗━━━━━━━━━━━━━━━',
        '',
        '┏━ 📚 *FILES & EXTRAS* ━',
        L('📁', 'Course files', ON(gs.fileAccess?.enabled)),
        L('⏯️', 'File flow', bot.fileFlowPaused() ? '⏸️ paused' : '▶️ running'),
        L('🪪', 'File card', ON(gs.fileCard?.enabled)),
        L('⏰', 'Auto close', fmt12(sc.closeAt) || 'not set'),
        L('⏰', 'Auto open', fmt12(sc.openAt) || 'not set'),
        L('☕', 'Caffy', (gs.cafe?.mode || 'off').toUpperCase()),
        L('🎨', 'Sticker/TTS/Translate', state.utilPublic ? 'everyone' : 'developer'),
        '┗━━━━━━━━━━━━━━━',
      ];
      await reply(lines.join('\n'));
      return true;
    }

    // ───────────────────────── admin permissions ─────────────────────────
    case 'adminguard': {
      if (!isGroup) return gOnly(), true;
      const v = (toks[0] || '').toLowerCase();
      const gs = bot._getGroupSettings(state, groupJid);
      gs.adminGuard = true; // Master Guard is permanent
      bot._saveState(state);
      return reply('🛂 Master Admin Guard is *ALWAYS ON* 🟢 — it cannot be switched off.'), true;
    }

    // ───────────────────────── Caffy ─────────────────────────
    case 'cafe':
    case 'caffy':
    case 'order': {
      if (!isGroup) return gOnly(), true;
      const gs = bot._getGroupSettings(state, groupJid);
      gs.cafe = gs.cafe || { mode: 'off' };
      const first = (toks[0] || '').toLowerCase();
      if (cmd !== 'order' && ['off', 'on', 'admin', 'normal'].includes(first)) {
        if (!isAuth && !isSuper) return true; // only developers may switch the café
        const m = first === 'on' ? 'normal' : first;
        gs.cafe.mode = m;
        bot._saveState(state);
        return reply(m === 'off'
          ? ['═════════════════', '☕ *CAFFY CLOSED* 🔒', '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈', '🚪 Only *developers* can use it now.', '═════════════════'].join('\n')
          : m === 'admin'
            ? ['═════════════════', '☕ *CAFFY OPEN* 🔓', '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈', '🧑‍💼 Admins & developers can order.', '═════════════════'].join('\n')
            : ['═════════════════', '☕ *CAFFY IS OPEN* 🟢', '┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈', '🎉 Everyone can order now:', '👥 members · 🧑‍💼 admins · 👑 developers', '═════════════════'].join('\n')), true;
      }
      const mode = gs.cafe.mode || 'off';
      if (mode === 'off' && !isAuth && !isSuper) return true; // OFF → developers only
      if (cmd !== 'order' && !toks.length) {
        return reply(`${cafeMenuText(P)}\n\n_Caffy mode: ${mode.toUpperCase()}_`), true;
      }
      const item = findCafeItem(cmd === 'order' ? argText : argText);
      if (!item) return reply(`❌ No such item. Send ${P}cafe to see the menu, then ${P}order 1`), true;
      bot._cafeActive ||= new Map();
      const key = `${groupJid}|${senderBareNum}`;
      if ((bot._cafeActive.get(key) || 0) >= 2) return reply('🍽️ You already have 2 orders cooking. Please wait for them first!', [senderJid]), true;
      bot._cafeActive.set(key, (bot._cafeActive.get(key) || 0) + 1);
      (async () => {
        const who = `@${senderBareNum}`;
        const stages = cafeStages(item, who);
        const sent = await bot.wa.sendText(groupJid, stages[0], [senderJid]).catch(() => null);
        let k = sent?.key || null;
        for (let i = 1; i < stages.length; i++) {
          await sleep(3500 + Math.floor(Math.random() * 1500));
          const ok = k ? await bot.wa.editText(groupJid, k, stages[i], [senderJid]) : false;
          if (!ok) { k = null; await bot.wa.sendText(groupJid, stages[i], [senderJid]).catch(() => {}); }
        }
      })().catch(() => {}).finally(() => bot._cafeActive.set(key, Math.max(0, (bot._cafeActive.get(key) || 1) - 1)));
      return true;
    }

    // ───────────────────────── .at <group no> <command> ─────────────────────────
    case 'at': {
      if (!isSuper) return reply('🔒 Only the super developer can control other groups remotely.'), true;
      const g = await bot._pickGroup(toks[0]);
      const inner = toks.slice(1).join(' ');
      if (!g || !inner) return reply(`Usage: ${P}at <group number> <command>\nExample: ${P}at 3 antilink on\nSee ${P}groups for numbers.`), true;
      const text = `${P}${inner.replace(/^[^a-z0-9]+/i, '')}`;
      const synth = { key: { id: `at-${Date.now()}`, remoteJid: g.jid, participant: senderJid, participantAlt: msg.key.remoteJidAlt || msg.key.participantAlt, fromMe: false }, message: { conversation: text } };
      await reply(`🎯 Running *${text}* in *${g.name}* …`);
      await bot._handleCommand({ msg: synth, groupJid: g.jid, isGroup: true, senderJid, senderBareNum, selfBareNum, fromMe: false, text, replyTo: groupJid });
      return true;
    }

    // ───────────────────────── group status: post / check / remove ─────────────────────────
    case 'poststatus':
    case 'gstatus': {
      let gj = groupJid; let rest = argText;
      if (/^\d{1,4}$/.test(toks[0] || '')) { const g = await bot._pickGroup(toks[0]); if (!g) return reply(`❌ No group number ${toks[0]}.`), true; gj = g.jid; rest = toks.slice(1).join(' '); }
      else if (!isGroup) return reply(`Usage: ${P}poststatus <group number> [text]  — and reply to a photo / video / text to post it.`), true;
      const q = quotedOf();
      const qm = q?.quotedMessage || {};
      const m = msg.message || {};
      let opts = null;
      const mk = (x, type) => ({ key: { remoteJid: groupJid, id: q?.stanzaId, participant: q?.participant, fromMe: false }, message: { [type]: x } });
      try {
        if (qm.imageMessage) opts = { mediaType: 'image', mediaBuffer: await downloadFrom(bot, mk(qm.imageMessage, 'imageMessage')), mimetype: qm.imageMessage.mimetype || 'image/jpeg', caption: rest || qm.imageMessage.caption || '' };
        else if (qm.videoMessage) opts = { mediaType: 'video', mediaBuffer: await downloadFrom(bot, mk(qm.videoMessage, 'videoMessage')), mimetype: qm.videoMessage.mimetype || 'video/mp4', caption: rest || qm.videoMessage.caption || '' };
        else if (m.imageMessage) opts = { mediaType: 'image', mediaBuffer: await downloadFrom(bot, msg), mimetype: m.imageMessage.mimetype || 'image/jpeg', caption: rest };
        else if (m.videoMessage) opts = { mediaType: 'video', mediaBuffer: await downloadFrom(bot, msg), mimetype: m.videoMessage.mimetype || 'video/mp4', caption: rest };
        else {
          const text = rest || qm.conversation || qm.extendedTextMessage?.text || '';
          if (!text) return reply(`Reply to a photo / video / text, or write the text: ${P}poststatus 3 Hello everyone`), true;
          opts = { mediaType: 'text', text };
        }
        const res = await bot.wa.postGroupStatus({ jid: gj, ...opts });
        const gname = await bot._groupName(gj);
        await reply(`✅ *Status posted* in ${gname}${res?.warning ? `\n⚠️ ${res.warning}` : ''}`);
      } catch (e) { await reply(`❌ Could not post the status: ${String(e?.message || e).slice(0, 140)}`); }
      return true;
    }

    case 'statuscheck':
    case 'statuses':
    case 'hasstatus': {
      let gj = groupJid;
      if (/^\d{1,4}$/.test(toks[0] || '')) { const g = await bot._pickGroup(toks[0]); if (!g) return reply(`❌ No group number ${toks[0]}.`), true; gj = g.jid; }
      else if (!isGroup) return reply(`Usage: ${P}statuscheck <group number>`), true;
      if (!bot.antiStatus) return reply('❌ Status control is not available in this process.'), true;
      const list = bot.antiStatus.getDetected(gj);
      const open = list.filter((d) => !d.done);
      const name = await bot._groupName(gj);
      if (!list.length) return reply(`🔎 *${name}*\n✅ No status broadcast has been detected in this group.`), true;
      const rows = open.slice(0, 8).map((d, i) => `${i + 1}. @${bareNumber(d.senderJid)} · ${d.type === 'mention' ? 'status mention' : 'group status'} · ${ago(d.at || d.time || Date.now())}`);
      await reply(`🔎 *${name}*\n📡 Active status broadcasts: *${open.length}*  ·  Already removed: *${list.length - open.length}*${rows.length ? `\n\n${rows.join('\n')}\n\nRemove: ${P}rmstatus${isGroup && gj === groupJid ? '' : ' ' + toks[0]}` : ''}`, open.slice(0, 8).map((d) => d.senderJid));
      return true;
    }

    case 'rmstatus': {
      let gj = groupJid;
      if (/^\d{1,4}$/.test(toks[0] || '')) { const g = await bot._pickGroup(toks[0]); if (!g) return reply(`❌ No group number ${toks[0]}.`), true; gj = g.jid; }
      else if (!isGroup) return reply(`Usage: ${P}rmstatus <group number>`), true;
      if (!bot.antiStatus) return reply('❌ Status control is not available in this process.'), true;
      let pending = bot.antiStatus.getDetected(gj).find((d) => !d.done);
      // Status was posted while the bot was offline: messages may still be arriving after the reconnect → wait a little and look again.
      if (!pending) { for (let i = 0; i < 3 && !pending; i++) { await sleep(1500); pending = bot.antiStatus.getDetected(gj).find((d) => !d.done); } }
      // Still unknown → if the command is a reply to the status card, delete exactly that message (works even if the bot never saw it before).
      if (!pending) {
        const ci = msg?.message?.extendedTextMessage?.contextInfo || null;
        const qid = ci?.stanzaId;
        if (qid && bot.wa?.deleteMessageForEveryone) {
          const self = bot.wa.getSelfJid?.() || '';
          const part = ci.participant || '';
          const own = !!self && part.split('@')[0].split(':')[0] === self.split('@')[0].split(':')[0];
          const key = { remoteJid: gj, id: qid, fromMe: own, ...(part ? { participant: part } : {}) };
          const d1 = await bot.wa.deleteMessageForEveryone(gj, key).catch((e) => ({ ok: false, error: String(e?.message || e) }));
          const d2 = await bot.wa.deleteMessageForEveryone('status@broadcast', { ...key, remoteJid: 'status@broadcast' }).catch((e) => ({ ok: false, error: String(e?.message || e) }));
          return reply(d1.ok || d2.ok ? '✅ *Status removed*' : `⚠️ Delete sent, not confirmed. ${d1.error || d2.error || ''}`.trim()), true;
        }
        return reply('✅ No status to remove.\nTip: jis status card/message ko hatana hai uspe *reply* karke .rmstatus likho — wo har haal mein delete hoga.'), true;
      }
      bot._purgeStatusAnimated({ groupJid: gj, chat: groupJid, pending }).catch((e) => reply(`❌ *Status removal failed*\n${e?.message || e}`));
      return true;
    }

    // ───────────────────────── .gkick: remove a person from every group the bot manages ─────────────────────────
    case 'gkick': {
      const t = resolveTarget(msg, argText);
      if (!t) return reply(`Usage: ${P}gkick @user  (or reply / number)`), true;
      const bares = await bot._idBares(isGroup ? groupJid : null, t);
      const found = new Map();
      for (const b of bares) for (const g of await bot.wa.findNumberInGroups(b).catch(() => [])) if (!found.has(g.jid)) found.set(g.jid, g);
      if (!found.size) return reply('🔎 That person is not in any of my groups.'), true;
      await reply(`🧹 Removing from *${found.size}* group(s)…`);
      let ok = 0; let skipped = 0; let failed = 0;
      for (const g of found.values()) {
        if (!g.selfAdmin || g.isAdmin) { skipped += 1; continue; }
        const done = await bot.wa.removeParticipant(g.jid, g.participantJid).then(() => true).catch(() => false);
        if (done) ok += 1; else failed += 1;
        await sleep(600);
      }
      await reply(`✅ *Global kick finished*\n👢 Removed: *${ok}*\n⏭️ Skipped (not admin / target is admin): *${skipped}*\n❌ Failed: *${failed}*`);
      return true;
    }

    // ───────────────────────── counting & repeating ─────────────────────────
    case 'ginti':
    case 'counting': {
      const n = Math.min(300, Math.max(1, Number(toks[0]) || 0));
      if (!toks[0] || !Number(toks[0])) return reply(`Usage: ${P}ginti 50  (counts 1…N in a single message, max 300)`), true;
      bot._counting ||= new Map();
      if (bot._counting.get(groupJid)) return reply(`A count is already running here. ${P}stopginti to stop it.`), true;
      bot._counting.set(groupJid, true);
      (async () => {
        const sent = await bot.wa.sendText(groupJid, '🔢 1').catch(() => null);
        const k = sent?.key; if (!k) return;
        for (let i = 2; i <= n && bot._counting.get(groupJid); i++) { await sleep(900); await bot.wa.editText(groupJid, k, `🔢 ${i}`); }
        await bot.wa.editText(groupJid, k, `🔢 ${bot._counting.get(groupJid) ? n : 'stopped'} ${bot._counting.get(groupJid) ? '✅' : '⏹️'}`);
      })().catch(() => {}).finally(() => bot._counting.delete(groupJid));
      return true;
    }
    case 'stopginti': { bot._counting?.set(groupJid, false); return reply('⏹️ Counting stopped.'), true; }

    case 'repeat':
    case 'multi': {
      const n = Number(toks[0]);
      const text = toks.slice(1).join(' ');
      if (!Number.isInteger(n) || n < 1 || !text) return reply(`Usage: ${P}repeat 5 your text  (sends it 5 separate times, max 50)`), true;
      for (let i = 0; i < Math.min(n, 50); i++) { await bot._safeSendText(groupJid, text); await sleep(650); }
      return true;
    }

    // ───────────────────────── profile picture ─────────────────────────
    case 'getdp':
    case 'dp': {
      const t = resolveTarget(msg, argText) || senderJid;
      const cands = [t, ...(await bot._idBares(isGroup ? groupJid : null, t)).map((b) => `${b}@s.whatsapp.net`)];
      let url = null;
      for (const j of cands) { url = await bot.wa.profilePicUrl(j); if (url) break; }
      if (!url) return reply('🖼️ No profile picture found (the user may have hidden it).'), true;
      await bot.wa.sendImageUrl(groupJid, url, `🖼️ Profile picture of @${bareNumber(t)}`, msg).catch(() => reply('❌ Could not send the picture.'));
      return true;
    }

    // ───────────────────────── loading animation ─────────────────────────
    case 'loading': {
      const task = argText || 'Processing your request';
      const steps = ['Booting the runtime environment', 'Loading core modules', 'Establishing a secure TLS channel', 'Authenticating the session token', 'Allocating memory & worker threads', 'Resolving dependencies', 'Fetching the required data', 'Decrypting the payload', 'Verifying checksums (SHA-256)', 'Running the integrity scan', 'Processing your request', 'Optimizing the output', 'Synchronizing the results', 'Flushing caches', 'Finalizing'];
      const bar = (p) => '▰'.repeat(Math.round(p / 10)) + '▱'.repeat(10 - Math.round(p / 10));
      const frames = steps.map((st, i) => { const p = Math.round(((i + 1) / (steps.length + 1)) * 100); return { t: `⏳ *${task}*\n${bar(p)} ${p}%\n• ${st}…`, wait: 1500 }; });
      const key = await bot._playFrames(groupJid, frames, {});
      const done = `✅ *${task}*\n${bar(100)} 100%\n• Completed successfully`;
      if (key && (await bot.wa.editText(groupJid, key, done))) return true;
      await bot._safeSendText(groupJid, done);
      return true;
    }

    // ───────────────────────── voice → text ─────────────────────────
    case 'totext':
    case 'stt':
    case 'transcribe': {
      const q = quotedOf();
      const a = q?.quotedMessage?.audioMessage;
      if (!a) return reply(`🎙️ Reply to a voice note with ${P}totext`), true;
      try {
        const buf = await downloadFrom(bot, { key: { remoteJid: groupJid, id: q.stanzaId, participant: q.participant, fromMe: false }, message: { audioMessage: a } });
        const text = await speechToText(buf, a.mimetype || 'audio/ogg');
        await reply(text ? `🗣️ *Transcript*\n${text}` : '🤷 I could not hear any speech in that voice note.');
      } catch (e) {
        await reply(String(e?.message) === 'NO_STT_KEY' ? '⚙️ Voice-to-text needs a free API key. Add GROQ_API_KEY=… (from console.groq.com) to the .env file and restart.' : `❌ Could not transcribe: ${String(e?.message || e).slice(0, 100)}`);
      }
      return true;
    }
    default:
      return apiCommand(bot, c); // free-API commands: song, video, ask, imagine, anime, holiday, namaz, food … (src/apiCmds.js)
  }
}
