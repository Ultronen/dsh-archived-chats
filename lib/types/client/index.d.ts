/**
 * Browser client entry — the Archive Management settings section with a workspace
 * chooser and one-confirmation bulk archive flow. The flow stays inside the
 * plugin-owned Settings surface and requires no workspace-row extension slot.
 * The searchable manager includes Archived, Recycle Bin, Storage & Retention,
 * Origins & Branches, and About views. Only workspace actions move archived
 * chats to the Recycle Bin and offer immediate Undo. Delete/Delete all instead
 * require confirmation for irreversible permanent deletion. Recycle restore
 * returns chats to Archived; Unarchive returns them to the main chat area.
 * The recycle view provides original-backed read-only previews,
 * capability-dependent original/snapshot restore, guarded
 * permanent purge and empty operations, degraded-state warnings, responsive
 * rows, and accessible confirmation dialogs, all localized in English and 中文.
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

export interface RetentionPolicy {
  historicalSnapshotsPerSession: number;
  historicalSnapshotMaxAgeDays: number | null;
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

export declare const SETTINGS_NS: string;
export declare function apply(ctx: unknown): void;
export declare const inject: string[];
