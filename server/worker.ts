// Worker entry point. Static files are served from ./dist by Cloudflare's asset
// handling; only /api/* reaches this code (see run_worker_first in wrangler.toml).
import app from './app';
import type { Env } from './env';

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;
