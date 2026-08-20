/**
 * Host loader entry — registers the `/plugins/dsh-archived-chats/*` routes
 * (state, stats, export, import/inspect, import/restore, metadata, unarchive,
 * unarchive-all, delete, delete-all), streams JSON/Markdown backup ZIPs, and wires archive insights:
 * per-session tags/notes joined into `/state`, storage statistics from
 * `/stats`, guarded metadata mutation through `/metadata`, and preview-first
 * archive restore through the import routes. Import restore is capability
 * detected and returns `restore-unsupported` when the host has no writer.
 */
export declare function apply(ctx: unknown): void;
export declare const name: string;
