#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

try {
    const dotenv = require('dotenv');
    const localEnv = path.join(__dirname, 'ebay-payout-bot.env');
    if (fs.existsSync(localEnv)) dotenv.config({ path: localEnv });
} catch {
    /* optional */
}

function resolveChromePath() {
    const candidates = [
        path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const p of candidates) {
        if (p && fs.existsSync(p)) return p;
    }
    throw new Error('Could not find chrome.exe. Set CHROME_PATH env var to your Chrome executable.');
}

function main() {
    const chromePath = process.env.CHROME_PATH || resolveChromePath();
    const port = process.env.BROWSER_DEBUG_PORT || '9222';
    const profileRoot = process.env.EBAY_CHROME_USER_DATA_DIR || path.join(process.cwd(), '.ebay-chrome-profile');
    const profileDir = process.env.EBAY_CHROME_PROFILE_DIR || 'Default';
    fs.mkdirSync(profileRoot, { recursive: true });

    const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileRoot}`,
        `--profile-directory=${profileDir}`,
    ];

    if (/^(1|true|yes)$/i.test(String(process.env.EBAY_CHROME_DISABLE_EXTENSIONS || ''))) {
        args.push('--disable-extensions');
        console.log('EBAY_CHROME_DISABLE_EXTENSIONS: extensions disabled for this session.');
    }
    if (/^(1|true|yes)$/i.test(String(process.env.EBAY_CHROME_DISABLE_GPU || ''))) {
        args.push('--disable-gpu');
        console.log('EBAY_CHROME_DISABLE_GPU: GPU disabled for this session.');
    }

    args.push(
        process.env.EBAY_ORDERS_LIST_URL ||
            'https://www.ebay.co.uk/sh/ord/?filter=status%3APAID_SHIPPED%2Ctimerange%3APREVIOUSYEAR',
    );

    const child = spawn(chromePath, args, {
        detached: true,
        stdio: 'ignore',
    });
    child.unref();

    console.log(`Started Chrome debug session on port ${port}`);
    console.log(`Profile storage: ${profileRoot}`);
    console.log('Sign in once in this Chrome window; session should persist for future runs.');
    console.log('');
    console.log('If NEW TABS never load in this window but another Chrome profile works:');
    console.log('  1) Fully quit every Chrome using this folder (check Task Manager for chrome.exe).');
    console.log('  2) Rename or delete the profile folder above, then run npm run ebay:chrome again (clean sign-in).');
    console.log('  3) Or use a fresh folder: set EBAY_CHROME_USER_DATA_DIR to an empty path, then start again.');
    console.log('  4) Or try: set EBAY_CHROME_DISABLE_EXTENSIONS=1 then npm run ebay:chrome (bad extension often breaks tabs).');
}

main();
