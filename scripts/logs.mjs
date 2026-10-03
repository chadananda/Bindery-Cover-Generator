// Read the prompt/audit log (D1 logs table) from production: every chat turn (message, selection, raw model tool calls,
// plan before/after scoping), edit refinement, image generation (exact prompt + why), describe, and plan clicks.
// Usage: node scripts/logs.mjs [limit=20] [kind: chat|refine|generate|describe|ui:plan|ui:edit-mode] [--full]
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2), full = args.includes('--full'), [limit = 20, kind] = args.filter((a) => a !== '--full');
const where = kind ? `WHERE kind = '${kind.replace(/'/g, "''")}'` : '';
const sql = `SELECT lib, at, kind, bookId, input, output FROM logs ${where} ORDER BY at DESC LIMIT ${+limit || 20}`;
const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'bindery', '--remote', '--json', '--command', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const rows = JSON.parse(out)[0].results.reverse();
const show = (x) => { if (x == null) return ''; try { x = JSON.parse(x); } catch {} const s = typeof x === 'string' ? x : JSON.stringify(x, null, 1); return full ? s : s.slice(0, 1500); };
for (const r of rows) console.log(`\n=== ${new Date(r.at).toISOString()} ${r.lib} ${r.kind}${r.bookId ? ` book ${r.bookId}` : ''}\n> ${show(r.input)}\n< ${show(r.output)}`);
