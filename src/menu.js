/**
 * Command menu: every command sits on ONE line — emoji, command and its short meaning, all bold, never wider than a phone screen.
 * Entry format: command:emoji:meaning
 */
const ROWS = `antilink:🔗:block links|antisticker:🎭:stickers|antispam:🚫:stop spam|antibadword:🤐:swearing|antispecificword:🎯:my words|autophoto:📷:auto photo|autovideo:🎬:auto video|antimention:📢:tag spam|antiflood:🌊:msg flood|antibot:🤖:other bots|antiforward:↪️:forwards|antimedia:🖼️:all media|antinsfw:🔞:adult media|antidelete:🗑️:undelete|anticall:📵:block calls|antivoice:🎙️:voice|antichannel:📺:channels|blocklink:🌐:by site|antistatus:🛰️:statuses|antiwa:💬:wa links|antiwachannel:📺:wa channel|antiwagroup:👥:wa group|antifb:📘:facebook|antiyt:▶️:youtube|antitiktok:🎵:tiktok|antiweb:🌍:websites|antiig:📸:instagram|antitg:✈️:telegram|antitwitter:🐦:twitter|antialllinks:🔗:all|welcome:👋:welcome|goodbye:🥀:farewell|approve:✅:auto approve|acceptall:📥:accept all|autokick:🥾:auto kick|warn:⚠️:warn member|warnings:📋:view warns|resetwarn:♻️:clear|kick:👢:remove user|gkick:💥:kick all|ban:🔨:wipe msgs|unban:🕊️:lift ban|ignore:🙈:babli ignores|unignore:🙂:babli answers|ignorelist:📃:ignored list|add:➕:add number|promote:⬆️:make admin|demote:⬇️:remove admin|mute:🔇:silence member|unmute:🔊:allow again|tagall:🏷️:mention all|del:🧹:delete msg|adminguard:🛂:shield|lock:🔒:admins only|unlock:🔓:all can chat|groupopen:🟢:open|groupclose:🔴:close|schedule:⏰:timed open|autoclose:🌙:auto close|autoopen:🌅:daily open|admins:🧑‍💼:list admins|groupinfo:ℹ️:info|grouplink:🔗:link|revokelink:♻️:new link|activity:📜:recent|settings:⚙️:what is ON|msgs:💬:member msgs|groupstats:📊:stats|top:🏅:most active|poststatus:📡:post|statuscheck:🔎:check|rmstatus:🗑️:remove|purgestatus:🧨:purge|s:🎨:make sticker|sticker:🖍️:same as .s|tts:🗣️:text to voice|totext:📝:voice to text|tr:🌍:translate|tr1:1️⃣:translate 1|tr2:2️⃣:translate 2|tr3:3️⃣:translate 3|tr4:4️⃣:translate 4|tr5:5️⃣:translate 5|settr:🔧:set .tr1-5|utility:🧰:public tools|getdp:🖼️:profile pic|ginti:🔢:live count|stopginti:⏹️:stop count|repeat:🔁:repeat text|loading:⏳:loading demo|filecard:🖼️:DP card|filecardlink:🔗:+ link|fileon:🟢:files ON|fileoff:⚫:files OFF|filestop:⏸️:pause files|filestart:▶️:resume|nofile:🚷:block user|yesfile:🆗:unblock|help:📖:file help|filestatus:📦:state|settrigger:🎚️:per batch|stats:📈:folder stats|files:📚:file count|folders:🗂️:folder list|handouts:📘:handouts|mids:📝:mid papers|finals:🎓:final papers|quizzes:❓:quizzes|cafe:☕:menu/on/off|order:🍽️:order food|addbadword:➕:add word|delbadword:➖:del word|badwordlist:📃:list|badword:🛑:on / off|badwordmsg:💌:message|groups:👥:my groups|at:🎯:run in group N|scan:🔍:find a number|remove:🚪:remove|voice:🎤:voice to group|say:💬:text to group|botoff:⏸️:bot OFF|boton:▶️:bot ON|restart:🔄:restart|mode:🔀:public/private|ping:🏓:bot alive?|menu:📜:full list|safe:🛡️:full list|mehfooz:🎛️:button menu|menuall:📋:full list|leave:👋:bot leaves|setname:✏️:bot name|setowner:👑:owner name|setpoweredby:⚡:credit|setbio:🖊️:bio line|setprefix:🔣:prefix|setdev:🧑‍💻:add developer|removedev:🚮:remove dev|devlist:🗒️:developers|sim:📇:number lookup|setspecial:⭐:add special dev|removespecial:🚫:drop special dev|speciallist:📜:special devs|song:🎵:get a song|songcard:🎴:song card on/off|aicard:🃏:AI card on/off|cards:🎴:all cards on/off|video:🎬:get a video|lyrics:📜:song lyrics|ask:🤖:ask free AI|imagine:🎨:AI picture|dpai:🖼️:AI profile pic|avatar:🧑‍🎨:make avatar|robot:🦾:robot avatar|anime:🎌:anime info|animepic:🌸:anime picture|animegif:🎞️:anime gif|findanime:🔎:scene finder|holiday:📅:holidays|nextholiday:⏭️:next holiday|hijri:🌙:islamic date|namaz:🕌:prayer times|food:🥗:calories|bmi:⚖️:BMI calc|drug:💊:medicine info|weather:🌤️:weather|joke:😂:random joke|fact:💡:random fact|meme:🤣:random meme|qr:▦:make QR|toaudio:🎧:video to audio|tovideo:📹:audio/photo to vid|toimg:🖼️:sticker to photo|apitest:🧪:test all APIs|replyon:💬:babli answers him|replyoff:🤐:babli stops|replylist:📃:babli list`;
export const ROWMAP = Object.fromEntries(ROWS.split('|').map((x) => { const [c, e, ...d] = x.split(':'); return [c, { e, d: d.join(':') }]; }));
// Filters that accept action words: `.antilink on delete warn kick` (remove = kick).
export const ANTI_ACTION_KEYS = new Set(['antilink', 'antisticker', 'autophoto', 'autovideo', 'antibot', 'antiforward', 'antimedia', 'antinsfw', 'antivoice', 'antichannel', 'antibadword', 'antispecificword', 'antispam', 'antiflood', 'antimention']);
// One command per link kind: `.antiwa on delete kick` → `.blocklink whatsapp on delete kick`.
export const LINK_ALIASES = {
  antiwa: 'whatsapp', antiwhatsapp: 'whatsapp', antiwachannel: 'channel', antiwagroup: 'wagroup', antigrouplink: 'wagroup',
  antifb: 'fb', antifacebook: 'fb', antiyt: 'yt', antiyoutube: 'yt', antiig: 'ig', antiinstagram: 'ig', antitg: 'tg', antitelegram: 'tg',
  antitiktok: 'tiktok', antitwitter: 'twitter', antiweb: 'website', antiwebsite: 'website', antialllinks: 'all',
};

