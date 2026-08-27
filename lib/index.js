/**
 * dsh-archived-chats — host half.
 *
 * Registers the `/plugins/dsh-archived-chats/*` HTTP routes on the Web server:
 *
 *   GET  /plugins/dsh-archived-chats/state          → archived sessions with
 *                                                     title, createdAt, and
 *                                                     owning workspace (ids in
 *                                                     the pending-deletion
 *                                                     store are excluded).
 *   GET  /plugins/dsh-archived-chats/stats          → storage totals for
 *                                                     visible archived sessions.
 *   POST /plugins/dsh-archived-chats/preview        → paginated projected
 *                                                     conversation messages.
 *   POST /plugins/dsh-archived-chats/search         → bounded full-text
 *                                                     hits in archived chats.
 *   POST /plugins/dsh-archived-chats/export         → streamed JSON + Markdown
 *                                                     backup ZIP.
 *   POST /plugins/dsh-archived-chats/metadata       → { sessionId, tags, note }
 *   POST /plugins/dsh-archived-chats/unarchive      → { sessionId }
 *   POST /plugins/dsh-archived-chats/unarchive-all  → { sessionIds: [...] }
 *   POST /plugins/dsh-archived-chats/delete         → { sessionId }
 *   POST /plugins/dsh-archived-chats/delete-all     → { sessionIds: [...] }
 *
 *   Mutating responses carry { ok, deleted, pending, failed }: `deleted` is
 *   complete deletes (cold sessions, and live sessions this build lets us
 *   dispose in place), `pending` is live sessions accepted for deferred
 *   deletion (parked now, physically removed on the next boot — the fallback
 *   when in-place disposal is unavailable).
 *
 * The stock workspace registry only exposes `archiveSession` — unarchiving and
 * deleting live here, behind one HTTP surface the browser half can drive.
 * Unarchive goes through the registry's own state write path so the api-proxy
 * observes the `domain/changed` emission and pushes
 * `host/archived-sessions-changed` to every connected client (the sidebar
 * updates live). Delete additionally detaches the session from its workspace
 * record and removes the session-log directory from disk.
 *
 * Deleting a COLD session is immediate. A LIVE session (opened at least once
 * this boot — web agents stay resident until shutdown) cannot have its log
 * ripped out from under it: the persistence coordinator would hit ENOENT on
 * its next append. The live path therefore disposes the session first, the
 * same sequence the agent factory's own lifecycle disposer runs: cancel the
 * agent with the `disposed` cause, wait for quiescence, flush durability,
 * tear down the agent's fiber (`agent.scope.dispose()`), then detach the
 * `agents` and `sessions` store entries — the session-store detach emits
 * `session/disposed`, which the persistence coordinator answers by retiring
 * (draining and releasing) the session's write path. Once retired the session
 * is cold and the ordinary delete completes in the same request — no restart.
 *
 * The store entries and their `detach` are internal surfaces of this dsh
 * build (plain properties, not exported API), so every step is feature-
 * detected. When any piece is missing the live path falls back to the
 * original conservative behavior: the agent is left parked (cancelled,
 * flushed) and the id is recorded in a small pending-deletions store while
 * KEEPING it archived so it stays invisible. The boot sweep
 * (`recycleService.recoverStartup`, launched once when the plugin's three
 * services have all bound) migrates those ids into the recoverable recycle
 * catalog and retries only records carrying durable `purge-pending` intent.
 * The pending store also brackets the successful live path (recorded before
 * disposal, cleared after the files are gone), so a crash mid-delete is swept
 * on the next boot instead of leaving a half-deleted ghost. Unarchiving a
 * parked session drops it from the pending store, and the sweep skips ids that
 * are no longer archived, so an unarchive always wins over a parked deletion.
 *
 * Routes bind lazily (same posture as dsh-agent-teams): the web server, the
 * workspace registry, and session persistence may mount after this plugin
 * under the Loader's concurrent activation, so registration is retried on
 * every `internal/service` binding event until all three exist.
 *
 * @module dsh-archived-chats
 */
import { lstat, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createMetadataStore, MetadataStoreError } from './metadata.js';
import { createStatsService } from './stats.js';
import { createExportZip, planExport } from './export.js';
import { IMPORT_LIMITS, inspectImport, selectImportItems } from './import.js';
import { createRestoreAdapter } from './restore.js';
import { createTrashStore } from './trash.js';
import { createSnapshotStore } from './snapshot.js';
import { createRecycleService } from './recycle.js';
import { createInsightsService } from './insights.js';
import { createRetentionStore } from './retention.js';
import { createRetentionService } from './retention-service.js';
import { projectLineage } from './lineage.js';
import { createHistoryService } from './history.js';
import { createHistoryRestoreService } from './history-restore.js';
import { atomicWriteFile } from './durable.js';
import {
    createProjectedMessageCache,
    findProjectedImage,
    paginateProjectedMessages,
    searchArchivedSessions,
} from './search.js';

/** Cordis plugin name. */
export const name = 'archived-chats';

/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'];
/** Workspace registry service key candidates, newest first. */
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'];
/** Session persistence service key candidates, newest first. */
const PERSISTENCE_KEYS = ['sessionPersistence'];

const ROUTE_PREFIX = '/plugins/dsh-archived-chats';
/** Custom header required on POSTs: cheap CSRF hardening for a loopback UI. */
const GUARD_HEADER = 'x-dsh-archived-chats';

/**
 * Windows keeps a deleted directory entry alive while any handle is open (an
 * indexer or antivirus scan is enough), surfacing as EBUSY/EPERM/ENOTEMPTY.
 * Retrying is the documented remedy and is harmless on POSIX.
 */
const RM_RETRY = Object.freeze({ maxRetries: 5, retryDelay: 50 });

function readPluginVersion() {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    if (typeof manifest.version !== 'string' || manifest.version === '') {
        throw new TypeError('package version is required');
    }
    return manifest.version;
}

const PLUGIN_VERSION = readPluginVersion();

//#region wire helpers
/** Read and JSON-parse a bounded request body (empty body → {}). */
function readBody(req, maxBytes = 512 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        let settled = false;
        req.on('data', (chunk) => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > maxBytes) {
                settled = true;
                reject(Object.assign(new Error('request body is too large'), { status: 413, code: 'request-too-large' }));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (settled) return;
            settled = true;
            const text = Buffer.concat(chunks).toString('utf8').trim();
            if (text === '') { resolve({}); return; }
            try { resolve(JSON.parse(text)); }
            catch { reject(Object.assign(new Error('request body is not valid JSON'), { status: 400 })); }
        });
        req.on('error', (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        });
    });
}

function exactBody(value, keys) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === keys.length
        && keys.every((key) => Object.hasOwn(value, key));
}

const IMPORT_UPLOAD_LIMIT = IMPORT_LIMITS.maxCompressedBytes;

/** Read bounded multipart fields. Values stay in memory and are never paths. */
function readMultipartFields(req, limit, tooLargeMessage) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        let settled = false;
        const fail = (message, status = 400) => {
            if (settled) return;
            settled = true;
            reject(Object.assign(new Error(message), { status }));
        };
        const contentType = String(req.headers?.['content-type'] ?? '');
        const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
        if (!boundaryMatch) { fail('multipart boundary is required'); return; }
        const boundary = Buffer.from(`--${boundaryMatch[1] ?? boundaryMatch[2]}`);
        req.on('data', (chunk) => {
            if (settled) return;
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += value.length;
            if (bytes > limit) { fail(tooLargeMessage, 413); return; }
            chunks.push(value);
        });
        req.on('end', () => {
            if (settled) return;
            try {
                const body = Buffer.concat(chunks);
                if (!body.subarray(0, boundary.length).equals(boundary)) throw new Error('multipart body is incomplete');
                const fields = new Map();
                let cursor = 0;
                while (cursor < body.length) {
                    if (!body.subarray(cursor, cursor + boundary.length).equals(boundary)) throw new Error('multipart body is incomplete');
                    cursor += boundary.length;
                    if (body.subarray(cursor, cursor + 2).toString('ascii') === '--') break;
                    if (body.subarray(cursor, cursor + 2).toString('ascii') !== '\r\n') throw new Error('multipart body is incomplete');
                    cursor += 2;
                    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor);
                    if (headerEnd < 0) throw new Error('multipart body is incomplete');
                    const headers = body.subarray(cursor, headerEnd).toString('utf8').toLowerCase();
                    const nameMatch = headers.match(/(?:^|\r\n)content-disposition:[^\r\n]*\bname="([^"]+)"/i);
                    if (!nameMatch) throw new Error('multipart field name is missing');
                    const contentStart = headerEnd + 4;
                    const next = body.indexOf(Buffer.from(`\r\n${boundary.toString()}`), contentStart);
                    if (next < 0) throw new Error('multipart body is incomplete');
                    if (!fields.has(nameMatch[1])) fields.set(nameMatch[1], body.subarray(contentStart, next));
                    cursor = next + 2;
                }
                settled = true;
                resolve(fields);
            } catch (error) { fail(String(error?.message ?? error)); }
        });
        req.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
    });
}

