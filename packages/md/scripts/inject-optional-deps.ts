#!/usr/bin/env bun
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Writes the per-platform packages into the main package's optionalDependencies
// right before publishing. They are deliberately absent from the committed
// package.json: they only exist on the registry after a release, so keeping them
// there would churn the lockfile and make every contributor download a ~30 MB
// binary they never use.
//
// The platform list is read from the packed output rather than hardcoded, so the
// main package can only ever depend on binaries this release actually produced.
const PKG_ROOT = path.resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const dir = path.resolve(flag('dir') ?? path.join(PKG_ROOT, 'npm-packages'));
const PKG_PATH = path.join(PKG_ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8')) as Record<string, unknown> & { version: string };

const names = readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => {
    const manifest = JSON.parse(readFileSync(path.join(dir, e.name, 'package.json'), 'utf8')) as { name: string };
    return manifest.name;
  })
  .sort();

if (names.length === 0) throw new Error(`no packed platform packages found in ${dir}`);

pkg.optionalDependencies = Object.fromEntries(names.map((name) => [name, pkg.version]));
writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`injected ${names.length} optional deps at ${pkg.version}: ${names.join(', ')}`);