export const COMMAND_DESC = Object.fromEntries(Object.entries(ROWMAP).map(([c, v]) => [c, v.d]));

export const MENU_SECTIONS = [
  ['🛡️', 'PROTECTION', ['antilink', 'antisticker', 'antispam', 'antibadword', 'antispecificword', 'autophoto', 'autovideo', 'antimention', 'antiflood', 'antibot', 'antiforward', 'antimedia', 'antinsfw', 'antidelete', 'anticall', 'antivoice', 'antichannel']],
  ['🔗', 'LINK CONTROL', ['blocklink', 'antialllinks', 'antiwa', 'antiwachannel', 'antiwagroup', 'antifb', 'antiyt', 'antitiktok', 'antiig', 'antitg', 'antitwitter', 'antiweb']],
  ['🛰️', 'ANTI STATUS', ['antistatus', 'poststatus', 'statuscheck', 'rmstatus', 'purgestatus']],
  ['👥', 'MEMBERS', ['welcome', 'goodbye', 'approve', 'acceptall', 'autokick']],
  ['⚔️', 'MODERATION', ['warn', 'warnings', 'resetwarn', 'kick', 'gkick', 'ban', 'unban', 'ignore', 'unignore', 'ignorelist', 'add', 'promote', 'demote', 'mute', 'unmute', 'tagall', 'del']],
  ['🏷️', 'GROUP CONTROL', ['lock', 'unlock', 'groupopen', 'groupclose', 'schedule', 'autoclose', 'autoopen', 'adminguard', 'admins', 'groupinfo', 'grouplink', 'revokelink', 'activity']],
  ['📊', 'SETTINGS & STATS', ['settings', 'msgs', 'groupstats', 'top']],
  ['🎨', 'CONVERT & TOOLS', ['s', 'tts', 'totext', 'tr', 'tr1', 'tr2', 'tr3', 'tr4', 'tr5', 'settr', 'utility', 'getdp', 'ginti', 'stopginti', 'repeat', 'loading']],
  ['📚', 'COURSE FILES', ['fileon', 'fileoff', 'filecard', 'filecardlink', 'filestop', 'filestart', 'nofile', 'yesfile', 'help', 'filestatus', 'settrigger', 'stats', 'files', 'folders', 'handouts', 'mids', 'finals', 'quizzes']],
  ['🎵', 'MUSIC & VIDEO', ['song', 'songcard', 'video', 'lyrics', 'toaudio', 'tovideo', 'toimg']],
  ['🤖', 'AI TOOLS', ['ask', 'aicard', 'cards', 'imagine', 'dpai', 'avatar', 'robot']],
  ['🎌', 'ANIME', ['anime', 'animepic', 'animegif', 'findanime']],
  ['📅', 'CALENDAR & PRAYER', ['holiday', 'nextholiday', 'hijri', 'namaz']],
  ['🩺', 'HEALTH', ['food', 'bmi', 'drug']],
  ['🎉', 'FUN & INFO', ['weather', 'joke', 'fact', 'meme', 'qr']],
  ['☕', 'CAFFY', ['cafe', 'order']],
  ['🤬', 'BAD WORDS', ['addbadword', 'delbadword', 'badwordlist', 'badword', 'badwordmsg']],
  ['📲', 'REMOTE CONTROL', ['groups', 'at', 'scan', 'remove', 'voice', 'say']],
  ['⚙️', 'BOT', ['botoff', 'boton', 'restart', 'mode', 'ping', 'menu', 'safe', 'mehfooz', 'menuall', 'leave', 'setname', 'setowner', 'setpoweredby', 'setbio', 'setprefix', 'setdev', 'removedev', 'devlist', 'sim', 'setspecial', 'removespecial', 'speciallist', 'replyon', 'replyoff', 'replylist', 'apitest']],
];

