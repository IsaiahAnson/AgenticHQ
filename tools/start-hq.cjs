// Starts Agentic HQ (server.js) detached with no console window, logging to os-runs\hq-server.log.
// Exits without starting a second copy when port 50000 already listens. Called by tools\start-hq.vbs.
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const sock = net.createConnection({ host: '127.0.0.1', port: 50000 });
sock.once('connect', () => { sock.destroy(); console.log('HQ already listening on :50000'); });
sock.once('error', () => {
  const log = fs.openSync(path.join(root, 'os-runs', 'hq-server.log'), 'a');
  fs.writeSync(log, `\n--- ${new Date().toISOString()} start-hq\n`);
  spawn(process.execPath, ['server.js'], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log] }).unref();
  console.log('HQ started');
});
