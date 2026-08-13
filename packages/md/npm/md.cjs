#!/usr/bin/env node
'use strict';

// The real program is a Bun-compiled binary shipped in a per-platform optional
// dependency; npm installs only the one matching os/cpu. This shim just hands
// argv over to it, so `npm i -g @xlsama/md` needs nothing but Node.
const { spawnSync } = require('node:child_process');

const pkg = `@xlsama/md-${process.platform}-${process.arch}`;
const exe = process.platform === 'win32' ? 'md.exe' : 'md';

let binary;
try {
  binary = require.resolve(`${pkg}/bin/${exe}`);
} catch {
  console.error(`md: no prebuilt binary for ${process.platform}-${process.arch}`);
  console.error(`md: expected optional dependency ${pkg} to be installed`);
  console.error('md: if your installer skips optional dependencies, reinstall with them enabled');
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) {
  console.error(`md: failed to run ${binary}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
