// Site-wide details used on public pages (privacy policy, footer).
export const SITE = {
  name: 'Personal Finance Manager',
  url: 'https://pfm.arnavg.me',
  /** Where people can send privacy requests. Shown publicly on /privacy/. */
  contactEmail: 'clusterwithgigs@gmail.com',
  /** Date the current privacy policy took effect. Update it whenever the policy changes. */
  privacyUpdated: '3 October 2026',
};

if (SITE.contactEmail.startsWith('REPLACE_')) {
  throw new Error('Set SITE.contactEmail in src/site.ts before building: the privacy policy needs a real contact address.');
}
