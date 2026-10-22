/** Optional official task bindings; a schedule is associated with a session,
 * not a session origin. Never infer historical automation from its title. */
export async function withScheduleBindings(schedule, state) {
  let scheduleStatus = 'unsupported';
  let sessionIds = new Set();
  if (typeof schedule?.catalog === 'function') {
    try {
      const catalog = await schedule.catalog();
      if (!Array.isArray(catalog) || catalog.some(row => typeof row?.sessionId !== 'string' || row.sessionId === '')) {
        throw new TypeError('invalid schedule catalog');
      }
      sessionIds = new Set(catalog.map(row => row.sessionId));
      scheduleStatus = 'ready';
    } catch {
      // Preserve ordinary lists, but surface the unavailable optional filter.
      scheduleStatus = 'unavailable';
    }
  }
  return { ...state, scheduleStatus, sessions: state.sessions.map(row => ({
    ...row, hasSchedule: scheduleStatus === 'ready' ? sessionIds.has(row.id) : null,
  })) };
}
