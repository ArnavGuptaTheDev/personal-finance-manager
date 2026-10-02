// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  // Hash every inline script/style Astro emits into a strict CSP <meta> tag.
  // Additional headers (frame-ancestors, HSTS, ...) live in public/_headers.
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "img-src 'self' data: https://*.googleusercontent.com",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ],
    },
  },
  build: { inlineStylesheets: 'never' },
  server: { port: 4321 },
  vite: {
    server: {
      // `npm run dev:ui` → live-reloading UI on :4321, API proxied to wrangler on :8788.
      proxy: { '/api': 'http://localhost:8788' },
    },
  },
});
