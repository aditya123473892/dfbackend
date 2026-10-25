const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, `../.env.${process.env.NODE_ENV || 'development'}`), quiet: true });
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
const mongoose = require('mongoose');
(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const conn = await mongoose.createConnection(process.env.DATABASE_URL, {
    dbName: process.env.DATABASE_NAME, serverSelectionTimeoutMS: 5000,
  }).asPromise();
  try {
    await conn.db.admin().ping();
    console.log('MongoDB authenticated ping OK; database:', conn.name);
  } finally { await conn.close(); }
})().catch(error => {
  console.error('Database check failed:', error.name, error.code || '');
  console.error('Start MongoDB (and Docker Desktop if using containers), then check DATABASE_URL and DATABASE_NAME.');
  process.exitCode = 1;
});