/** Read one bounded multipart ZIP part using the shared multipart reader. */
function readImportUpload(req) {
    return readMultipartFields(req, IMPORT_UPLOAD_LIMIT, 'import upload is too large').then((fields) => {
        const bytes = fields.get('file');
        if (bytes === undefined) throw Object.assign(new Error('ZIP file field is missing'), { status: 400 });
        return new Uint8Array(bytes);
    });
}

export function createImportTokenStore({
    now = () => Date.now(),
    ttlMs = 10 * 60 * 1000,
    maxEntries = 8,
    maxBytes = 128 * 1024 * 1024,
} = {}) {
    const tokens = new Map();
    function cleanup() {
        const time = now();
        for (const [token, value] of tokens) if (value.expiresAt <= time) tokens.delete(token);
    }
    return {
        create(plan) {
            cleanup();
            const planBytes = Number.isSafeInteger(plan?.totalBytes) && plan.totalBytes >= 0 ? plan.totalBytes : 0;
            const retainedBytes = [...tokens.values()].reduce((total, entry) => total + entry.bytes, 0);
            if (tokens.size >= maxEntries || retainedBytes + planBytes > maxBytes) {
                throw Object.assign(new Error('import confirmation capacity is full'), { status: 503, code: 'import-token-capacity' });
            }
            const token = randomUUID();
            const nonce = randomUUID();
            const expiresAt = now() + ttlMs;
            tokens.set(token, { plan, nonce, expiresAt, bytes: planBytes });
            return { token, nonce, expiresAt };
        },
        consume(token, nonce) {
            cleanup();
            const value = tokens.get(token);
            if (value === undefined || value.nonce !== nonce) throw Object.assign(new Error('import token is invalid or expired'), { status: 409, code: 'import-token-invalid' });
            tokens.delete(token);
            return value.plan;
        },
        remove(token) { tokens.delete(token); },
        cleanup,
    };
}

const EXPORT_BODY_LIMIT = 512 * 1024;
const EXPORT_SESSION_LIMIT = 2000;

/** Parse a bounded native-form export selection and preserve first-seen order. */
function readExportSelection(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        let settled = false;
        const fail = (message, status = 400) => {
            if (settled) return;
            settled = true;
            reject(Object.assign(new Error(message), { status }));
        };
        req.on('data', (chunk) => {
            if (settled) return;
            const bytesChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += bytesChunk.length;
            if (bytes > EXPORT_BODY_LIMIT) {
                fail('export request body is too large', 413);
                return;
            }
            chunks.push(bytesChunk);
        });
        req.on('end', () => {
            if (settled) return;
            try {
                const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
                const encoded = params.get('sessionIds');
                if (encoded === null) throw new Error('sessionIds is required');
                const submitted = JSON.parse(encoded);
                if (!Array.isArray(submitted) || submitted.length === 0) {
                    throw new Error('sessionIds must be a non-empty array');
                }
                if (submitted.some((id) => typeof id !== 'string' || id === '')) {
                    throw new Error('sessionIds must contain non-empty strings');
                }
                const ids = [...new Set(submitted)];
                if (ids.length > EXPORT_SESSION_LIMIT) {
                    throw new Error(`sessionIds cannot contain more than ${EXPORT_SESSION_LIMIT} unique ids`);
                }
                settled = true;
                resolve(ids);
            } catch (error) {
                fail(String(error?.message ?? error));
            }
        });
        req.on('error', (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        });
    });
}

/** Send one JSON response. */
function send(res, status, value) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify(value));
}

