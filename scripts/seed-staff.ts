import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { createConnection } from 'mongoose';
import { ERole } from '../src/common/enums';
import { UsersSchema } from '../src/common/schemas/users.schema';
dotenv.config();

/**
 * Creates (or promotes) one admin and one moderator account.
 *
 *   SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=... \
 *   SEED_MODERATOR_EMAIL=... SEED_MODERATOR_PASSWORD=... \
 *   npm run seed:staff
 *
 * Uses DATABASE_URL / DATABASE_NAME, like the API. Safe to run again: an existing account
 * keeps its password and only gains the role, unless SEED_RESET_PASSWORD=true.
 * Passwords come from the environment only and are never printed.
 */
type Seed = { role: ERole.ADMIN | ERole.MODERATOR; email: string; password: string; name: string };

function seeds(env: NodeJS.ProcessEnv): Seed[] {
  const read = (role: Seed['role'], prefix: string, name: string): Seed => {
    const email = env[`${prefix}_EMAIL`]?.trim().toLowerCase() ?? '';
    const password = env[`${prefix}_PASSWORD`] ?? '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Set ${prefix}_EMAIL to an email address.`);
    // Same minimum as the app's sign-up form.
    if (password.length < 8) throw new Error(`Set ${prefix}_PASSWORD (at least 8 characters).`);
    return { role, email, password, name };
  };
  return [read(ERole.ADMIN, 'SEED_ADMIN', 'Admin'), read(ERole.MODERATOR, 'SEED_MODERATOR', 'Moderator')];
}

async function main() {
  const list = seeds(process.env);
  const resetPassword = process.env.SEED_RESET_PASSWORD === 'true';
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL.');
  const db = await createConnection(process.env.DATABASE_URL, { dbName: process.env.DATABASE_NAME }).asPromise();
  try {
    const Users = db.model('Users', UsersSchema, 'Users');
    for (const seed of list) {
      const existing = await Users.findOne({ username: seed.email });
      if (existing) {
        existing.roles = [...new Set([...(existing.roles ?? []), ERole.USER, seed.role])];
        existing.isEmailVerified = true;
        // The schema hook hashes it on save.
        if (resetPassword) existing.password = seed.password;
        await existing.save();
        console.log(`${seed.role}: existing account ${seed.email} has the role${resetPassword ? ' and a new password' : ''}.`);
        continue;
      }
      // Display names are unique; add a number if "Admin" or "Moderator" is taken.
      let displayname = seed.name;
      for (let n = 2; await Users.exists({ displayname }); n++) displayname = `${seed.name} ${n}`;
      await Users.create({
        username: seed.email,
        password: seed.password,
        displayname,
        firstName: seed.name,
        lastName: '',
        roles: [ERole.USER, seed.role],
        isEmailVerified: true,
        canEditProfile: true,
      });
      console.log(`${seed.role}: created ${seed.email} (${displayname}).`);
    }
  } finally {
    await db.close();
  }
}

main().catch((error: Error) => {
  // Never echo the connection string or passwords.
  console.error(`Seeding staff failed: ${error.message.replace(/mongodb(\+srv)?:\/\/\S+/g, '<database>')}`);
  process.exitCode = 1;
});
