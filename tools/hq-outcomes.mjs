#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import outcomesLib from '../lib/hq-outcomes.cjs';

const kitDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fresh = process.argv.includes('--fresh');
const result = await outcomesLib.getOutcomes({ kitDir, fresh });
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
