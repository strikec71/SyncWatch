// Сборка расширения: бандлит TS-точки входа в dist/<target>/ + копирует статику.
// Цели: chrome (manifest.json) и firefox (manifest.firefox.json). По умолчанию
// собираются обе; флаги --chrome / --firefox ограничивают одной.
// Запуск: `node esbuild.config.mjs` или `--watch`.

import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const onlyChrome = process.argv.includes('--chrome');
const onlyFirefox = process.argv.includes('--firefox');
const targets = onlyChrome ? ['chrome'] : onlyFirefox ? ['firefox'] : ['chrome', 'firefox'];

async function buildTarget(target) {
  const outdir = `dist/${target}`;
  const manifestSrc = target === 'firefox' ? 'manifest.firefox.json' : 'manifest.json';

  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  await cp(manifestSrc, `${outdir}/manifest.json`);

  const ctx = await esbuild.context({
    entryPoints: {
      background: 'src/background/index.ts',
      content: 'src/content/index.ts',
    },
    bundle: true,
    format: 'iife',
    target: 'chrome110', // целевой синтаксис JS (совместим и с Firefox 121+)
    outdir,
    logLevel: 'info',
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

for (const target of targets) {
  await buildTarget(target);
}

if (watch) {
  console.log(`esbuild: слежу за изменениями (${targets.join(', ')})…`);
}
