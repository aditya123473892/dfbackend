import { Connection } from 'mongoose';
export async function reportIndexes(
  db: Connection,
  apply = false,
  report = console.log,
) {
  const rows = db.db.collection('Reports');
  const duplicates = await rows
    .aggregate([
      { $match: { open: true } },
      {
        $group: {
          _id: {
            reporterId: '$reporterId',
            targetType: '$targetType',
            targetId: '$targetId',
          },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();
  report(JSON.stringify({ collection: 'Reports', apply, duplicates }));
  if (!apply) return duplicates;
  if (duplicates.length)
    throw new Error(
      'Reports has duplicate open cases; resolve before applying indexes',
    );
  await rows.createIndex(
    { reporterId: 1, targetType: 1, targetId: 1 },
    {
      name: 'report_open_unique',
      unique: true,
      partialFilterExpression: { open: true },
    },
  );
  await rows.createIndex(
    { reporterId: 1, createdAt: -1, _id: -1 },
    { name: 'reporter_page' },
  );
  await rows.createIndex(
    { reporterId: 1, targetType: 1, targetId: 1, createdAt: -1 },
    { name: 'report_target_rate' },
  );
  await rows.createIndex(
    { targetOwnerId: 1, eligible: 1, createdAt: -1 },
    { name: 'report_review_window' },
  );
  await rows.createIndex(
    { status: 1, resolvedAt: 1, legalHold: 1 },
    { name: 'report_retention' },
  );
  await db.db
    .collection('ReportHolds')
    .createIndex({ resources: 1, active: 1 }, { name: 'report_source_holds' });
  await db.db
    .collection('ReportEvidenceJobs')
    .createIndex({ state: 1, dueAt: 1 }, { name: 'report_copy_due' });
  await db.db
    .collection('ReportEvidenceJobs')
    .createIndex({ reportId: 1 }, { name: 'report_copy_case' });
  await db.db
    .collection('ReportEvidence')
    .createIndex({ reportId: 1 }, { name: 'report_evidence_case' });
  await db.db
    .collection('RestrictedReportEvidence')
    .createIndex({ reportId: 1 }, { name: 'restricted_evidence_case' });
  await db.db
    .collection('StaffAuditLog')
    .createIndex(
      { reportId: 1, timestamp: 1 },
      { name: 'report_system_audit_case' },
    );
  await db.db.collection('ReportTransitions').createIndex(
    { reportId: 1, createdAt: -1 }, { name: 'report_transition_case' },
  );
  await db.db
    .collection('ReportAccess')
    .createIndex(
      { viewerId: 1, resource: 1 },
      { name: 'report_prior_access', unique: true },
    );
  // Intentionally no TTL indexes: evidence and holds need case/hold-aware retention.
  return duplicates;
}
