// Build step: mirror core/ into public/core/ so the browser imports the exact modules the Worker and
// tests use. public/core/ is generated — never edit it; edit core/.
import { cpSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(resolve(root, 'public/core'), { recursive: true, force: true });
cpSync(resolve(root, 'core'), resolve(root, 'public/core'), { recursive: true, filter: (src) => !src.endsWith('.md') });
console.log('core/ → public/core/');
