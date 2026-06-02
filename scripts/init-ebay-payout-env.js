#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, 'ebay-payout-bot.env');
const examplePath = path.join(__dirname, 'ebay-payout-bot.env.example');

if (fs.existsSync(envPath)) {
    console.log(`Already exists: ${envPath}`);
    console.log('Run: npm run ebay:env:check');
    process.exit(0);
}

if (!fs.existsSync(examplePath)) {
    console.error(`Missing template: ${examplePath}`);
    process.exit(1);
}

fs.copyFileSync(examplePath, envPath);
console.log(`Created ${envPath} from example.`);
console.log('Edit paths/passwords if needed, then: npm run ebay:env:check');