// Calm, grown-up look: one small geometric glyph per category instead of cartoon emojis.
const GLYPHS = ['◆', '◇', '❖', '✦', '✧', '◈', '▣', '◉', '✺', '❂', '✱', '⬖', '⬘', '◍', '◐', '◑', '◒', '◓', '◔', '◕', '◖'];
MENU_SECTIONS.forEach((sec, i) => {
  sec[0] = GLYPHS[i % GLYPHS.length];
  for (const c of sec[2]) if (ROWMAP[c]) ROWMAP[c].e = sec[0];
});

export const ALL_COMMANDS = new Set([...MENU_SECTIONS.flatMap(([, , items]) => items), 'lock', 'caffy', 'antiword', 'antiwach', 'gstats', 'usermsgs', 'dp', 'stt', 'transcribe', 'multi', 'counting', 'gsettings', 'mehfuz', 'statuses', 'hasstatus', 'gstatus', 'autoclose', 'autoopen', 'delete', 'mygroups']);

export const SHOWN = { antispecificword: 'antiword', antiwachannel: 'antiwach' }; // shorter name shown in the list (both names work)

/**
 * One line per command, always short enough for a phone screen (command + meaning ≤ ~20 characters, so nothing wraps):
 *   ┃ 🔗 *.antilink* ➜ *block links*
 */
