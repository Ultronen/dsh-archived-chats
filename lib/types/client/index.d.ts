/**
 * Browser client entry — the Archived Chats settings section. It keeps the
 * existing searchable archive manager and adds persistent Archived/Recycle Bin
 * tabs. Ordinary archive deletion now moves sessions to recoverable trash and
 * exposes immediate Undo. The recycle view has independent selection, scoped
 * read-only previews, original/snapshot restore, guarded permanent purge and
 * empty operations, degraded-state warnings, responsive rows, and accessible
 * confirmation dialogs, all localized in English and 中文.
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

export declare const SETTINGS_NS: string;
export declare function apply(ctx: unknown): void;
export declare const inject: string[];
