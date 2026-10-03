// Worker entry point. Static files are served from ./dist by Cloudflare's asset
// handling; only /api/* reaches this code (see run_worker_first in wrangler.toml).
import app from './app';
import type { Env } from './env';
import { runRetention } from './lib/retention';

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  // Daily (see [triggers] in wrangler.toml): audit log retention and the 30-day purge of deleted records.
  scheduled: (_event, env, ctx) => ctx.waitUntil(runRetention(env)),
} satisfies ExportedHandler<Env>;
