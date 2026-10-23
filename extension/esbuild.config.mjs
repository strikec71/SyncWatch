// Сборка только Chrome MV3 в dist/chrome.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
if (process.argv.some(arg => !['--chrome', '--watch'].includes(arg) && arg.startsWith('--'))) throw new Error('Поддерживается только сборка Chrome');
const targets = ['chrome'];
await rm('dist/firefox', { recursive: true, force: true });

async function buildTarget(target) {
  const outdir = `dist/${target}`;
  const manifestSrc = 'manifest.json';

  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  await cp(manifestSrc, `${outdir}/manifest.json`);
  await cp('icons', `${outdir}/icons`, { recursive: true });

  const ctx = await esbuild.context({
    entryPoints: {
      background: 'src/background/index.ts',
      content: 'src/content/index.ts',
      fullscreen: 'src/content/fullscreen.ts',
    },
    bundle: true,
    format: 'iife',
    target: 'chrome120',
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
