'use strict';

const { spawn } = require('node:child_process');

const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'server.js'], {
  stdio:'inherit',
  env:{ ...process.env, DEMO_MODE:'true', HOST:'0.0.0.0' },
});
child.on('exit', (code) => { process.exitCode = code || 0; });
