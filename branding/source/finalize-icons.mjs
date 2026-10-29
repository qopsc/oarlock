import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv[2]) throw new Error('Usage: bun branding/source/finalize-icons.mjs <sharp-module-entry>');
const sharp = (await import(process.argv[2])).default;
const folder = resolve(dirname(fileURLToPath(import.meta.url)), '../app/platforms/ios');
let count = 0;
for (const name of await readdir(folder)) {
  if (!name.endsWith('.png')) continue;
  const path = resolve(folder, name);
  const opaque = await sharp(await readFile(path)).flatten({ background: '#15222F' }).removeAlpha().png().toBuffer();
  await writeFile(path, opaque);
  count++;
}
console.log('Exported ' + count + ' opaque iOS icons.');
