import { readFile, writeFile, copyFile, mkdir, stat, rename } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

// Publish only public release files. Signing keys never enter this directory.
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw Error('Manca il valore di ' + name);
  return args[index + 1];
}
async function main() {
  const config = JSON.parse(await readFile(join(project, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const version = config.version;
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw Error('Versione Tauri non valida.');
  const installer = resolve(option('--installer') || join(project, 'src-tauri', 'target', 'release', 'bundle', 'nsis', `${config.productName}_${version}_x64-setup.exe`));
  const signaturePath = resolve(option('--signature') || installer + '.sig');
  const releaseDirectory = option('--release-dir');
  if (!releaseDirectory) throw Error('Indicare --release-dir, la cartella pubblica degli aggiornamenti sul VPS.');
  const destination = resolve(releaseDirectory);
  const metadata = await stat(installer);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > 150 * 1024 * 1024) throw Error('Installer mancante o dimensione non valida.');
  const bytes = await readFile(installer);
  if (bytes.subarray(0, 2).toString('ascii') !== 'MZ') throw Error('Il file non è un installer Windows.');
  const signature = (await readFile(signaturePath, 'utf8')).trim();
  if (signature.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw Error('Firma Tauri non valida.');
  const decoded = Buffer.from(signature, 'base64');
  if (decoded.toString('base64') !== signature) throw Error('Firma Tauri non valida.');
  const lines = decoded.toString('utf8').trimEnd().split(/\r?\n/);
  if (lines.length !== 4 || !lines[0].startsWith('untrusted comment: ') || !lines[2].startsWith('trusted comment: ') ||
      Buffer.from(lines[1], 'base64').length !== 74 || Buffer.from(lines[3], 'base64').length !== 64) throw Error('Firma Tauri incompleta.');
  const signedVersion = /(?:^|\s)version:([^\s]+)/.exec(lines[2])?.[1];
  if (signedVersion !== version) throw Error(`La firma deve includere version:${version}. Ricompilare con la CLI Tauri inclusa nel progetto.`);
  const notesFile = option('--notes-file');
  const notes = notesFile ? await readFile(resolve(notesFile), 'utf8') : 'Aggiornamento dell’app Officina M.A. Gomme.';
  if (notes.length > 32000) throw Error('Note di aggiornamento troppo lunghe.');
  const name = `Officina-Windows-${version}-setup.exe`;
  const target = join(destination, name);
  const digest = value => createHash('sha256').update(value).digest('hex');
  await mkdir(destination, { recursive: true });
  try {
    const previous = await readFile(target);
    if (digest(previous) !== digest(bytes)) throw Error('Esiste già un pacchetto diverso con questa versione. Aumentare la versione prima di pubblicare.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await copyFile(installer, target);
  await writeFile(target + '.sig', signature + '\n', 'utf8');
  const manifest = {version, notes:notes.trim(), pub_date:new Date().toISOString(), platforms:{'windows-x86_64':{
    url:`https://api.magomme.it/app-updates/windows-x86_64/${name}`, signature
  }}};
  // Change the manifest last: a partially copied release is never advertised.
  const temporary = join(destination, 'latest-' + randomUUID() + '.tmp');
  await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await rename(temporary, join(destination, 'latest.json'));
  console.log('Release pubblica pronta: ' + target);
  console.log('Manifest aggiornato: ' + join(destination, 'latest.json'));
  console.log('SHA-256 installer: ' + digest(bytes));
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
