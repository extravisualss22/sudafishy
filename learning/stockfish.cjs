// Run the repository's existing Stockfish build as a UCI subprocess without
// altering its browser distribution or loading it into sudalol's search.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const filename = path.resolve(__dirname, '../public/engine/stockfish-19-lite-single.js');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
const engine = loaded.exports();
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => engine.processCommand(line));
process.stdin.on('end', () => process.exit(0));
