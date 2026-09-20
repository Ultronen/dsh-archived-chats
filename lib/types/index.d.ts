/**
 * Host loader entry — registers the `/plugins/dsh-archived-chats/*` routes
 * (about, about/check-updates,
 * state, stats, insights, retention/policy, retention/policy/preview,
 * retention/preview, retention/apply,
 * lineage,
 * workspace-archive/workspaces, workspace-archive/preview,
 * workspace-archive/apply,
 * preview, preview/image, search,
 * export, import/inspect, import/restore,
 * metadata, trash, trash/restore, trash/purge, trash/empty, unarchive,
 * unarchive-all, delete, delete-all), streams
 * JSON/Markdown backup ZIPs, and wires archive insights:
 * per-session tags/notes joined into `/state`, storage statistics from
 * `/stats`, guarded projected-message reads through `/preview` and `/search`.
 * `/preview` returns bounded structured tool/image descriptors. The separately
 * listed `/preview/image` route is guarded and read-only, authorizes each stored
 * image against the archived or explicitly trash-scoped session's projected
 * attachment descriptors, and
 * degrades only image loading when the optional attachment service is absent.
 * Metadata mutation remains guarded through `/metadata`, and archive restore is
 * preview-first through the import routes. Import restore is capability
 * detected: modern create handles use append/flush/read/close and safe locate
 * rollback; dedicated restore and explicitly exclusive legacy create/append
 * remain fallbacks. Plain legacy create/append is not considered safe restore.
 * ZIP v2 preserves inherited boundaries; v1 import remains supported when the
 * Host can represent its source format without guessing missing boundaries.
 * Archive mutations fail closed while the
 * recycle catalog is unreadable, and `/state` reports `trashStatus` so the
 * listing can be labelled as unverified. Non-permanent delete creates or
 * reuses a verified local protection snapshot and moves the session into the
 * recycle catalog; the UI exposes this only at workspace scope. Guarded
 * permanent deletion removes related snapshots before the original session
 * and retains durable intent until all remaining cleanup succeeds.
 * Startup migrates legacy pending deletions into recoverable trash and retries
 * only records carrying durable `purge-pending` intent. Direct permanent
 * deletion creates this intent without capturing a snapshot; its snapshotId
 * is null. It uses the same snapshot/session cleanup and retry path as purge.
 * Startup also removes snapshots not referenced by current recycle records,
 * independently of the optional automatic Recycle Bin retention policy.
 */
export type RecycleRecordState = 'trashed' | 'purge-pending' | 'degraded';
export type RecycleLiveDisposition = 'cold' | 'disposed' | 'parked';

export interface RecycleSessionRow {
  sessionId: string;
  state: RecycleRecordState;
  trashedAt: string;
  purgeRequestedAt: string | null;
  title: string | null;
  createdAt: number | null;
  origin: string | null;
  workspace: { id: string | null; title: string | null } | null;
  wasArchived: boolean;
  tags: string[];
  note: string;
  metadataUpdatedAt: string | null;
  /** Null for snapshotless direct permanent deletion or a degraded backup. */
  snapshotId: string | null;
  snapshotBytes: number;
  snapshotAttachmentCount: number;
  liveDisposition: RecycleLiveDisposition;
}

export interface RecycleSummary {
  count: number;
  snapshotBytes: number;
  degradedCount: number;
  purgePendingCount: number;
}

/** Exact recycle-record incarnation captured by a destructive confirmation. */
export interface RecyclePurgeTarget {
  sessionId: string;
  state: 'trashed' | 'degraded';
  trashedAt: string;
  snapshotId: string | null;
  bytes: number;
}

export interface RetentionPolicy {
  /** Legacy compatibility field; does not schedule historical snapshot cleanup. */
  historicalSnapshotsPerSession: number;
  /** Legacy compatibility field; does not schedule historical snapshot cleanup. */
  historicalSnapshotMaxAgeDays: number | null;
  /** Legacy compatibility field; does not schedule historical snapshot cleanup. */
  snapshotQuotaBytes: number | null;
  recycleMaxAgeDays: number | null;
  /** Explicit opt-in; legacy policies load as false. */
  recycleAutoDelete: boolean;
}

export interface StorageInsightsSummary {
  sessionBytes: number;
  snapshotBytes: number;
  totalMeasuredBytes: number;
  duplicateSnapshotBytes: number;
  sessionUnavailableCount: number;
  degradedSnapshotCount: number;
}

export interface StorageInsights {
  generatedAt: string;
  summary: StorageInsightsSummary;
  sessions: Array<{
    id: string;
    title: string | null;
    workspaceId: string | null;
    workspaceTitle: string | null;
    scope: 'archive' | 'trash';
    status: 'ready' | 'unavailable';
    sizeBytes: number | null;
    fileCount: number | null;
  }>;
  snapshots: Array<
    | {
      snapshotId: string;
      sessionId: string;
      createdAt: string;
      totalBytes: number;
      sessionBytes: number;
      attachmentCount: number;
      status: 'ready';
      active: boolean;
    }
    | {
      snapshotId: string;
      status: 'degraded';
      code: string;
      active: boolean;
    }
  >;
  policy: RetentionPolicy;
  candidateSummary: {
    snapshotCount: number;
    recycleCount: number;
    projectedSnapshotBytes: number;
  };
}

export type RetentionCandidate =
  | {
    key: string;
    action: 'purge-trash';
    reason: 'recycle-age';
    sessionId: string;
    state: 'trashed' | 'degraded';
    trashedAt: string;
    snapshotId: string | null;
    bytes: number;
  };

export type LineageStatus = 'active' | 'archived' | 'trash' | 'missing';
export type LineageDiagnosticCode = 'missing-parent' | 'self-parent' | 'cycle' | 'delegation-depth-mismatch';

export interface LineageNode {
  id: string;
  parentSession: string | null;
  seedLength: number | null;
  origin: 'subagent' | null;
  delegationDepth: number;
  title: string | null;
  createdAt: number | null;
  workspace: { id: string | null; title: string | null };
  status: LineageStatus;
  children: LineageNode[];
}

export interface LineageDiagnostic {
  code: LineageDiagnosticCode;
  sessionId: string;
  relatedId: string;
}

export interface LineageResponse {
  /** Archived/recycled chats plus only the parent/child context needed to explain them. */
  roots: LineageNode[];
  diagnostics: LineageDiagnostic[];
  nodeCount: number;
}

export declare function apply(ctx: unknown): void;
export declare const name: string;
