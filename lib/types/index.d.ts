/**
 * Host loader entry — registers the eight `/plugins/dsh-archived-chats/*`
 * routes (state, stats, export, metadata, unarchive, unarchive-all, delete,
 * delete-all), streams JSON/Markdown backup ZIPs, and wires archive insights:
 * per-session tags/notes joined into `/state`, storage statistics from
 * `/stats`, and guarded metadata mutation through `/metadata`.
 */
export declare function apply(ctx: unknown): void;
export declare const name: string;
