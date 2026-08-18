/**
 * Host loader entry — registers the seven `/plugins/dsh-archived-chats/*`
 * routes (state, stats, metadata, unarchive, unarchive-all, delete,
 * delete-all) and wires archive insights: per-session tags/notes joined into
 * `/state`, storage statistics from `/stats`, and guarded metadata mutation
 * through `/metadata`.
 */
export declare function apply(ctx: unknown): void;
export declare const name: string;
