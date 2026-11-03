'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { buildContentIndex } = require('./content-search.cjs');
try { parentPort.postMessage(buildContentIndex({ files: workerData.files }, workerData.root)); }
catch (error) { parentPort.postMessage({ error: error.message }); }
