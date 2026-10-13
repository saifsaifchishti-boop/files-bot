/**
 * Free keyless AI APIs — Babli's extra "brains". If one does not answer, the next one is tried (all of them, in turn).
 * No key needed. The query-parameter name each API wants is discovered automatically and remembered.
 */
import axios from 'axios';

const PRINCE_KEY = (process.env.PRINCETECH_APIKEY || 'prince').trim();
export const APIS = [
  { name: 'JerryCoder GPT', url: 'https://jerrycoder.oggyapi.workers.dev/ai/gpt', extractor: (d) => d.reply },
  { name: 'JerryCoder GPT4', url: 'https://jerrycoder.oggyapi.workers.dev/ai/gpt4', extractor: (d) => d.reply?.message },
  { name: 'JerryCoder Gemini', url: 'https://jerrycoder.oggyapi.workers.dev/ai/gemini', extractor: (d) => d.reply },
  { name: 'PrinceTech AI', url: 'https://api.princetechn.com/api/ai/ai', extractor: (d) => d.result, extra: { apikey: PRINCE_KEY } },
  { name: 'PrinceTech Chat', url: 'https://api.princetechn.com/api/ai/chat', extractor: (d) => d.result, extra: { apikey: PRINCE_KEY } },
  { name: 'PrinceTech Mistral', url: 'https://api.princetechn.com/api/ai/mistral', extractor: (d) => d.result, extra: { apikey: PRINCE_KEY } },
  { name: 'PrinceTech DeepSeek', url: 'https://api.princetechn.com/api/ai/deepseek-v3', extractor: (d) => d.result, extra: { apikey: PRINCE_KEY } },
  { name: 'Mistral Qasim', url: 'https://mistral.gtech-apiz.workers.dev/', extractor: (d) => d.data?.response },
  { name: 'Llama Qasim', url: 'https://llama.gtech-apiz.workers.dev/', extractor: (d) => d.data?.response || d.data?.choices?.[0]?.message?.content },
  { name: 'Mistral StackToy', url: 'https://mistral.stacktoy.workers.dev/', extractor: (d) => d.data?.response },
];

const PARAMS = ['prompt', 'q', 'text', 'message', 'query', 'content'];
const goodParam = new Map([['JerryCoder GPT', 'q']]); // api name -> param that worked (JerryCoder = `q`, as used by the Chishti bot)
const restUntil = new Map(); // api name -> timestamp
let turn = 0;
const BAD = /(api\s*key|apikey|missing|required|invalid|unauthori[sz]ed|forbidden|rate\s*limit|too many|not found|error)/i;

const clean = (t) => {
  let s = typeof t === 'string' ? t : (t == null ? '' : (typeof t === 'object' ? '' : String(t)));
  s = s.replace(/\r/g, '').trim();
  return s;
};

async function callOne(api, prompt, timeout) {
  const order = goodParam.has(api.name) ? [goodParam.get(api.name)] : PARAMS;
  let last = 'failed';
  for (const p of order) {
    try {
      const res = await axios.get(api.url, { params: { ...(api.extra || {}), [p]: prompt }, timeout, validateStatus: () => true, responseType: 'json' });
      if (res.status >= 500) { last = `HTTP ${res.status}`; break; }          // API is down → next API
      if (res.status >= 200 && res.status < 300) {
        let d = res.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch { /* plain text */ } }
        const txt = clean(typeof d === 'string' ? d : api.extractor(d || {}));
        if (txt && !(txt.length < 120 && BAD.test(txt))) { goodParam.set(api.name, p); return txt; }
        last = 'empty/invalid';
        continue;                                                                // wrong parameter name → try the next one
      }
      last = `HTTP ${res.status}`;
    } catch (e) { last = e?.code || e?.message || 'network'; break; }
  }
  throw new Error(`${api.name}: ${last}`);
}

/**
 * Ask the free APIs until one answers — FAST: the next API starts at once when one fails,
 * and in parallel when one is just slow (hedge every 2.5 s). First good answer wins.
 * Returns { text, via } or { error }.
 */
export async function freeApiAsk(prompt, { logger, budgetMs = 30000, timeout = 7000, hedgeMs = 1500, validate } = {}) {
  const full = String(prompt || '').slice(0, 6500);
  const n = APIS.length;
  const s0 = turn++ % n; // take turns so one API is not hammered
  const now = Date.now();
  let list = Array.from({ length: n }, (_, i) => APIS[(s0 + i) % n]).filter((a) => (restUntil.get(a.name) || 0) <= now);
  if (!list.length) list = [...APIS]; // everything was resting → give them all a last chance
  return new Promise((resolve) => {
    let done = false, next = 0, running = 0;
    const errs = [], timers = [];
    const finish = (v) => { if (done) return; done = true; timers.forEach(clearTimeout); resolve(v); };
    const launch = () => {
      if (done) return;
      if (next >= list.length) { if (running === 0) finish({ error: errs.join(' | ') || 'no free api answered' }); return; }
      const api = list[next++]; running++;
      const hedge = setTimeout(launch, hedgeMs); timers.push(hedge);
      callOne(api, full, timeout).then((text) => { if (validate) validate(text); return text; }).then((text) => { running--; finish({ text, via: api.name }); }, (e) => {
        running--; errs.push(e.message);
        restUntil.set(api.name, Date.now() + (/json|valid/i.test(e.message) ? 15_000 : 90_000));
        logger?.warn?.({ err: e.message }, 'free-api failed');
        clearTimeout(hedge); launch();
      });
    };
    timers.push(setTimeout(() => finish({ error: errs.join(' | ') || 'timeout' }), budgetMs));
    launch();
  });
}
