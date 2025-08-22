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
	throw new Error(`warpws: Native binary not found. Searched in ${candidates.join(', ')} for ${filename}. Please run "npm run build:native" to build it.`);
}

module.exports = require(modulePath);
