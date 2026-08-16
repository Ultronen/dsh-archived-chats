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
 * (`sweepPendingDeletions`, launched once when the plugin's three services
 * have all bound) completes the removal through the ordinary cold delete path
 * on the next boot — when every session is cold. The pending store also
 * brackets the successful live path (recorded before disposal, cleared after
 * the files are gone), so a crash mid-delete is swept on the next boot
 * instead of leaving a half-deleted ghost. Unarchiving a parked session drops
 * it from the pending store, and the sweep skips ids that are no longer
 * archived, so an unarchive always wins over a parked deletion.
 *
 * Routes bind lazily (same posture as dsh-agent-teams): the web server, the
 * workspace registry, and session persistence may mount after this plugin
 * under the Loader's concurrent activation, so registration is retried on
 * every `internal/service` binding event until all three exist.
 *
 * @module dsh-archived-chats
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

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

//#region wire helpers
/** Read and JSON-parse a request body (empty body → {}). */
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8').trim();
            if (text === '') { resolve({}); return; }
            try { resolve(JSON.parse(text)); }
            catch { reject(Object.assign(new Error('request body is not valid JSON'), { status: 400 })); }
        });
        req.on('error', reject);
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

async function loadPending() {
    try {
        const parsed = JSON.parse(await readFile(pendingFilePath(), 'utf8'));
        const ids = Array.isArray(parsed?.ids) ? parsed.ids.filter((id) => typeof id === 'string') : [];
        return new Set(ids);
    } catch {
        return new Set();
    }
}