function sendImage(res, stored) {
    const bytes = Buffer.from(stored.data);
    res.writeHead(200, {
        'content-type': stored.ref.mediaType,
        'content-length': String(bytes.length),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    res.end(bytes);
}

function requestAbort(req) {
    const controller = new AbortController();
    const abort = () => controller.abort(Object.assign(new Error('request aborted'), { code: 'request-aborted' }));
    req.once('aborted', abort);
    return {
        signal: controller.signal,
        dispose: () => req.off('aborted', abort),
    };
}

function sendText(res, status, text) {
    res.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    res.end(text);
}

function contentDisposition(filename) {
    const ascii = filename
        .replace(/[^\x20-\x7e]/g, '_')
        .replace(/["\\]/g, '_');
    const encoded = encodeURIComponent(filename)
        .replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Guard mutating routes behind a custom header (cross-site forms cannot set one). */
function guard(req, res) {
    if (req.method !== 'POST') {
        send(res, 405, { error: 'method-not-allowed' });
        return false;
    }
    if (req.headers[GUARD_HEADER] !== '1') {
        send(res, 403, { error: 'forbidden' });
        return false;
    }
    return true;
}
//#endregion

//#region pending-deletions store
/**
 * Ids of sessions whose deletion was requested while they were live. They are
 * parked (never to run again) and stay archived — invisible everywhere — until
 * the next boot sweeps them through the ordinary cold delete path. The store
 * is one small JSON document; writes are whole-file and best-effort.
 */
function pendingFilePath() {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    return join(home, 'plugin-data', 'archived-chats', 'pending-deletions.json');
}

function createPendingStore() {
    let queue = Promise.resolve();
    const safeId = (value) => {
        const id = String(value);
        if (id === '' || ['__proto__', 'constructor', 'prototype'].includes(id)) {
            throw Object.assign(new Error('pending deletion session id is invalid'), { code: 'pending-session-id-invalid' });
        }
        return id;
    };
    async function load() {
        try {
            const parsed = JSON.parse(await readFile(pendingFilePath(), 'utf8'));
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
                || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.ids)
                || parsed.ids.some((id) => typeof id !== 'string' || id === '' || ['__proto__', 'constructor', 'prototype'].includes(id))) {
                throw Object.assign(new Error('pending deletion store is invalid'), { code: 'pending-store-unavailable' });
            }
            return new Set(parsed.ids);
        } catch (error) {
            if (error?.code === 'ENOENT') return new Set();
            if (error?.code === 'pending-store-unavailable') throw error;
            throw Object.assign(new Error('pending deletion store is unavailable'), { code: 'pending-store-unavailable', cause: error });
        }
    }
    async function save(pending) {
        const path = pendingFilePath();
        await atomicWriteFile(path, `${JSON.stringify({ ids: [...pending] }, null, 2)}\n`, { encoding: 'utf8' });
    }
    function mutate(operation) {
        const result = queue.then(async () => {
            const pending = await load();
            const changed = await operation(pending);
            if (changed) await save(pending);
            return pending;
        });
        queue = result.catch(() => undefined);
        return result;
    }
    return {
        load,
        add: (id) => mutate((pending) => {
            const before = pending.size;
            pending.add(safeId(id));
            return pending.size !== before;
        }),
        remove: (ids) => mutate((pending) => {
            let changed = false;
            for (const id of ids) if (pending.delete(safeId(id))) changed = true;
            return changed;
        }),
    };
}

/** Serialize archive lifecycle commits (physical delete vs. unarchive). */
function createLifecycleQueue() {
    let queue = Promise.resolve();
    return {
        run(operation) {
            const result = queue.then(operation);
            queue = result.catch(() => undefined);
            return result;
        },
    };
}
//#endregion

//#region domain helpers
/** The last `session/title` event wins (renames append later events). */
function extractTitle(events) {
    let title;
    for (const event of events) {
        if (event?.type === 'session/title'
            && typeof event.data?.title === 'string'
            && event.data.title.trim() !== '') {
            title = event.data.title;
        }
    }
    return title;
}

function workspaceSessionIds(workspace) {
    if (Array.isArray(workspace?.sessionIds)) return workspace.sessionIds.map(String);
    if (workspace?.sessionIds instanceof Set) return [...workspace.sessionIds].map(String);
    return [];
}

const LINEAGE_CONTEXT_TITLE_LIMIT = 100;

async function resolveLineageContextTitles(graph, persistence) {
    const pending = [...(Array.isArray(graph?.roots) ? graph.roots : [])];
    const targets = [];
    while (pending.length > 0) {
        const node = pending.pop();
        const titleMissing = node?.title === null || (typeof node?.title === 'string' && node.title.trim() === '');
        if (node?.status === 'active' && titleMissing && targets.length < LINEAGE_CONTEXT_TITLE_LIMIT) {
            targets.push(node);
        }
        for (const child of Array.isArray(node?.children) ? node.children : []) pending.push(child);
    }
    for (const node of targets) {
        try {
            const title = extractTitle((await persistence.inspect(node.id))?.events ?? []);
            if (title !== undefined) node.title = title;
        } catch {
            // Unreadable context remains a safe untitled source node.
        }
    }
    return graph;
}

/**
 * Build the archived-session listing: one row per archived id with the
 * resolved title, creation time, and owning workspace (accounting slot first,
 * canonical cwd second, ungrouped last). Resolved titles are memoized in
 * `titleCache` (id → title) so refreshes stop re-reading every archived log:
 * only non-null titles are cached — a title-less session stays cheap to
 * re-inspect and picks up a late `session/title` event on the next refresh.
 * Delete and unarchive invalidate their ids.
 */
async function listArchived(ctx, registry, persistence, titleCache, metadataStore, pendingStore, trashStore) {
    const archivedIds = registry.archivedSessionIds.map(String);
    if (archivedIds.length === 0) {
        const metadata = await metadataStore.getMany([]);
        const trash = await trashStore.load();
        return { metadataStatus: metadata.status, trashStatus: trash.status, sessions: [] };
    }
    const headerById = new Map();
    try {
        for (const header of await persistence.list()) headerById.set(String(header.id), header);
    } catch (error) {
        ctx.logger.warn(`archived-chats: session header listing failed: ${String(error)}`);
    }
    const live = ctx.get('sessions');
    const workspaces = registry.list();
    const rows = [];
    for (const id of archivedIds) {
        const header = headerById.get(id) ?? live?.get(id)?.header;
        let title = titleCache?.get(id);
        if (title === undefined) {
            try {
                const inspection = await persistence.inspect(id);
                title = extractTitle(inspection.events);
                if (title !== undefined) titleCache?.set(id, title);
            } catch {
                // A torn/unreadable log still lists — the row is manageable without a title.
            }
        }
        const workspace = workspaces.find((item) => workspaceSessionIds(item).includes(id));
        rows.push({
            id,
            title: title ?? null,
            createdAt: header?.createdAt ?? null,
            origin: header?.origin ?? null,
            workspaceId: workspace === undefined ? null : String(workspace.id),
            workspaceTitle: workspace?.title ?? null,
            workspacePath: workspace?.path ?? null,
        });
    }
    // Parked-for-deletion sessions stay archived (invisible everywhere) but are
    // excluded from the listing: they have been accepted for deletion and only
    // await the next-boot sweep, so they must not reappear on refresh.
    const pendingIds = await pendingStore.load();
    const trash = await trashStore.load();
    const trashIds = trash.status === 'ready' ? new Set(trash.records.keys()) : new Set();
    const visibleRows = rows.filter((row) => !pendingIds.has(row.id) && !trashIds.has(row.id));
    const metadata = await metadataStore.getMany(visibleRows.map((row) => row.id));
    return {
        metadataStatus: metadata.status,
        trashStatus: trash.status,
        sessions: visibleRows.map((row) => {
            const entry = metadata.entries[row.id];
            return {
                ...row,
                tags: entry?.tags ?? [],
                note: entry?.note ?? '',
                metadataUpdatedAt: entry?.updatedAt ?? null,
            };
        }),
    };
}

/**
 * Read one trash record, failing CLOSED when the store is unreadable. A
 * corrupt trash document must never let a mutation treat a recycled session as
 * an ordinary archived one — the recycle record would survive the change and a
 * later purge would delete a chat the user had put back into service.
 */
async function requireTrashRecord(trashStore, id) {
    const trash = await trashStore.load();
    if (trash.status !== 'ready') {
        throw Object.assign(new Error('trash store is unavailable'), { code: 'trash-store-unavailable', status: 503 });
    }
    return trash.records.get(String(id)) ?? null;
}

async function isVisibleArchivedSession(registry, pendingStore, trashStore, id, scope = 'archive') {
    const key = String(id);
    if (!registry.archivedSessionIds.map(String).includes(key)) return false;
    if ((await pendingStore.load()).has(key)) return false;
    const record = await trashStore.get(key);
    return scope === 'trash' ? record !== null : record === null;
}

function trashSessionRow(record) {
    return {
        id: record.sessionId,
        title: record.title,
        createdAt: record.createdAt,
        origin: record.origin,
        workspaceId: record.workspace?.id ?? null,
        workspaceTitle: record.workspace?.title ?? null,
        workspacePath: record.workspace?.path ?? null,
        tags: record.tags,
        note: record.note,
        metadataUpdatedAt: record.metadataUpdatedAt,
        trashedAt: record.trashedAt,
        snapshotBytes: record.snapshotBytes,
        snapshotAttachmentCount: record.snapshotAttachmentCount,
        trashState: record.state,
        liveDisposition: record.liveDisposition,
    };
}

/**
 * Remove ids from the registry-global archive set through the registry's own
 * write path (`setState` is the same funnel `archiveSession` uses, so the
 * domain change event — and every subscribed client — observes it).
 */
async function unarchiveIds(registry, ids) {
    const state = registry.state;
    if (state === undefined) throw new Error('workspace registry is not started yet');
    const drop = new Set(ids.map(String));
    const current = state.archivedSessionIds.map(String);
    const next = current.filter((id) => !drop.has(id));
    if (next.length === current.length) return current;
    if (typeof registry.setState !== 'function') {
        throw new Error('this dsh build exposes no workspace-registry state writer; unarchive is unsupported');
    }
    await registry.setState({ ...state, archivedSessionIds: next });
    return next;
}

/**
 * Dispose a live session in place so its deletion can complete without a
 * restart. Mirrors the agent factory's own lifecycle disposer: cancel the
 * agent with the `disposed` cause (parked input never wakes the driver
 * again), wait for quiescence so in-flight closing events land, flush
 * durability, tear down the agent's fiber, then detach the `agents` and
 * `sessions` store entries. The session-store detach emits `session/disposed`
 * — the persistence coordinator answers by retiring (draining and releasing)
 * the session's write path, after which the log directory is free to remove.
 *
 * The store maps and their entries' `detach` are internal surfaces of this
 * dsh build, so every step is feature-detected. Returns true when the session
 * ends up fully detached (cold); false when disposal is unavailable or did
 * not converge — the session is then left in the parked state (cancelled and
 * flushed) and the caller falls back to the deferred next-boot deletion.
 */
async function disposeLiveSession(ctx, id) {
    const sessions = ctx.get('sessions');
    const agents = ctx.get('agents');
    const session = sessions?.get(id);
    if (session === undefined) return true;
    // Park first — this is also the complete fallback outcome: the loop can
    // never run again and the log's buffered tail is durable.
    const agent = agents?.get(id);
    if (agent !== undefined) {
        try {
            agent.cancel({ kind: 'disposed' });
            await Promise.race([
                agent.whenIdle(),
                new Promise((resolve) => setTimeout(resolve, 20000)),
            ]);
        } catch (error) {
            ctx.logger.warn(`archived-chats: parking ${id} did not fully converge: ${String(error)}`);
        }
    }
    if (typeof sessions.flush === 'function') {
        try { await sessions.flush(session); }
        catch (error) { ctx.logger.warn(`archived-chats: flush before disposing ${id} failed: ${String(error)}`); }
    }
    // Feature-detect the internal store entries before touching anything else:
    // without BOTH detach capabilities the session must stay parked. The
    // session-store entry carries its own `detach`; the agent-registry entry
    // does not (its detach closure lives with the creator), so the agent side
    // goes through the registry's `detachEntered(entry)` — the same method
    // that closure calls.
    const sessionEntry = sessions.store instanceof Map ? sessions.store.get(id) : undefined;
    const agentEntry = agents?.store instanceof Map ? agents.store.get(id) : undefined;
    if (typeof sessionEntry?.detach !== 'function') return false;
    if (agent !== undefined && (agentEntry === undefined
        || typeof agents.detachEntered !== 'function'
        || agentEntry.announcing === true)) return false;
    // Factory disposer order: agent fiber first, then unregister the agent,
    // then detach the session (emitting `session/disposed`).
    try { await agent?.scope?.dispose?.(); }
    catch (error) { ctx.logger.warn(`archived-chats: agent fiber teardown for ${id} failed: ${String(error)}`); }
    try { if (agentEntry !== undefined) agents.detachEntered(agentEntry); }
    catch (error) { ctx.logger.warn(`archived-chats: agent detach for ${id} failed: ${String(error)}`); }
    try { sessionEntry.detach(); }
    catch (error) {
        ctx.logger.warn(`archived-chats: session detach for ${id} failed: ${String(error)}`);
        return false;
    }
    // Detach can defer while a creation announce or append is unwinding — if
    // the session is still in the store, treat it as parked, not disposed.
    if (sessions.get(id) !== undefined) return false;
    // The retirement triggered by `session/disposed` drains asynchronously.
    // The pre-detach flush left nothing buffered, so a short settle keeps the
    // log-directory removal below clear of the drain's final serialize.
    await new Promise((resolve) => setTimeout(resolve, 250));
    return true;
}

/**
 * Delete one archived session. A COLD session is removed end to end right
 * away: unarchive, detach from the owning workspace record, remove the
 * session-log directory from disk, and purge the registry's stale header
 * index. A LIVE session is first disposed in place (see
 * {@link disposeLiveSession}) and then follows the same cold path in this
 * request; when in-place disposal is unavailable on this build it stays
 * parked and is reported as `pending` for the next-boot sweep. Either way the
 * id sits in the pending-deletions store from before disposal until the files
 * are gone, so a crash mid-delete is completed by the sweep instead of
 * leaving a half-deleted ghost.
 */
async function deleteSession(ctx, registry, persistence, id, titleCache, statsService, metadataStore, pendingStore, lifecycle, requirePending = false, lockHeld = false, livePrepared = false) {
    if (!lockHeld && !livePrepared && ctx.get('sessions')?.get(id) !== undefined) {
        // Keep unarchive behind the entire live disposal sequence. Otherwise an
        // unarchive can return while the session is still active, then disposal
        // detaches it and the user's successful unarchive is silently lost.
        return lifecycle.run(async () => {
            if (!registry.archivedSessionIds.map(String).includes(String(id))) return 'cancelled';
            await pendingStore.add(id);
            const disposed = await disposeLiveSession(ctx, id);
            if (!disposed) {
                const archived = registry.archivedSessionIds.map(String).includes(String(id));
                const pending = await pendingStore.load();
                return archived && pending.has(String(id)) ? 'pending' : 'cancelled';
            }
            return deleteSession(ctx, registry, persistence, id, titleCache, statsService, metadataStore, pendingStore, lifecycle, true, true, true);
        });
    }
    let header = registry.headers instanceof Map ? registry.headers.get(id) : undefined;
    let listed = false;
    try {
        header = (await persistence.list()).find((h) => String(h.id) === String(id)) ?? header;
        listed = true;
    } catch (error) {
        ctx.logger.warn(`archived-chats: header re-list failed for ${id}: ${String(error)}`);
    }
    const commit = async () => {
        const archived = registry.archivedSessionIds.map(String).includes(String(id));
        let pending = null;
        if (requirePending || livePrepared) {
            pending = await pendingStore.load();
            if (!pending.has(String(id))) return 'cancelled';
        }
        if (!archived && pending === null) return 'cancelled';
        if (header === undefined) {
            // A durable pending id that is already absent from both persistence
            // and the archive is a retry of a partially completed deletion.
            if (archived || !listed || pending === null) {
                throw Object.assign(new Error('session location unavailable'), { code: 'session-location-unavailable' });
            }
        } else {
            const location = await persistence.locate(header);
            if (typeof location?.path !== 'string') throw Object.assign(new Error('session location unavailable'), { code: 'session-location-unavailable' });
            const sessionDirectory = dirname(location.path);
            // The only recursive delete in this plugin. Confirm the directory is
            // the session's own before removing it, the same invariant the two
            // restore paths apply: on a host layout that keeps logs as flat
            // files this would otherwise remove the whole session root.
            if (basename(sessionDirectory) !== String(id)) {
                throw Object.assign(new Error('session location is not session-scoped'), { code: 'session-location-unsafe' });
            }
            await rm(sessionDirectory, { recursive: true, force: true, ...RM_RETRY });
            try {
                await lstat(sessionDirectory);
                throw Object.assign(new Error('session directory still exists'), { code: 'session-delete-unconfirmed' });
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
        }
        if (archived) await unarchiveIds(registry, [id]);
        for (const workspace of registry.list()) {
            if (workspaceSessionIds(workspace).includes(String(id))) {
                await workspace.detachSession(id);
            }
        }
        await metadataStore.remove([id]);
        await pendingStore.remove([id]);
        // Purge the registry's in-memory header index (built once at startup from
        // persistence). Without this the stale header keeps the deleted session
        // "known" to the registry for the rest of this boot — it could be
        // re-archived as a ghost or re-accounted on the next workspace mutation.
        for (const key of ['headers', 'sessionPaths', 'invalidSessionPaths']) {
            const map = registry[key];
            if (map instanceof Map) map.delete(id);
        }
        titleCache?.delete(id);
        statsService.invalidate([id]);
        return 'deleted';
    };
    return lockHeld ? commit() : lifecycle.run(commit);
}

//#endregion

//#region routes
function registerRoutes(ctx, webServer, registry, persistence, titleCache, metadataStore, statsService, pendingStore, trashStore, snapshotStore, retentionStore, lifecycle, importTokens, restoreAdapter) {
    const projectedMessages = createProjectedMessageCache((id) => persistence.inspect(id));
    const listInsightSessions = async () => {
        const pending = await pendingStore.load();
        const trash = await trashStore.load();
        if (trash.status !== 'ready') throw Object.assign(new Error('trash store is unavailable'), { code: 'insights-authority-unavailable', status: 503 });
        let headers = [];
        try { headers = await persistence.list(); } catch { /* Rows remain measurable as unavailable. */ }
        const headerById = new Map((Array.isArray(headers) ? headers : []).map((header) => [String(header.id), header]));
        const workspaces = registry.list();
        return registry.archivedSessionIds.map(String).filter((id) => !pending.has(id)).map((id) => {
            const record = trash.records.get(id);
            const header = headerById.get(id) ?? ctx.get('sessions')?.get(id)?.header;
            const workspace = record?.workspace ?? workspaces.find((item) => workspaceSessionIds(item).includes(id));
            return {
                id,
                title: record?.title ?? titleCache.get(id) ?? (typeof header?.title === 'string' ? header.title : null),
                workspaceId: workspace?.id === undefined || workspace?.id === null ? null : String(workspace.id),
                workspaceTitle: typeof workspace?.title === 'string' ? workspace.title : null,
                scope: record === undefined ? 'archive' : 'trash',
            };
        });
    };
    const insightsService = createInsightsService({
        statsService,
        trashStore,
        snapshotStore,
        listSessions: listInsightSessions,
    });
    const historyService = createHistoryService({
        registry,
        persistence,
        sessions: ctx.get('sessions'),
        metadataStore,
        trashStore,
        snapshotStore,
        lifecycle,
    });
    const invalidateRecycleCaches = (ids) => {
        for (const id of ids) titleCache.delete(id);
        statsService.invalidate(ids);
        projectedMessages.invalidate(ids);
        insightsService.invalidate();
        historyService.invalidate();
    };
    const recycleService = createRecycleService({
        registry,
        persistence,
        attachments: ctx.get('attachments'),
        metadataStore,
        trashStore,
        snapshotStore,
        lifecycle,
        disposeLive: async (id) => {
            if (ctx.get('sessions')?.get(id) === undefined) return { disposition: 'cold' };
            return { disposition: await disposeLiveSession(ctx, id) ? 'disposed' : 'parked' };
        },
        purgePhysical: async (id) => {
            await pendingStore.add(id);
            if (ctx.get('sessions')?.get(id) !== undefined && !(await disposeLiveSession(ctx, id))) {
                throw Object.assign(new Error('live session remains parked'), { code: 'session-live-purge-pending' });
            }
            const outcome = await deleteSession(ctx, registry, persistence, id, titleCache, statsService, metadataStore, pendingStore, lifecycle, false, true, false);
            if (outcome === 'deleted') return;
            // `cancelled` only means the delete found nothing left to do. When the
            // session is genuinely gone from both persistence and the archive,
            // this is a retry of a purge whose files were already removed and it
            // must complete — otherwise the record strands in purge-pending with
            // no session left to restore.
            const archived = registry.archivedSessionIds.map(String).includes(String(id));
            let present = true;
            try { present = (await persistence.list()).some((header) => String(header.id) === String(id)); }
            catch { present = true; }
            if (archived || present) throw Object.assign(new Error('physical purge was cancelled'), { code: 'purge-cancelled' });
            await pendingStore.remove([id]);
        },
        invalidate: invalidateRecycleCaches,
        logger: ctx.logger,
    });
    const retentionService = createRetentionService({
        insightsService,
        retentionStore,
        trashStore,
        snapshotStore,
        recycleService,
        lifecycle,
    });
    const historyRestoreService = createHistoryRestoreService({
        snapshotStore,
        persistence,
        attachments: ctx.get('attachments'),
        registry,
        metadataStore,
        lifecycle,
        invalidate: (restoredId, sourceId) => {
            titleCache.delete(restoredId);
            statsService.invalidate([restoredId]);
            projectedMessages.invalidate([restoredId, sourceId]);
            insightsService.invalidate();
            historyService.invalidate();
        },
        logger: ctx.logger,
    });

    const historyError = (res, error, fallback) => {
        const status = error?.status ?? (error instanceof SyntaxError || error instanceof TypeError ? 400 : 500);
        send(res, status, { ok: false, error: error?.code ?? fallback });
    };

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/history/capture`,
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            try {
                const body = await readBody(req, 64 * 1024);
                if (!exactBody(body, ['sessionId']) || typeof body.sessionId !== 'string' || body.sessionId === '') {
                    send(res, 400, { ok: false, error: 'history-capture-invalid' });
                    return;
                }
                const result = await historyService.captureArchived(body.sessionId);
                insightsService.invalidate();
                send(res, 200, { ok: true, ...result });
            } catch (error) {
                ctx.logger.warn(`archived-chats: history capture failed: ${String(error?.code ?? error?.name ?? 'history-capture-failed')}`);
                historyError(res, error, 'history-capture-failed');
            }
        },
    }), 'archived-chats: history capture route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/history`,
        handler: async (req, res) => {
            if (req.method !== 'GET') { send(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
            try { send(res, 200, { ok: true, ...(await historyService.list()) }); }
            catch (error) { historyError(res, error, 'history-list-failed'); }
        },
    }), 'archived-chats: history route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/history/delete`,
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            try {
                const body = await readBody(req, 64 * 1024);
                if (!exactBody(body, ['snapshotId']) || typeof body.snapshotId !== 'string' || body.snapshotId === '') {
                    send(res, 400, { ok: false, error: 'history-delete-invalid' });
                    return;
                }
                const result = await historyService.deleteVersion(body.snapshotId);
                insightsService.invalidate();
                send(res, 200, { ok: true, ...result });
            } catch (error) { historyError(res, error, 'history-delete-failed'); }
        },
    }), 'archived-chats: history delete route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/history/delete-all`,
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            try {
                const body = await readBody(req, 64 * 1024);
                if (!exactBody(body, [])) {
                    send(res, 400, { ok: false, error: 'history-delete-all-invalid' });
                    return;
                }
                const result = await historyService.clear();
                if (result.deleted.length > 0) insightsService.invalidate();
                const status = result.failed.length > 0 && result.deleted.length === 0 ? 409 : 200;
                send(res, status, { ok: result.failed.length === 0, ...result });
            } catch (error) { historyError(res, error, 'history-delete-all-failed'); }
        },
    }), 'archived-chats: history delete all route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/history/preview`,
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            try {
                const body = await readBody(req, 64 * 1024);
                if (!exactBody(body, ['snapshotId', 'offset', 'limit']) || typeof body.snapshotId !== 'string') {
                    send(res, 400, { ok: false, error: 'history-preview-invalid' });
                    return;
                }
                send(res, 200, { ok: true, ...(await historyService.preview(body.snapshotId, { offset: body.offset, limit: body.limit })) });
            } catch (error) { historyError(res, error, 'history-preview-failed'); }
        },
    }), 'archived-chats: history preview route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/history/preview/image`,
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            const request = requestAbort(req);
            try {
                const body = await readBody(req, 64 * 1024);
                if (!exactBody(body, ['snapshotId', 'attachment']) || typeof body.snapshotId !== 'string'
                    || body.attachment === null || typeof body.attachment !== 'object' || Array.isArray(body.attachment)) {
                    send(res, 400, { ok: false, error: 'history-preview-image-invalid' });
                    return;
                }
                const image = await historyService.readImage(body.snapshotId, body.attachment, request.signal);
                sendImage(res, { data: image.data, ref: { mediaType: image.mediaType } });
            } catch (error) {
                if (!request.signal.aborted) historyError(res, error, 'history-preview-image-failed');
            } finally { request.dispose(); }
        },
    }), 'archived-chats: history preview image route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/history/restore/preview`,
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            try {
                const body = await readBody(req, 64 * 1024);
                if (!exactBody(body, ['snapshotId']) || typeof body.snapshotId !== 'string' || body.snapshotId === '') {
                    send(res, 400, { ok: false, error: 'history-restore-preview-invalid' });
                    return;
                }
                send(res, 200, { ok: true, ...(await historyRestoreService.prepare(body.snapshotId)) });
            } catch (error) { historyError(res, error, 'history-restore-preview-failed'); }
        },
    }), 'archived-chats: history restore preview route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/history/restore`,
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            try {
                const body = await readBody(req, 64 * 1024);
                if (!exactBody(body, ['token', 'nonce']) || typeof body.token !== 'string' || typeof body.nonce !== 'string') {
                    send(res, 400, { ok: false, error: 'history-restore-confirmation-invalid' });
                    return;
                }
                send(res, 200, { ok: true, ...(await historyRestoreService.restore(body.token, body.nonce)) });
            } catch (error) { historyError(res, error, 'history-restore-failed'); }
        },
    }), 'archived-chats: history restore route');
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/state`,
        handler: async (req, res) => {
            try {
                send(res, 200, await listArchived(ctx, registry, persistence, titleCache, metadataStore, pendingStore, trashStore));
            } catch (error) {
                ctx.logger.warn(`archived-chats: state failed: ${String(error)}`);
                send(res, 500, { error: 'state-failed', message: String(error?.message ?? error) });
            }
        },
    }), 'archived-chats: state route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/stats`,
        handler: async (_req, res) => {
            try {
                const pending = await pendingStore.load();
                const trash = await trashStore.load();
                const trashed = trash.status === 'ready' ? new Set(trash.records.keys()) : new Set();
                const visibleIds = registry.archivedSessionIds
                    .map(String)
                    .filter((id) => !pending.has(id) && !trashed.has(id));
                send(res, 200, await statsService.measure(visibleIds));
            } catch (error) {
                ctx.logger.warn(`archived-chats: stats failed: ${String(error)}`);
                send(res, 500, { error: 'stats-failed' });
            }
        },
    }), 'archived-chats: stats route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/insights`,
        handler: async (req, res) => {
            if (req.method !== 'GET') { send(res, 405, { error: 'method-not-allowed' }); return; }
            try {
                const state = await retentionService.get();
                send(res, 200, { ...state.insights, policy: state.policy, candidateSummary: state.candidateSummary });
            }
            catch (error) { send(res, error.status ?? 500, { error: error.code ?? 'insights-failed' }); }
        },
    }), 'archived-chats: insights route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/retention/policy`,
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            try {
                const policy = await retentionService.savePolicy(await readBody(req, 64 * 1024));
                send(res, 200, { ok: true, policy });
            } catch (error) {
                send(res, error.status ?? 500, { ok: false, error: error.code ?? 'retention-policy-failed' });
            }
        },
    }), 'archived-chats: retention policy route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/retention/preview`,
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            try {
                await readBody(req, 64 * 1024);
                send(res, 200, { ok: true, ...(await retentionService.preview()) });
            } catch (error) {
                send(res, error.status ?? 500, { ok: false, error: error.code ?? 'retention-preview-failed' });
            }
        },
    }), 'archived-chats: retention preview route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/retention/apply`,
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            try {
                const result = await retentionService.apply(await readBody(req, 64 * 1024));
                send(res, result.failed.length > 0 && result.applied.length === 0 ? 409 : 200, {
                    ok: result.failed.length === 0,
                    ...result,
                });
            } catch (error) {
                send(res, error.status ?? 500, { ok: false, error: error.code ?? 'retention-apply-failed' });
            }
        },
    }), 'archived-chats: retention apply route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/lineage`,
        handler: async (req, res) => {
            if (req.method !== 'GET') { send(res, 405, { error: 'method-not-allowed' }); return; }
            try {
                const trash = await trashStore.load();
                if (trash.status !== 'ready') throw Object.assign(new Error('trash store is unavailable'), { code: 'trash-store-unavailable', status: 503 });
                const headers = await persistence.list();
                const titles = new Map(titleCache);
                for (const header of Array.isArray(headers) ? headers : []) {
                    if (!titles.has(String(header.id)) && typeof header.title === 'string') titles.set(String(header.id), header.title);
                }
                for (const record of trash.records.values()) {
                    if (typeof record.title === 'string') titles.set(record.sessionId, record.title);
                }
                const graph = projectLineage({
                    headers: Array.isArray(headers) ? headers : [],
                    archivedIds: registry.archivedSessionIds.map(String),
                    trashRecords: trash.records,
                    workspaces: registry.list(),
                    titles,
                    focusIds: [...new Set([
                        ...registry.archivedSessionIds.map(String),
                        ...trash.records.keys(),
                    ])],
                });
                send(res, 200, await resolveLineageContextTitles(graph, persistence));
            } catch (error) {
                send(res, error.status ?? 500, { error: error.code ?? 'lineage-failed' });
            }
        },
    }), 'archived-chats: lineage route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/preview`,
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            try {
                const body = await readBody(req, 64 * 1024);
                if (typeof body.sessionId !== 'string' || body.sessionId === '') {
                    send(res, 400, { error: 'sessionId-required' });
                    return;
                }
                const scope = body.scope ?? 'archive';
                if (!['archive', 'trash'].includes(scope)) { send(res, 400, { error: 'preview-scope-invalid' }); return; }
                const state = scope === 'archive' ? await listArchived(ctx, registry, persistence, titleCache, metadataStore, pendingStore, trashStore) : null;
                const trashRecord = scope === 'trash' ? await trashStore.get(body.sessionId) : null;
                const session = scope === 'trash' ? (trashRecord === null ? undefined : trashSessionRow(trashRecord)) : state.sessions.find((row) => row.id === body.sessionId);
                if (session === undefined) {
                    send(res, 404, { error: 'session-not-archived' });
                    return;
                }
                const messages = await projectedMessages.get(body.sessionId);
                if (!(await isVisibleArchivedSession(registry, pendingStore, trashStore, body.sessionId, scope))) {
                    send(res, 404, { error: 'session-not-archived' });
                    return;
                }
                const page = paginateProjectedMessages(messages, {
                    offset: body.offset,
                    limit: body.limit,
                });
                send(res, 200, { ok: true, session, ...page });
            } catch (error) {
                const status = error.status ?? 500;
                send(res, status, {
                    error: error.code ?? (status === 400 ? 'preview-invalid' : 'preview-failed'),
                    message: String(error?.message ?? error),
                });
            }
        },
    }), 'archived-chats: preview route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/preview/image`,
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            const request = requestAbort(req);
            try {
                const body = await readBody(req, 64 * 1024);
                if (typeof body.sessionId !== 'string' || body.sessionId === ''
                    || typeof body.attachmentId !== 'string' || body.attachmentId === '') {
                    send(res, 400, { error: 'preview-image-invalid' });
                    return;
                }
                const scope = body.scope ?? 'archive';
                if (!['archive', 'trash'].includes(scope)) { send(res, 400, { error: 'preview-scope-invalid' }); return; }
                if (!(await isVisibleArchivedSession(registry, pendingStore, trashStore, body.sessionId, scope))) {
                    send(res, 404, { error: 'session-not-archived' });
                    return;
                }
                const ref = findProjectedImage(await projectedMessages.get(body.sessionId), body.attachmentId);
                if (ref === null) {
                    send(res, 404, { error: 'preview-image-not-found' });
                    return;
                }
                const attachments = ctx.get('attachments');
                if (typeof attachments?.readImage !== 'function') {
                    send(res, 503, { error: 'preview-image-unsupported' });
                    return;
                }
                try {
                    const image = await attachments.readImage(ref, request.signal);
                    if (!(await isVisibleArchivedSession(registry, pendingStore, trashStore, body.sessionId, scope))) {
                        send(res, 404, { error: 'session-not-archived' });
                        return;
                    }
                    sendImage(res, image);
                } catch (error) {
                    if (request.signal.aborted) return;
                    ctx.logger.warn(`archived-chats: preview image read failed for ${body.sessionId}: ${String(error?.code ?? error?.name ?? 'read-failed')}`);
                    send(res, 500, { error: 'preview-image-failed' });
                }
            } catch (error) {
                if (request.signal.aborted) return;
                const status = error?.status ?? 500;
                send(res, status, { error: status === 413 ? 'request-too-large' : status === 400 ? 'preview-image-invalid' : 'preview-image-failed' });
            } finally {
                request.dispose();
            }
        },
    }), 'archived-chats: preview image route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/search`,
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            const request = requestAbort(req);
            try {
                const body = await readBody(req, 64 * 1024);
                const state = await listArchived(ctx, registry, persistence, titleCache, metadataStore, pendingStore, trashStore);
                const result = await searchArchivedSessions({
                    ids: state.sessions.map((row) => row.id),
                    loadMessages: (id) => projectedMessages.get(id),
                    query: body.query,
                    limit: body.limit,
                    signal: request.signal,
                });
                if (request.signal.aborted) return;
                const rows = new Map(state.sessions.map((row) => [row.id, row]));
                send(res, 200, {
                    ok: true,
                    query: body.query.trim(),
                    hits: result.hits.map((hit) => ({ ...hit, session: rows.get(hit.sessionId) })),
                    skipped: result.skipped,
                });
            } catch (error) {
                if (request.signal.aborted) return;
                const status = error.status ?? 500;
                send(res, status, {
                    error: error.code ?? (status === 400 ? 'search-invalid' : 'search-failed'),
                    message: String(error?.message ?? error),
                });
            } finally { request.dispose(); }
        },
    }), 'archived-chats: search route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/export`,
        handler: async (req, res) => {
            if (req.method !== 'POST') {
                sendText(res, 405, 'method-not-allowed');
                return;
            }
            try {
                const ids = await readExportSelection(req);
                const pending = await pendingStore.load();
                const visible = new Set(registry.archivedSessionIds
                    .map(String)
                    .filter((id) => !pending.has(id)));
                if (ids.some((id) => !visible.has(id))) {
                    sendText(res, 404, 'session-not-archived');
                    return;
                }
                const state = await listArchived(ctx, registry, persistence, titleCache, metadataStore, pendingStore, trashStore);
                const rows = new Map(state.sessions.map((row) => [row.id, row]));
                if (ids.some((id) => !rows.has(id))) {
                    sendText(res, 404, 'session-not-archived');
                    return;
                }
                let stats;
                try {
                    stats = await statsService.measure(ids);
                } catch (error) {
                    ctx.logger.warn(`archived-chats: export storage measurement unavailable: ${String(error?.code ?? error?.name ?? 'Error')}`);
                    stats = { sessions: {} };
                }
                const descriptors = ids.map((id) => ({
                    ...rows.get(id),
                    storage: stats.sessions?.[id] ?? {
                        status: 'unavailable',
                        sizeBytes: null,
                        fileCount: null,
                    },
                }));
                const plan = planExport(descriptors, new Date());
                const zip = await createExportZip({
                    plan,
                    inspect: (id) => persistence.inspect(id),
                    generatorVersion: PLUGIN_VERSION,
                });
                let aborted = false;
                const abort = () => {
                    aborted = true;
                    zip.abort(Object.assign(new Error('export client disconnected'), { code: 'export-aborted' }));
                };
                req.once?.('aborted', abort);
                res.writeHead(200, {
                    'content-type': 'application/zip',
                    'content-disposition': contentDisposition(plan.filename),
                    'cache-control': 'no-store',
                    'x-content-type-options': 'nosniff',
                });
                zip.stream.pipe(res);
                try {
                    await zip.completion;
                } finally {
                    req.off?.('aborted', abort);
                }
                if (aborted) return;
            } catch (error) {
                if (res.headersSent) {
                    ctx.logger.warn(`archived-chats: export stream failed: ${String(error?.code ?? error?.name ?? 'Error')}`);
                    res.destroy?.();
                    return;
                }
                const status = error.status ?? (error instanceof SyntaxError || error instanceof TypeError ? 400 : 500);
                sendText(res, status, status === 413
                    ? 'request-too-large'
                    : (status === 400 ? 'invalid-export-request' : 'export-failed'));
            }
        },
    }), 'archived-chats: export route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/import/inspect`,
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            try {
                const bytes = await readImportUpload(req);
                const inspected = inspectImport({ bytes, compressedBytes: bytes.byteLength });
                if (!inspected.ok) {
                    send(res, 400, { ok: false, error: 'import-invalid', errors: inspected.errors });
                    return;
                }
                const known = new Set();
                try {
                    for (const header of await persistence.list()) known.add(String(header.id));
                } catch { /* preview can still show package validity */ }
                const archived = new Set(registry.archivedSessionIds.map(String));
                const workspaceIds = new Set((registry.list?.() ?? []).map((workspace) => String(workspace.id)));
                const token = importTokens.create(inspected.plan);
                const sessions = inspected.plan.items.map((item) => {
                    const conflict = known.has(item.id) || archived.has(item.id);
                    const warnings = [...item.warnings];
                    if (item.workspace?.id !== null && item.workspace?.id !== undefined && !workspaceIds.has(String(item.workspace.id))) warnings.push('workspace-unresolved');
                    return {
                        id: item.id,
                        title: item.title,
                        workspace: item.workspace,
                        tags: item.tags,
                        note: item.note,
                        storage: item.storage,
                        hasAttachmentReferences: item.hasAttachmentReferences,
                        warnings: [...new Set(warnings)],
                        conflict,
                    };
                });
                send(res, 200, {
                    ok: true,
                    token: token.token,
                    nonce: token.nonce,
                    expiresAt: token.expiresAt,
                    package: {
                        generator: inspected.plan.manifest.generator,
                        version: inspected.plan.manifest.version,
                        sessionCount: inspected.plan.manifest.sessionCount,
                        totalBytes: inspected.plan.totalBytes,
                    },
                    sessions,
                });
            } catch (error) {
                send(res, error.status ?? 400, { ok: false, error: error.code ?? 'import-invalid', message: String(error?.message ?? error) });
            }
        },
    }), 'archived-chats: import inspect route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/import/restore`,
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            let body;
            try {
                body = await readBody(req);
                if (typeof body.token !== 'string' || typeof body.nonce !== 'string' || !Array.isArray(body.sessionIds)) {
                    send(res, 400, { ok: false, error: 'import-confirmation-invalid' });
                    return;
                }
                const plan = importTokens.consume(body.token, body.nonce);
                const outcome = await lifecycle.run(async () => {
                    const currentIds = new Set();
                    let headers;
                    try { headers = await persistence.list(); }
                    catch { throw Object.assign(new Error('session inventory is unavailable'), { status: 503, code: 'restore-inventory-unavailable' }); }
                    if (!Array.isArray(headers)) throw Object.assign(new Error('session inventory is unavailable'), { status: 503, code: 'restore-inventory-unavailable' });
                    for (const header of headers) currentIds.add(String(header.id));
                    for (const id of registry.archivedSessionIds.map(String)) currentIds.add(id);
                    const selected = selectImportItems(plan, body.sessionIds, currentIds);
                    if (selected.records.length === 0) return { selected, result: null };
                    const transaction = await restoreAdapter.prepare(selected.records, { knownIds: currentIds });
                    for (const item of selected.records) await transaction.stage(item);
                    return { selected, result: await transaction.commit() };
                });
                if (outcome.result === null) {
                    send(res, 409, { ok: false, error: 'nothing-to-restore', skipped: outcome.selected.skipped });
                    return;
                }
                const { result, selected } = outcome;
                projectedMessages.invalidate(result.restored);
                send(res, 200, { ok: true, restored: result.restored, skipped: selected.skipped, warnings: result.warnings });
            } catch (error) {
                const status = error.status ?? (error.code === 'restore-unsupported' ? 501 : 500);
                send(res, status, { ok: false, error: error.code ?? 'restore-failed', message: String(error?.message ?? error) });
            }
        },
    }), 'archived-chats: import restore route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/metadata`,
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            let body;
            try {
                body = await readBody(req);
                if (typeof body.sessionId !== 'string' || body.sessionId === '') {
                    send(res, 400, { error: 'sessionId-required' });
                    return;
                }
                if (!registry.archivedSessionIds.map(String).includes(body.sessionId)) {
                    send(res, 404, { error: 'session-not-archived' });
                    return;
                }
                if ((await requireTrashRecord(trashStore, body.sessionId)) !== null) {
                    send(res, 409, { error: 'session-in-trash' });
                    return;
                }
                const entry = await metadataStore.set(body.sessionId, { tags: body.tags, note: body.note });
                send(res, 200, { ok: true, metadata: entry ?? { tags: [], note: '', updatedAt: null } });
            } catch (error) {
                if (error instanceof MetadataStoreError) {
                    send(res, error.status, { error: error.code, message: error.message });
                    return;
                }
                ctx.logger.warn(`archived-chats: metadata save failed for ${typeof body?.sessionId === 'string' ? body.sessionId : 'unknown'}: ${String(error?.code ?? error?.name ?? 'Error')}`);
                send(res, error.status ?? 500, { error: 'metadata-save-failed', message: String(error?.message ?? error) });
            }
        },
    }), 'archived-chats: metadata route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/trash`,
        handler: async (req, res) => {
            if (req.method !== 'GET') { send(res, 405, { error: 'method-not-allowed' }); return; }
            try {
                const sessions = await recycleService.list();
                send(res, 200, { ok: true, trashStatus: 'ready', summary: await recycleService.summary(), sessions });
            } catch (error) {
                send(res, error.status ?? 503, { ok: false, error: error.code ?? 'trash-store-unavailable' });
            }
        },
    }), 'archived-chats: trash route');

    const trashIdsHandler = (action, resultKey) => async (req, res) => {
        if (!guard(req, res)) return;
        try {
            const body = await readBody(req);
            const ids = Array.isArray(body.sessionIds) ? [...new Set(body.sessionIds.filter((id) => typeof id === 'string' && id !== ''))] : [];
            if (ids.length === 0) { send(res, 400, { error: 'sessionIds-required' }); return; }
            if (ids.length > 2000) { send(res, 400, { error: 'sessionIds-too-many' }); return; }
            const result = await action(ids);
            const failed = result.failed ?? [];
            send(res, failed.length > 0 && (result[resultKey]?.length ?? 0) === 0 ? 409 : 200, { ok: failed.length === 0, ...result });
        } catch (error) {
            send(res, error.status ?? 500, { ok: false, error: error.code ?? 'trash-operation-failed' });
        }
    };
    ctx.effect(() => webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/trash/restore`, handler: trashIdsHandler((ids) => recycleService.restore(ids), 'restored') }), 'archived-chats: trash restore route');
    ctx.effect(() => webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/trash/purge`, handler: trashIdsHandler((ids) => recycleService.purge(ids), 'purged') }), 'archived-chats: trash purge route');
    ctx.effect(() => webServer.register({
        kind: 'exact', path: `${ROUTE_PREFIX}/trash/empty`, handler: async (req, res) => {
            if (!guard(req, res)) return;
            try {
                await readBody(req);
                const result = await recycleService.empty();
                send(res, result.failed.length > 0 && result.purged.length === 0 ? 409 : 200, { ok: result.failed.length === 0, ...result });
            } catch (error) { send(res, error.status ?? 500, { ok: false, error: error.code ?? 'trash-empty-failed' }); }
        },
    }), 'archived-chats: trash empty route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/unarchive`,
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            try {
                const body = await readBody(req);
                if (typeof body.sessionId !== 'string' || body.sessionId === '') {
                    send(res, 400, { error: 'sessionId-required' });
                    return;
                }
                if ((await requireTrashRecord(trashStore, body.sessionId)) !== null) {
                    send(res, 409, { error: 'session-in-trash' });
                    return;
                }
                const archivedSessionIds = await lifecycle.run(async () => {
                    if ((await requireTrashRecord(trashStore, body.sessionId)) !== null) throw Object.assign(new Error('session is in trash'), { code: 'session-in-trash', status: 409 });
                    const next = await unarchiveIds(registry, [body.sessionId]);
                    titleCache.delete(body.sessionId);
                    projectedMessages.invalidate([body.sessionId]);
                    await pendingStore.remove([body.sessionId]);
                    return next;
                });
                send(res, 200, { ok: true, archivedSessionIds });
            } catch (error) {
                send(res, error.status ?? 500, { error: error.code ?? 'unarchive-failed', message: String(error?.message ?? error) });
            }
        },
    }), 'archived-chats: unarchive route');

    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/unarchive-all`,
        handler: async (req, res) => {
            if (!guard(req, res)) return;
            try {
                const body = await readBody(req);
                const ids = Array.isArray(body.sessionIds) ? body.sessionIds.filter((id) => typeof id === 'string') : [];
                if (ids.length === 0) {
                    send(res, 400, { error: 'sessionIds-required' });
                    return;
                }
                const trashRecords = await trashStore.load();
                if (trashRecords.status !== 'ready') { send(res, 503, { error: 'trash-store-unavailable' }); return; }
                if (ids.some((id) => trashRecords.records.has(String(id)))) { send(res, 409, { error: 'session-in-trash' }); return; }
                const archivedSessionIds = await lifecycle.run(async () => {
                    const currentTrash = await trashStore.load();
                    if (currentTrash.status !== 'ready') throw Object.assign(new Error('trash store is unavailable'), { code: 'trash-store-unavailable', status: 503 });
                    if (ids.some((id) => currentTrash.records.has(String(id)))) throw Object.assign(new Error('session is in trash'), { code: 'session-in-trash', status: 409 });
                    const next = await unarchiveIds(registry, ids);
                    for (const id of ids) titleCache.delete(id);
                    projectedMessages.invalidate(ids);
                    await pendingStore.remove(ids);
                    return next;
                });
                send(res, 200, { ok: true, archivedSessionIds });
            } catch (error) {
                send(res, error.status ?? 500, { error: 'unarchive-failed', message: String(error?.message ?? error) });
            }
        },
    }), 'archived-chats: unarchive-all route');

    const deleteHandler = (batch) => async (req, res) => {
        if (!guard(req, res)) return;
        try {
            const body = await readBody(req);
            const ids = batch
                ? (Array.isArray(body.sessionIds) ? body.sessionIds.filter((id) => typeof id === 'string') : [])
                : (typeof body.sessionId === 'string' && body.sessionId !== '' ? [body.sessionId] : []);
            if (ids.length === 0) {
                send(res, 400, { error: batch ? 'sessionIds-required' : 'sessionId-required' });
                return;
            }
            const result = await recycleService.move(ids);
            send(res, result.failed.length > 0 && result.trashed.length === 0 ? 409 : 200, { ok: result.failed.length === 0, ...result });
        } catch (error) {
            send(res, error.status ?? 500, { error: 'delete-failed', message: String(error?.message ?? error) });
        }
    };
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/delete`,
        handler: deleteHandler(false),
    }), 'archived-chats: delete route');
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/delete-all`,
        handler: deleteHandler(true),
    }), 'archived-chats: delete-all route');
    return recycleService;
}
//#endregion

/**
 * Mount the plugin. The Web profile mounts `webServer`, `workspaceRegistry`,
 * and `sessionPersistence`; headless profiles never bind them, in which case
 * the plugin stays dormant instead of blocking boot.
 */
export function apply(ctx) {
    let registered = false;
    /** Memoized session titles for {@link listArchived} (id → title). */
    const titleCache = new Map();
    const metadataPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugin-data', 'archived-chats', 'metadata.json');
    const pluginDataRoot = dirname(metadataPath);
    const metadataStore = createMetadataStore({ filePath: metadataPath });
    const pendingStore = createPendingStore();
    const trashStore = createTrashStore({ path: join(pluginDataRoot, 'trash.json') });
    const retentionStore = createRetentionStore({ path: join(pluginDataRoot, 'retention.json') });
    const importTokens = createImportTokenStore();
    const lifecycle = createLifecycleQueue();
    let statsService;
    const registerWebSurface = () => {
        if (registered) return;
        const webServer = ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1]);
        const registry = ctx.get(WORKSPACE_KEYS[0]) ?? ctx.get(WORKSPACE_KEYS[1]);
        const persistence = ctx.get(PERSISTENCE_KEYS[0]);
        if (webServer === undefined || registry === undefined || persistence === undefined) return;
        registered = true;
        statsService ??= createStatsService({ persistence });
        const snapshotStore = createSnapshotStore({
            root: join(pluginDataRoot, 'snapshots'),
            persistence,
            attachments: ctx.get('attachments'),
        });
        const restoreAdapter = createRestoreAdapter({
            ctx,
            persistence,
            registry,
            metadataStore,
            tempRoot: join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugin-data', 'archived-chats', 'imports'),
        });
        const recycleService = registerRoutes(ctx, webServer, registry, persistence, titleCache, metadataStore, statsService, pendingStore, trashStore, snapshotStore, retentionStore, lifecycle, importTokens, restoreAdapter);
        void recycleService.recoverStartup({ legacyPendingPath: pendingFilePath() })
            .catch((error) => ctx.logger.warn(`archived-chats: recycle recovery failed: ${String(error?.code ?? error?.name ?? 'recovery-failed')}`));
    };
    registerWebSurface();
    ctx.on('internal/service', (serviceName) => {
        if (WEB_SERVER_KEYS.includes(serviceName)
            || WORKSPACE_KEYS.includes(serviceName)
            || PERSISTENCE_KEYS.includes(serviceName)) {
            registerWebSurface();
        }
    });
}