function cmdLine(P, cmd) {
  const r = ROWMAP[cmd];
  const shown = SHOWN[cmd] || cmd;
  return r ? `┃ ${r.e} *${P}${shown}* ➜ *${r.d}*` : `┃ ▫️ *${P}${shown}*`;
}

export function renderMenu({ P, bold, branding: b, state, runtime, files }) {
  const primary = b.entries.find((e) => e.id === b.primaryId) || b.entries[0];
  const title = b.botName ? b.botName.toUpperCase() : (b.showCredit && primary ? primary.name.toUpperCase() : 'COMMAND MENU');
  const total = MENU_SECTIONS.reduce((n, [, , i]) => n + i.length, 0);
  const head = [
    `◈ ━━━━━━━━━━━━ ◈`,
    `   ${bold(title)}`,
    `◈ ━━━━━━━━━━━━ ◈`,
    ...(b.bio ? [`_${b.bio}_`] : (b.showCredit && b.tagline ? [`_${b.tagline}_`] : [])),
    '',
    `◈ ${bold('Mode')} ➜ ${state.mode}${state.botOff ? ' (bot OFF)' : ''}`,
    ...(b.ownerName ? [`◈ ${bold('Owner')} ➜ ${b.ownerName}`] : []),
    `◈ ${bold('Prefix')} ➜ ${P}`,
    `◈ ${bold('Uptime')} ➜ ${runtime}`,
    `◈ ${bold('Commands')} ➜ ${total}`,
    `◈ ${bold('Files')} ➜ ${files}`,
  ].join('\n');
  const body = MENU_SECTIONS.map(([icon, t, items]) => [`┏━「 ${icon} ${bold(t)} 」`, ...items.map((c) => cmdLine(P, c)), '┗━━━━━━━━━━━━━━━'].join('\n')).join('\n\n');
  const notes = [
    `┏━「 ✦ ${bold('HOW TO USE')} 」`,
    `┃ *${P}menu* / *${P}safe* ➜ this list`,
    `┃ *${P}mehfooz* ➜ tap-button menu`,
    `┃ *${P}antilink on*`,
    `┃ *${P}antilink on delete kick*`,
    `┃ *${P}antiyt on warn kick*`,
    `┃ *${P}antistatus on delete*`,
    '┃ ◦ delete = remove msg',
    '┃ ◦ warn = warn, then limit',
    '┃ ◦ kick = remove member',
    '┃ kick alone = instant',
    '┗━━━━━━━━━━━━━━━',
    '',
    `┏━「 ✧ ${bold('ACCESS')} 」`,
    '┃ ◆ Developer: everything',
    '┃ ◇ Admins: kick, mute,',
    '┃    lock, open, close,',
    '┃    antilink, antisticker',
    `┃ ◦ Members: ${P}help, files`,
    '┃ ◦ Files & Caffy: ON = all,',
    '┃    OFF = developers only',
    '┗━━━━━━━━━━━━━━━',
  ].join('\n');
  const foot = [];
  if (b.showCredit && b.entries.length) {
    foot.push(`┏━「 ✦ ${bold('CREDITS')} 」`);
    for (const e of b.entries) foot.push(`┃ ${e.id === primary?.id ? '★' : '◦'} ${e.name}${e.role ? ` — ${e.role}` : ''}`);
    foot.push('┗━━━━━━━━━━━━━━━');
    const pb = b.poweredBy ? b.poweredBy.replace(/^powered by\s*/i, '') : primary?.name;
    if (pb) foot.push('', `✦ ${bold('Powered by')} ${pb} ✦`);
  }
  return [head, '', body, '', notes, ...(foot.length ? ['', foot.join('\n')] : [])].join('\n');
}
