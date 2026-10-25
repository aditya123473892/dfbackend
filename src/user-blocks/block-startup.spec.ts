import { BlockService } from './block.service';
import { verifyBlockDatabase } from './block-startup';
describe('Block startup topology check', () => {
  function fixture(hello: any, fail = false) {
    const rows = {
      findOne: jest.fn().mockResolvedValue(null),
      createIndex: jest.fn(),
      watch: jest.fn(),
    };
    const session = {
      withTransaction: jest.fn(async (fn) => {
        if (fail) throw Error('not authorized');
        await fn();
      }),
      endSession: jest.fn(),
    };
    const db: any = {
      db: {
        command: jest.fn().mockResolvedValue(hello),
        collection: jest.fn(() => rows),
      },
      startSession: jest.fn().mockResolvedValue(session),
    };
    return { rows, session, db };
  }
  it('refuses standalone MongoDB at startup before indexes or sockets', async () => {
    const { db, rows } = fixture({
      isWritablePrimary: true,
      maxWireVersion: 25,
      logicalSessionTimeoutMinutes: 30,
    });
    await expect(new BlockService(db).onModuleInit()).rejects.toThrow(
      'Standalone MongoDB is unsupported',
    );
    expect(db.startSession).not.toHaveBeenCalled();
    expect(rows.createIndex).not.toHaveBeenCalled();
    expect(rows.watch).not.toHaveBeenCalled();
  });
  it('requires logical sessions and transaction-capable server versions', async () => {
    for (const hello of [
      { setName: 'rs', maxWireVersion: 25 },
      { setName: 'rs', maxWireVersion: 6, logicalSessionTimeoutMinutes: 30 },
    ])
      await expect(verifyBlockDatabase(fixture(hello).db)).rejects.toThrow(
        'requires MongoDB',
      );
  });
  it('probes replica-set transactions with a read only and closes the session', async () => {
    const { db, rows, session } = fixture({
      setName: 'rs',
      maxWireVersion: 25,
      logicalSessionTimeoutMinutes: 30,
    });
    await verifyBlockDatabase(db);
    expect(rows.findOne).toHaveBeenCalledWith({}, { session });
    expect(session.endSession).toHaveBeenCalled();
    expect(rows.createIndex).not.toHaveBeenCalled();
  });
  it('fails loudly when the startup transaction probe is unavailable', async () => {
    const { db, session } = fixture(
      { setName: 'rs', maxWireVersion: 25, logicalSessionTimeoutMinutes: 30 },
      true,
    );
    await expect(verifyBlockDatabase(db)).rejects.toThrow(
      'Startup transaction probe failed',
    );
    expect(session.endSession).toHaveBeenCalled();
  });
});
