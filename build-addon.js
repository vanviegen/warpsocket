#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { platform, arch, exit } = process;
const path = require('node:path');
const { mkdirSync, copyFileSync, existsSync } = require('node:fs');

// Parse CLI flags
let mode = "default"; // "default" | "postinstall" | "prepublish"
let profile = "release"; // "debug" | "release"
for (let a of process.argv.slice(2)) {
    if (a === '--postinstall' || a === '--prepublish') {
        mode = a.slice(2);
    } else if (a === '--debug' || a === '--release') {
        profile = a.slice(2);
    } else {
        console.error(`Unknown argument: ${a}`);
        console.error('Usage: build-addon.js [--postinstall|--prepublish] [--debug|--release]');
        exit(1);
    }
}

const outDir = path.join(__dirname, 'build'); // script lives at repo/package root
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${platform}-${arch}.node`);

if (mode==='postinstall') {
    if (existsSync(outPath)) exit(0); // already built
    console.log(`[warpsocket] No prebuilt binary for ${platform}-${arch}. Building native addon...`);
} else if (mode==='prepublish') {
    if (!(platform === 'linux' && arch === 'x64')) {
        console.error('[warpsocket] Publishing is only allowed from linux-x64.');
        exit(1);
    }
}

const res = spawnSync("cargo", ['build'].concat(profile==='release' ? ['--release'] : []), { stdio: 'inherit' });
if (res.status !== 0) exit(res.status || 1);

const artifacts = ['warpsocket.dll', 'libwarpsocket.dylib', 'libwarpsocket.so'].map(name => path.join(__dirname, 'target', profile, name));
const artifact = artifacts.find(p => existsSync(p));
if (!artifact) {
    console.error(`Build succeeded but artifact not found in`, artifacts);
    exit(1);
}

copyFileSync(artifact, outPath);
console.log(`Built native addon -> ${outPath}`);
