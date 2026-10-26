import { Connection } from 'mongoose';

export const BLOCK_DATABASE_REQUIREMENT =
  'UserBlocks requires MongoDB replica-set or sharded-cluster transactions and logical sessions. Standalone MongoDB is unsupported; configure a replica set before starting this backend.';

/** Read-only probe: fail during boot, before accepting requests or opening streams. */
export async function verifyBlockDatabase(db: Connection) {
  const hello = await db.db.command({ hello: 1 });
  if (
    (!hello.setName && hello.msg !== 'isdbgrid') ||
    hello.logicalSessionTimeoutMinutes == null ||
    hello.maxWireVersion < (hello.msg === 'isdbgrid' ? 8 : 7)
  )
    throw new Error(BLOCK_DATABASE_REQUIREMENT);
  const session = await db.startSession();
  try {
    await session.withTransaction(async () => {
      await db.db.collection('UserBlocks').findOne({}, { session });
    });
  } catch {
    throw new Error(
      `${BLOCK_DATABASE_REQUIREMENT} Startup transaction probe failed; check transaction permissions and primary read preference.`,
    );
  } finally {
    await session.endSession();
  }
}
