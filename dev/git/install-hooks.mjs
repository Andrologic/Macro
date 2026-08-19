#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
  cwd: process.cwd(),
  stdio: 'inherit',
});

console.log('Git hooks installed from .githooks.');
