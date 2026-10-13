/**
 * Entry point for panel-style hosts (Katabump / Pterodactyl / Heroku …) that expect a root-level `index.js`.
 * Before the real server starts, saved settings + WhatsApp session are restored from Redis (only when
 * UPSTASH_REDIS_REST_URL / _TOKEN are set — see src/persist.js). Without them nothing changes.
 */
import 'dotenv/config';
import { restoreAll, startSync } from './src/persist.js';

await restoreAll();
await import('./src/server.js');
startSync();
