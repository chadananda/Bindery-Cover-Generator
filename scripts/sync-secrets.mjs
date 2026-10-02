// One password, one place: copies ADMIN_PASSWORD and GEMINI_API_KEY from .dev.vars to the production Worker's secrets.
// Secrets are write-only in Cloudflare (nobody can read them back), so .dev.vars is the source of truth — dev and prod
// share the same data, so they share the same password. Usage: npm run secrets   (after editing .dev.vars)
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
if (!existsSync('.dev.vars')) { console.log('no .dev.vars — nothing to sync'); process.exit(0); }
const vars = Object.fromEntries(readFileSync('.dev.vars', 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^"(.*)"$/, '$1')]));
for (const k of ['ADMIN_PASSWORD', 'GEMINI_API_KEY']) {
  if (!vars[k]) { console.log(`${k}: not set in .dev.vars — skipped`); continue; }
  execFileSync('npx', ['wrangler', 'secret', 'put', k], { input: vars[k], stdio: ['pipe', 'ignore', 'inherit'] });
  console.log(`${k}: synced to production`);
}
