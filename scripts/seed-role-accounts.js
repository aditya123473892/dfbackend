const { MongoClient } = require('mongodb');
const { genSalt, hash } = require('bcrypt');

const uri = process.env.DATABASE_URL || 'mongodb://root:password@localhost:27017/?authSource=admin';
const dbName = process.env.DATABASE_NAME || 'darkfantasy';
const PASSWORD = 'Test1234@';

const accounts = [
  { username: 'root@darkfantasy.local', firstName: 'Root', lastName: 'Owner', roles: ['root'], displayname: 'root-owner' },
  { username: 'admin@darkfantasy.local', firstName: 'Site', lastName: 'Admin', roles: ['admin'], displayname: 'site-admin' },
  { username: 'manager@darkfantasy.local', firstName: 'Site', lastName: 'Manager', roles: ['manager'], displayname: 'site-manager' },
  { username: 'user@darkfantasy.local', firstName: 'Demo', lastName: 'User', roles: ['user'], displayname: 'demo-user' },
];

async function run() {
  const client = new MongoClient(uri);
  await client.connect();
  const col = client.db(dbName).collection('Users');
  const salt = await genSalt(10);
  const hashed = await hash(PASSWORD, salt);
  for (const a of accounts) {
    const existing = await col.findOne({ username: a.username });
    if (existing) {
      await col.updateOne(
        { username: a.username },
        { $set: { password: hashed, roles: a.roles, isEmailVerified: true, isBlocked: false, blockedBy: 'open', status: 'open', loginAttempts: 0, passwordResetTokenUsed: true, passwordResetToken: null } },
      );
      console.log('updated: ' + a.username + ' roles=' + a.roles.join(','));
    } else {
      await col.insertOne({
        username: a.username,
        password: hashed,
        displayname: a.displayname,
        firstName: a.firstName,
        lastName: a.lastName,
        phoneNumber: '9999999999',
        gender: 'Male',
        age: 30,
        isEmailVerified: true,
        loginCount: 0,
        loginAttempts: 0,
        isBlocked: false,
        blockedBy: 'open',
        status: 'open',
        roles: a.roles,
        canEditProfile: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      console.log('created: ' + a.username + ' roles=' + a.roles.join(','));
    }
  }
  await client.close();
  console.log('ALL DONE password=' + PASSWORD);
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
