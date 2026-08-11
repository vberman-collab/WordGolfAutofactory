// Daily-completion streak, persisted client-side. A day only counts once
// (recordDailyCompletion is idempotent per dateUtc) so repeated wins or a
// page reload after solving never inflate the count.

const STORAGE_KEY = "word-golf-streak";

interface StreakState {
  lastCompletedDate: string | null;
  currentStreak: number;
}

function readState(): StreakState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { lastCompletedDate: null, currentStreak: 0 };
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.currentStreak === "number" &&
      (parsed.lastCompletedDate === null ||
        typeof parsed.lastCompletedDate === "string")
    ) {
      return parsed as StreakState;
    }
  } catch {
    // corrupt/unavailable storage — fall through to a fresh streak
  }
  return { lastCompletedDate: null, currentStreak: 0 };
}

function writeState(state: StreakState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage may be unavailable (private mode, quota) — streak just won't persist
  }
}

/** UTC calendar date one day before `dateUtc` (YYYY-MM-DD in, YYYY-MM-DD out). */
function previousDateUtc(dateUtc: string): string {
  const ms = Date.parse(`${dateUtc}T00:00:00Z`) - 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Current streak without mutating it — safe to call on every render. */
export function peekStreak(): number {
  return readState().currentStreak;
}

/**
 * Records that the daily puzzle for `dateUtc` was completed and returns the
 * resulting streak. Idempotent for a given date. Continues an existing streak
 * only if the previous completion was the prior calendar day; otherwise resets
 * to 1.
 */
export function recordDailyCompletion(dateUtc: string): number {
  const state = readState();
  if (state.lastCompletedDate === dateUtc) return state.currentStreak;

  const continuesStreak = state.lastCompletedDate === previousDateUtc(dateUtc);
  const nextStreak = continuesStreak ? state.currentStreak + 1 : 1;
  writeState({ lastCompletedDate: dateUtc, currentStreak: nextStreak });
  return nextStreak;
}
