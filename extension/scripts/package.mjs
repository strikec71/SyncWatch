// Упаковка обновления Chrome Web Store: manifest.json находится в корне ZIP.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm, access, readdir, utimes, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const extRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(extRoot, 'dist');
const outDir = join(distDir, 'packages');

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function zipTarget(target, version) {
  const srcDir = join(distDir, target);
  if (!(await exists(join(srcDir, 'manifest.json')))) {
    throw new Error(`Нет собранной сборки: ${srcDir}/manifest.json. Сначала запусти "npm run build".`);
  }
  const outZip = join(outDir, `syncwatch-${target}-${version}.zip`);
  await rm(outZip, { force: true });
  // Fixed order, permissions and ZIP timestamps make the reviewed package reproducible.
  const files = [];
  async function collect(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) await collect(join(dir, entry.name), path + '/');
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Unexpected build entry: ${path}`);
    }
  }
  await collect(srcDir); files.sort();
  const epoch = new Date('1980-01-01T00:00:00Z');
  for (const path of files) { await chmod(join(srcDir, path), 0o644); await utimes(join(srcDir, path), epoch, epoch); }
  execFileSync('zip', ['-X', outZip, ...files], { cwd: srcDir, stdio: 'inherit', env: { ...process.env, TZ: 'UTC' } });
  return outZip;
}

async function main() {
  const manifest = JSON.parse(await readFile(join(extRoot, 'manifest.json'), 'utf8'));
  const version = manifest.version;
  const pkg = JSON.parse(await readFile(join(extRoot, 'package.json'), 'utf8'));
  if (pkg.version !== version) throw new Error('Версии package.json и Chrome manifest должны совпадать');
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Некорректная версия в manifest.json: ${JSON.stringify(version)}`);
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const chromeZip = await zipTarget('chrome', version);
  const digest = createHash('sha256').update(await readFile(chromeZip)).digest('hex');
  await writeFile(join(outDir, 'SHA256SUMS'), `${digest}  syncwatch-chrome-${version}.zip\n`);

  console.log(`\n✅ Упаковано v${version}:`);
  console.log(`   Chrome  → ${chromeZip}`);
  console.log('\nДальше (см. PUBLISHING.md):');
  console.log('  • Chrome Web Store → существующая карточка SyncWatch (0.6.0) → загрузить ZIP как новую версию.');
}

main().catch((err) => {
  console.error(`✖ package: ${err.message}`);
  process.exit(1);
});
