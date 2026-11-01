const fs = require('node:fs');
const path = require('node:path');
const source = path.join(__dirname, '../src/common/templates');
const destination = path.join(__dirname, '../dist/src/common/templates');
fs.mkdirSync(destination, { recursive: true });
fs.cpSync(source, destination, { recursive: true });
console.log('Email templates copied to the compiled application.');
