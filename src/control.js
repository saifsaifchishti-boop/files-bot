/**
 * Process control: crash guards + a clean server restart.
 *
 * - installCrashGuards(): a stray rejected promise / thrown error (e.g. while a big file is being sent) is LOGGED, it no longer
 *   takes the whole server down. Node's default for those is to exit, which hosting panels show as "server restarted".
 * - restartServer(): used by `.restart` (WhatsApp) and the panel's Restart button.
 *     RESTART_MODE=exit   (default) → exits with RESTART_EXIT_CODE (default 1) so the host / pm2 / docker starts it again
 *     RESTART_MODE=spawn            → starts a fresh copy of itself, then exits (for hosts without auto-restart)
 */
import { spawn } from 'node:child_process';

let restarting = false;
export const isRestarting = () => restarting;

export function installCrashGuards(logger) {
  process.on('unhandledRejection', (reason) => {
    logger?.error({ err: reason instanceof Error ? reason : String(reason) }, 'unhandledRejection — ignored, server keeps running');
  });
  process.on('uncaughtException', (err) => {
    logger?.error({ err }, 'uncaughtException — ignored, server keeps running');
  });
  const ceiling = Number(process.env.MEM_SOFT_LIMIT_MB) > 0 ? Number(process.env.MEM_SOFT_LIMIT_MB) * 1048576 : 0;
  if (ceiling) {
    setInterval(() => {
      const rss = process.memoryUsage().rss;
      if (rss > ceiling) { logger?.warn({ rssMB: Math.round(rss / 1048576) }, 'memory high — running GC'); if (typeof globalThis.gc === 'function') globalThis.gc(); }
    }, 15_000).unref();
  }
}

export function restartServer({ logger, reason = 'manual', delayMs = 1500 } = {}) {
  if (restarting) return false;
  restarting = true;
  logger?.warn({ reason }, 'server restart requested');
  setTimeout(async () => {
    try { await Promise.race([globalThis.__persistFlush?.(), new Promise((r) => setTimeout(r, 6000))]); } catch { /* saving is best-effort */ } // keep the last settings before restarting
    const mode = (process.env.RESTART_MODE || 'exit').toLowerCase();
    if (mode === 'spawn') {
      try {
        const child = spawn(process.argv[0], process.argv.slice(1), { cwd: process.cwd(), env: process.env, detached: true, stdio: 'inherit' });
        child.unref();
      } catch (err) { logger?.error({ err }, 'restart: could not spawn a new process'); }
      process.exit(0);
    }
    process.exit(Number(process.env.RESTART_EXIT_CODE ?? 1));
  }, delayMs);
  return true;
}
