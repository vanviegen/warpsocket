// Simplified custom loader that looks for prebuilt binaries in a few likely build locations
const fs = require('node:fs');
const path  = require('node:path');

const filename = `${process.platform}-${process.arch}.node`;
const candidates = [
	path.join(__dirname, '..', 'build', filename), // Relative to src/
	path.join(__dirname, '..', '..', 'build', filename), // Relative to dist/src/
];

let modulePath = candidates.find(p => fs.existsSync(p));
if (!modulePath) {
	throw new Error(`warpsocket: Native binary not found. Searched in ${candidates.join(', ')} for ${filename}. Please run "npm run build:native" to build it.`);
}

// Resolve symlinks so the path is canonical (important for dlopen deduplication).
const resolvedPath = fs.realpathSync(modulePath);
module.exports = require(modulePath);
// Expose the resolved .node path so worker threads can load the addon directly
// via process.dlopen, bypassing module cache bugs in some runtimes (e.g. Bun).
module.exports.__nodePath = resolvedPath;
