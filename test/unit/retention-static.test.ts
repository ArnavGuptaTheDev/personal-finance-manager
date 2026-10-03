// The purge window is the only way to delete audit entries, so only the scheduled
// retention job may mention it: no route, middleware or other module.
import { describe, expect, it } from 'vitest';

const sources = import.meta.glob<string>('../../server/**/*.ts', { query: '?raw', import: 'default', eager: true });

describe('audit purge window', () => {
  it('is referenced by the retention job only', () => {
    const users = Object.entries(sources)
      .filter(([, code]) => code.includes('audit_purge_window'))
      .map(([path]) => path.replace(/^.*\/server\//, 'server/'));
    expect(users).toEqual(['server/lib/retention.ts']);
  });

  it('the retention job is only started by the scheduled handler', () => {
    const importers = Object.entries(sources)
      .filter(([path, code]) => !path.endsWith('retention.ts') && code.includes('lib/retention'))
      .map(([path]) => path.replace(/^.*\/server\//, 'server/'));
    expect(importers).toEqual(['server/worker.ts']);
    expect(sources[Object.keys(sources).find((p) => p.endsWith('/worker.ts'))!]).toMatch(/scheduled:.*runRetention/);
  });
});