async function savePending(pending) {
    const path = pendingFilePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ ids: [...pending] }, null, 2)}\n`, 'utf8');
}

async function addPending(id) {
    const pending = await loadPending();
    pending.add(String(id));
    await savePending(pending);
}

/** Drop ids from the pending-deletion store (used when a parked session is unarchived). */
async function removePending(ids) {
    const pending = await loadPending();
    let changed = false;
    for (const id of ids) {
        if (pending.delete(String(id))) changed = true;
    }
    if (changed) await savePending(pending);
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

/**
 * Build the archived-session listing: one row per archived id with the
 * resolved title, creation time, and owning workspace (accounting slot first,
 * canonical cwd second, ungrouped last). Resolved titles are memoized in
 * `titleCache` (id → title) so refreshes stop re-reading every archived log:
 * only non-null titles are cached — a title-less session stays cheap to
 * re-inspect and picks up a late `session/title` event on the next refresh.
 * Delete and unarchive invalidate their ids.
 */
async function listArchived(ctx, registry, persistence, titleCache) {
    const archivedIds = registry.archivedSessionIds.map(String);
    if (archivedIds.length === 0) return [];
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
        const workspace = workspaces.find((w) => w.sessionIds.map(String).includes(id));
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
    const pendingIds = await loadPending();
    return rows.filter((row) => !pendingIds.has(row.id));
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
async function deleteSession(ctx, registry, persistence, id, titleCache) {
    if (ctx.get('sessions')?.get(id) !== undefined) {
        await addPending(id);
        const disposed = await disposeLiveSession(ctx, id);
        if (!disposed) return 'pending';
    }
    await unarchiveIds(registry, [id]);
    for (const workspace of registry.list()) {
        if (workspace.sessionIds.map(String).includes(String(id))) {
            try { await workspace.detachSession(id); }
            catch (error) { ctx.logger.warn(`archived-chats: detach failed for ${id}: ${String(error)}`); }
        }
    }
    let header;
    try {
        header = (await persistence.list()).find((h) => String(h.id) === String(id));
    } catch (error) {
        ctx.logger.warn(`archived-chats: header re-list failed for ${id}: ${String(error)}`);
    }
    if (header !== undefined) {
        const location = persistence.locate(header);
        if (location?.path !== undefined) {
            await rm(dirname(location.path), { recursive: true, force: true });
        }
    }
    // Purge the registry's in-memory header index (built once at startup from
    // persistence). Without this the stale header keeps the deleted session
    // "known" to the registry for the rest of this boot — it could be
    // re-archived as a ghost or re-accounted on the next workspace mutation.
    for (const key of ['headers', 'sessionPaths', 'invalidSessionPaths']) {
        const map = registry[key];
        if (map instanceof Map) map.delete(id);
    }
    titleCache?.delete(id);
    // Clear the crash bracket (and any pre-existing parked mark) now that the
    // files are gone. A no-op for ids that were never pending.
    await removePending([id]);
    return 'deleted';
}

/**
 * Boot-time sweep: every pending-deletion id is cold now (plugin activation
 * precedes any client resume), so each one completes the ordinary delete
 * path. Ids that fail stay in the store for the next boot.
 */
async function sweepPendingDeletions(ctx, registry, persistence) {
    let pending;
    try {
        pending = await loadPending();
    } catch (error) {
        ctx.logger.warn(`archived-chats: pending-deletions store unreadable: ${String(error)}`);
        return;
    }
    if (pending.size === 0) return;
    const archivedSet = new Set(registry.archivedSessionIds.map(String));
    for (const id of [...pending]) {
        try {
            // A parked id that got unarchived (by any path) is no longer meant
            // for deletion — drop it from the store and keep its files.
            if (!archivedSet.has(String(id))) {
                pending.delete(id);
                ctx.logger.info?.(`archived-chats: pending ${id} was unarchived — dropping it`);
                continue;
            }
            await deleteSession(ctx, registry, persistence, id);
            pending.delete(id);
            ctx.logger.info?.(`archived-chats: swept pending deletion ${id}`);
        } catch (error) {
            ctx.logger.warn(`archived-chats: pending deletion ${id} failed again: ${String(error)}`);
        }
    }
    try { await savePending(pending); }
    catch (error) { ctx.logger.warn(`archived-chats: pending-deletions store not saved: ${String(error)}`); }
}
//#endregion

//#region routes
function registerRoutes(ctx, webServer, registry, persistence, titleCache) {
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/state`,
        handler: async (req, res) => {
            try {
                const sessions = await listArchived(ctx, registry, persistence, titleCache);
                send(res, 200, { sessions });
            } catch (error) {
                ctx.logger.warn(`archived-chats: state failed: ${String(error)}`);
                send(res, 500, { error: 'state-failed', message: String(error?.message ?? error) });
            }
        },
    }), 'archived-chats: state route');

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
                const archivedSessionIds = await unarchiveIds(registry, [body.sessionId]);
                titleCache.delete(body.sessionId);
                await removePending([body.sessionId]);
                send(res, 200, { ok: true, archivedSessionIds });
            } catch (error) {
                send(res, error.status ?? 500, { error: 'unarchive-failed', message: String(error?.message ?? error) });
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
                const archivedSessionIds = await unarchiveIds(registry, ids);
                for (const id of ids) titleCache.delete(id);
                await removePending(ids);
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
            const deleted = [];
            const pending = [];
            const failed = [];
            for (const id of ids) {
                try {
                    const outcome = await deleteSession(ctx, registry, persistence, id, titleCache);
                    if (outcome === 'pending') pending.push(id);
                    else deleted.push(id);
                } catch (error) {
                    failed.push({ id, code: error.code ?? 'delete-failed', message: String(error?.message ?? error) });
                }
            }
            send(res, failed.length > 0 && deleted.length === 0 && pending.length === 0 ? 409 : 200, { ok: failed.length === 0, deleted, pending, failed });
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
    const registerWebSurface = () => {
        if (registered) return;
        const webServer = ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1]);
        const registry = ctx.get(WORKSPACE_KEYS[0]) ?? ctx.get(WORKSPACE_KEYS[1]);
        const persistence = ctx.get(PERSISTENCE_KEYS[0]);
        if (webServer === undefined || registry === undefined || persistence === undefined) return;
        registered = true;
        registerRoutes(ctx, webServer, registry, persistence, titleCache);
        // Boot sweep: every pending-deletion id is cold now (plugin activation
        // precedes any client resume), so complete each deferred deletion.
        void sweepPendingDeletions(ctx, registry, persistence)
            .catch((error) => ctx.logger.warn(`archived-chats: boot sweep failed: ${String(error)}`));
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
