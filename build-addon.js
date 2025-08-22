#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { platform, arch, exit } = process;
const { join } = require('node:path');
const { mkdirSync, copyFileSync, existsSync } = require('node:fs');

// Helper to run a command and exit on failure
function run(cmd, args, opts) {
    const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
    if (res.status !== 0) {
        exit(res.status || 1);
    }
    return res;
}

const root = __dirname; // script lives at repo/package root
const targetDir = join(root, 'target', 'release');
const outDir = join(root, 'build');
const outName = `${platform}-${arch}.node`;

function artifactPath() {
    for(let name of ['wsbroker.dll', 'libwsbroker.dylib', 'libwsbroker.so']) {
        const artifact = join(targetDir, name);
        if (existsSync(artifact)) {
            return artifact;
        }
    }
}

function buildNative() {
    // Build Rust cdylib using local toolchain
    run('cargo', ['build', '--release', '--manifest-path', join(root, 'Cargo.toml')]);

    const artifact = artifactPath();
    if (!artifact) {
        console.error(`Build succeeded but artifact not found in ${targetDir}`);
        exit(1);
    }

    mkdirSync(outDir, { recursive: true });
    copyFileSync(artifact, join(outDir, outName));
    console.log(`Built native addon -> build/${outName}`);
}

if (process.argv.length == 3 && process.argv[2] === '--postinstall') {
    const candidate = join(outDir, outName);
    if (!existsSync(candidate)) {
        console.log(`[wsbroker] No prebuilt binary for ${platform}-${arch}. Building native addon...`);
        buildNative();
    }
} else if (process.argv.length == 3 && process.argv[2] === '--prepublish') {
    if (!(platform === 'linux' && arch === 'x64')) {
        console.error('[wsbroker] Publishing is only allowed from linux-x64.');
        exit(1);
    }
    buildNative();
} else if (process.argv.length == 2) {
    buildNative();
} else {
    console.error('Usage: build-addon.js [--postinstall|--prepublish]');
    exit(1);
}
