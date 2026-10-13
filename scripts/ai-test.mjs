#!/usr/bin/env node
/**
 * Live check of every AI brain that is configured in .env.
 *   npm run aitest
 * Prints which providers answer, how fast, and the exact error when one does not.
 */
import 'dotenv/config';
import { probeBrains } from '../src/aiBrains.js';

console.log('Testing AI brains (needs internet)…\n');
const rows = await probeBrains(console);
rows.sort((a, b) => Number(b.ok) - Number(a.ok) || a.ms - b.ms);
for (const r of rows) console.log(`${r.ok ? '✅' : '❌'} ${r.name.padEnd(18)} ${String(r.ms).padStart(5)} ms  ${r.note}`);
const good = rows.filter((r) => r.ok).length;
console.log(`\n${good}/${rows.length} brains working.`);
if (!good) console.log('Nothing answered: check internet / keys in .env (GEMINI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY …).');
process.exit(0);
