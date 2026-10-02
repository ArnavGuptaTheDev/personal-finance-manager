// Every /api/* request is handled by the Hono app in /server.
import { handle } from 'hono/cloudflare-pages';
import app from '../../server/app';

export const onRequest = handle(app);
