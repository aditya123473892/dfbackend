import { blockIndexes, warnMissingBlockIndexes } from './block-indexes';
describe('Opt-in UserBlocks indexes', () => {
  const fixture = (duplicates: any[] = []) => {
    const rows = {
      aggregate: jest.fn(() => ({ toArray: async () => duplicates })),
      createIndex: jest.fn(),
    };
    return { rows, db: { db: { collection: () => rows } } as any };
  };
  it('reports duplicates without writes by default', async () => {
    const { rows, db } = fixture([{ count: 2 }]);
    const report = jest.fn();
    expect(await blockIndexes(db, false, report)).toEqual([{ count: 2 }]);
    expect(report).toHaveBeenCalled();
    expect(rows.createIndex).not.toHaveBeenCalled();
  });
  it('refuses unsafe unique-index application and creates required indexes only on explicit apply', async () => {
    const bad = fixture([{ count: 2 }]);
    await expect(blockIndexes(bad.db, true, () => {})).rejects.toThrow(
      'duplicate',
    );
    expect(bad.rows.createIndex).not.toHaveBeenCalled();
    const good = fixture();
    await blockIndexes(good.db, true, () => {});
    expect(good.rows.createIndex).toHaveBeenCalledWith(
      { blockerId: 1, blockedId: 1 },
      expect.objectContaining({ unique: true }),
    );
    expect(good.rows.createIndex).toHaveBeenCalledWith(
      { blockedId: 1 },
      expect.any(Object),
    );
  });
  it('warns at startup about missing operator-managed indexes without creating them', async () => {
    const rows = {
      listIndexes: () => ({ toArray: async () => [{ name: '_id_' }, { name: 'blocked_user' }] }),
      createIndex: jest.fn(),
    };
    const warn = jest.fn();
    await warnMissingBlockIndexes({ db: { collection: () => rows } } as any, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('block_pair_unique, block_page'));
    expect(rows.createIndex).not.toHaveBeenCalled();
    const complete = {
      listIndexes: () => ({
        toArray: async () =>
          ['block_pair_unique', 'blocked_user', 'block_page'].map((name) => ({ name })),
      }),
    };
    const quiet = jest.fn();
    await warnMissingBlockIndexes({ db: { collection: () => complete } } as any, quiet);
    expect(quiet).not.toHaveBeenCalled();
  });
});
