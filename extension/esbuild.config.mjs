// Сборка только Chrome MV3 в dist/chrome.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { normalizeServerUrl } from './src/shared/validation.ts';

const configuredServer = process.env.SYNCWATCH_SERVER_URL || '';
const defaultServer = configuredServer ? normalizeServerUrl(configuredServer) : '';
if (configuredServer && (!defaultServer || new URL(defaultServer).protocol !== 'wss:' || new URL(defaultServer).pathname !== '/')) {
  throw new Error('SYNCWATCH_SERVER_URL must be an HTTPS/WSS server origin without credentials, query or fragment');
}

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
  await writeFile(`${outdir}/release-config.json`, JSON.stringify({ serverUrl: defaultServer }, null, 2) + '\n');

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
    define: { __SYNCWATCH_SERVER_URL__: JSON.stringify(defaultServer) },
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
