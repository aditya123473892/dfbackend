import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { ConflictException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Connection } from 'mongoose';

const gateContext = new AsyncLocalStorage<Connection>();
const logger = new Logger('ReportPreservation');
const leaseMs = 60000;
/**
 * A live holder renews its lease every leaseMs / 3, and S3 requests time out
 * after 30s, so a lease this long past expiry belongs to a process that died
 * holding it. It is taken over instead of blocking every deletion until an
 * operator runs recovery.
 */
export const staleLeaseMs = 2 * leaseMs;
/** Expiring, renewable lease; abandoned leases are taken over (see staleLeaseMs). */
export async function preservationGate<T>(
  db: Connection,
  work: () => Promise<T>,
): Promise<T> {
  if (!db?.getClient || gateContext.getStore() === db) return work();
  const locks = db.db.collection<any>('ReportCoordination');
  const token = randomUUID(),
    until = Date.now() + 10000;
  let nextTakeover = 0;
  for (;;) {
    try {
      await locks.insertOne(
        {
          _id: 'sources',
          token,
          startedAt: new Date(),
          leaseUntil: new Date(Date.now() + leaseMs),
          pid: process.pid,
        },
        { writeConcern: { w: 'majority' } },
      );
      break;
    } catch (error) {
      if (error.code !== 11000) throw error;
      if (Date.now() >= nextTakeover) {
        nextTakeover = Date.now() + 1000;
        const stale = new Date(Date.now() - staleLeaseMs);
        const abandoned = await locks.findOneAndUpdate(
          { _id: 'sources', $or: [{ leaseUntil: { $lt: stale } }, { leaseUntil: { $exists: false } }] },
          { $set: { token, startedAt: new Date(), leaseUntil: new Date(Date.now() + leaseMs), pid: process.pid } },
          { writeConcern: { w: 'majority' } },
        );
        if (abandoned) {
          logger.warn(JSON.stringify({ metric: 'report_gate_takeover', count: 1 }));
          break;
        }
      }
      if (Date.now() >= until) {
        const stuck = await locks.findOne({ _id: 'sources' });
        logger.warn(JSON.stringify({ metric: 'report_gate_busy', count: 1,
          expired: !stuck?.leaseUntil || stuck.leaseUntil <= new Date() }));
        throw new ServiceUnavailableException(
          'Content preservation is busy; please retry',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const heartbeat = setInterval(() => {
    void locks.updateOne({ _id: 'sources', token },
      { $set: { leaseUntil: new Date(Date.now() + leaseMs) } },
      { writeConcern: { w: 'majority' } })
      .then((result) => { if (!result.matchedCount) logger.error('Report gate lease was taken over'); })
      .catch(() => logger.error('Report gate lease renewal failed'));
  }, leaseMs / 3);
  heartbeat.unref();
  try {
    return await gateContext.run(db, work);
  } finally {
    clearInterval(heartbeat);
    await locks.deleteOne(
      { _id: 'sources', token },
      { writeConcern: { w: 'majority' } },
    );
  }
}
export async function hasPreservationHold(db: Connection, resources: string[]) {
  if (!db?.getClient) return false;
  return !!(await db.db
    .collection('ReportHolds')
    .findOne(
      { active: true, resources: { $in: resources } },
      { projection: { _id: 1 } },
    ));
}
/** Immediate manual release of an expired lease, without waiting for automatic takeover. */
export async function recoverPreservationGate(db: Connection, expectedToken: string) {
  const result = await db.db.collection<any>('ReportCoordination').deleteOne({
    _id: 'sources', token: expectedToken,
    $or: [{ leaseUntil: { $lte: new Date() } }, { leaseUntil: { $exists: false } }],
  }, { writeConcern: { w: 'majority' } });
  if (!result.deletedCount) throw new Error('Gate changed or lease is still active; recovery denied');
  logger.warn('report_gate_operator_recovery count=1');
}
export async function preserveMutation<T>(
  db: Connection,
  resources: string[],
  work: () => Promise<T>,
  authorize?: () => Promise<unknown>,
): Promise<T> {
  return preservationGate(db, async () => {
    if (authorize) await authorize();
    // Text is already snapshotted atomically. User deletion must remain normal;
    // only irreversible object-byte deletion waits for retention to release holds.
    if (resources.some((resource) => resource.startsWith('key:')) &&
        await hasPreservationHold(db, resources))
      throw new ConflictException('Content cannot be changed right now');
    return work();
  });
}
