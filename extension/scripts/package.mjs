// Упаковка store-ready артефактов из dist/chrome и dist/firefox (Фаза C).
// Запуск: `npm run package` (сначала прогоняет build, затем этот скрипт).
// Итог в dist/packages/ (dist/ в .gitignore — артефакты не коммитятся):
//   syncwatch-chrome-<v>.zip   → загрузка в Chrome Web Store (unlisted)
//   syncwatch-firefox-<v>.zip  → загрузка в Firefox AMO (self-distribution → подписанный .xpi)
// zip запускается с cwd=dist/<target>, чтобы manifest.json лежал в КОРНЕ архива (требование сторов).

import { execFileSync } from 'node:child_process';
import { readFile, mkdir, rm, access } from 'node:fs/promises';
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
  // -r рекурсивно, -X без macOS-метаданных, '.' — содержимое cwd (manifest в корне архива).
  execFileSync('zip', ['-r', '-X', outZip, '.'], { cwd: srcDir, stdio: 'inherit' });
  return outZip;
}

async function main() {
  const manifest = JSON.parse(await readFile(join(extRoot, 'manifest.json'), 'utf8'));
  const version = manifest.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Некорректная версия в manifest.json: ${JSON.stringify(version)}`);
  }

  await mkdir(outDir, { recursive: true });
  const chromeZip = await zipTarget('chrome', version);
  const firefoxZip = await zipTarget('firefox', version);

  console.log(`\n✅ Упаковано v${version}:`);
  console.log(`   Chrome  → ${chromeZip}`);
  console.log(`   Firefox → ${firefoxZip}`);
  console.log('\nДальше (см. PUBLISHING.md):');
  console.log('  • Chrome: загрузи chrome-zip в CWS Developer Dashboard (видимость Unlisted).');
  console.log('  • Firefox: загрузи firefox-zip в AMO (self-distribution) → получишь подписанный .xpi.');
  console.log(`  • Переименуй подписанный .xpi в syncwatch-firefox-${version}.xpi и приложи к GitHub-релизу v${version}.`);
}

main().catch((err) => {
  console.error(`✖ package: ${err.message}`);
  process.exit(1);
});
