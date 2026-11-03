// Node entry for tools\repo-backup.ps1: Task Scheduler runs every HQ routine as `node <args>` through run-hidden.vbs,
// which can't start a .ps1 directly. Passes its flags through (-RestoreTest, -FirstSundayOnly) and the exit code back.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'repo-backup.ps1');
const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
process.exit(r.status ?? 1);
