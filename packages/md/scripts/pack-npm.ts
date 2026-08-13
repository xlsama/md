#!/usr/bin/env bun
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pkg from '../package.json';

// Builds one per-platform npm package (the esbuild layout): a bare package that
// carries a single binary and is constrained by `os`/`cpu`, so npm installs only
// the matching one out of the main package's optionalDependencies.
const PKG_ROOT = path.resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const platform = flag('platform');
if (!platform) throw new Error('usage: pack-npm.ts --platform=<os>-<cpu> [--binary=…] [--outdir=…]');

const [os, cpu] = platform.split('-');
if (!os || !cpu) throw new Error(`invalid --platform=${platform}, expected <os>-<cpu> e.g. darwin-arm64`);

const exe = os === 'win32' ? 'md.exe' : 'md';
const binary = flag('binary') ?? path.join(PKG_ROOT, 'dist', exe);
const outdir = path.join(flag('outdir') ?? path.join(PKG_ROOT, 'npm-packages'), `md-${platform}`);

mkdirSync(path.join(outdir, 'bin'), { recursive: true });
const target = path.join(outdir, 'bin', exe);
copyFileSync(binary, target);
if (os !== 'win32') chmodSync(target, 0o755);

writeFileSync(
  path.join(outdir, 'package.json'),
  `${JSON.stringify(
    {
      name: `@xlsama/md-${platform}`,
      version: pkg.version,
      description: `${platform} binary for @xlsama/md`,
      license: pkg.license,
      repository: pkg.repository,
      homepage: pkg.homepage,
      os: [os],
      cpu: [cpu],
      files: ['bin'],
    },
    null,
    2,
  )}\n`,
);

console.log(`${path.relative(PKG_ROOT, outdir)}  @xlsama/md-${platform}@${pkg.version}`);
