#!/usr/bin/env bun
import path from 'node:path';

// oxfmt lazily imports these prettier plugins for template languages we never format.
// They are not installed, and the bundler resolves lazy imports eagerly, so they have
// to be marked external or `bun build` fails.
const EXTERNAL = [
  '@prettier/plugin-hermes',
  '@prettier/plugin-oxc',
  '@prettier/plugin-pug',
  '@shopify/prettier-plugin-liquid',
  '@zackad/prettier-plugin-twig',
  'prettier-plugin-astro',
  'prettier-plugin-marko',
];

const PKG_ROOT = path.resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const target = flag('target');
const suffix = target ? target.replace(/^bun-/, '') : '';
const outfile = flag('outfile') ?? path.join(PKG_ROOT, 'dist', suffix ? `md-${suffix}` : 'md');

await import('./gen-assets.ts');

const cmd = [
  'bun',
  'build',
  '--compile',
  path.join(PKG_ROOT, '.gen', 'entry.ts'),
  '--outfile',
  outfile,
  ...EXTERNAL.flatMap((e) => ['--external', e]),
];
if (target) cmd.push(`--target=${target}`);

const proc = Bun.spawn({ cmd, cwd: PKG_ROOT, stdout: 'inherit', stderr: 'inherit' });
const code = await proc.exited;
if (code !== 0) process.exit(code);

const built = Bun.file(target?.includes('windows') ? `${outfile}.exe` : outfile);
console.log(`${path.relative(PKG_ROOT, outfile)}  ${(built.size / 1024 / 1024).toFixed(1)} MB`);
