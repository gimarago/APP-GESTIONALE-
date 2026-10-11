import { readdir, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';

// Container-only maintenance: fixed directory, strict names, never recurse.
const days = Number(process.argv[2] ?? 30);
if (!Number.isInteger(days) || days < 1 || days > 3650) {
  throw new Error('Retention must be 1..3650 days');
}
const directory = '/backups';
const entries = [];
for (const name of await readdir(directory)) {
  if (!/^officina-\d{8}T\d{6}Z-\d+\.sqlite$/.test(name)) continue;
  const filename = path.join(directory, name);
  const stat = await lstat(filename);
  if (stat.isFile() && !stat.isSymbolicLink()) entries.push({ filename, modified: stat.mtimeMs });
}
entries.sort((a, b) => b.modified - a.modified);
const cutoff = Date.now() - days * 86400000;
for (const item of entries.slice(2)) {
  if (item.modified < cutoff) await unlink(item.filename);
}
