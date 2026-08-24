/**
 * Host loader entry — registers the `/plugins/dsh-archived-chats/*` routes
 * (state, stats, preview, preview/image, search, export, import/inspect, import/restore,
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
 * preview-first through the import routes. Import restore is capability detected
 * and returns `restore-unsupported` when the host has no writer. Ordinary
 * delete creates a verified local protection snapshot and moves the session
 * into the recycle catalog; only guarded trash purge physically deletes it.
 * Startup migrates legacy pending deletions into recoverable trash and retries
 * only records carrying durable `purge-pending` intent.
 */
export interface RetentionPolicy {
  historicalSnapshotsPerSession: number;
  historicalSnapshotMaxAgeDays: number | null;
  snapshotQuotaBytes: number | null;
  recycleMaxAgeDays: number | null;
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
    action: 'delete-snapshot';
    reason: 'history-count' | 'snapshot-age' | 'snapshot-quota';
    snapshotId: string;
    sessionId: string;
    createdAt: string;
    bytes: number;
  }
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
  roots: LineageNode[];
  diagnostics: LineageDiagnostic[];
  nodeCount: number;
}

export declare function apply(ctx: unknown): void;
export declare const name: string;
