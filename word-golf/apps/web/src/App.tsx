import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  makeDailyPuzzle,
  makePracticePuzzle,
  neighbors,
  normalizePracticeDifficulty,
  relativeToPar,
  scoreLabel,
  utcDateString,
  validateMove,
  WORD_LENGTH,
  type MoveRejection,
  type PracticeDifficulty,
  type Puzzle,
  type WordGraph,
  PRACTICE_DIFFICULTIES,
} from "@word-golf/engine";
import { FLAG_KEYS, METRIC_EVENTS, useFlag, useTrack } from "@word-golf/ld";
import { graph, practicePools, startPool, targetPool } from "./words.js";
import { peekStreak, recordDailyCompletion } from "./streak.js";

const PRACTICE_DIFFICULTY_LEVELS = PRACTICE_DIFFICULTIES;

const REJECTION_COPY: Record<MoveRejection, string> = {
  "wrong-length": `Use exactly ${WORD_LENGTH} letters.`,
  "no-change": "Change exactly one letter.",
  "too-many-changes": "Only one letter may change per move.",
  "not-a-word": "Not a valid word — reverting to the last good word.",
};

interface Feedback {
  kind: "info" | "error";
  text: string;
}

export function App() {
  const today = utcDateString();
  const track = useTrack();
  const showMissionControl = useFlag(FLAG_KEYS.showMissionControl);
  const enableRandomPuzzle = useFlag(FLAG_KEYS.enableRandomPuzzle);
  const showHintButton = useFlag(FLAG_KEYS.hintButton);
  const enableShareResultButton = useFlag(FLAG_KEYS.shareResultButton);
  // Treatment (enable-difficulty-picker-ux = true): difficulty starts unset;
  // players must explicitly choose Easy / Medium / Hard before a Random puzzle.
  // Control (false): difficulty is seeded from the word-pool-difficulty flag
  // default, preserving the original UX exactly.
  const enableDifficultyPickerUx = useFlag(FLAG_KEYS.enableDifficultyPickerUx);
  const wordPoolDifficultyRaw = useFlag(FLAG_KEYS.wordPoolDifficulty);
  // Defensive guard: word-pool-difficulty is documented (config/flags.json) as a
  // 3-way string flag ("easy" | "medium" | "hard"), but flag misconfiguration in
  // LaunchDarkly could serve an unexpected value (e.g. a boolean). Falling back to
  // "medium" avoids crashing puzzle generation on the control path.
  const wordPoolDifficulty = normalizePracticeDifficulty(wordPoolDifficultyRaw);
  const showPoweredByFooter = useFlag(FLAG_KEYS.showPoweredByFooter);

  // Business metric: fire once when the footer is rendered (treatment path).
  // Wrapped in try/catch so a tracking failure can never break the page.
  useEffect(() => {
    if (!showPoweredByFooter) return;
    try {
      track(METRIC_EVENTS.poweredByFooterViewed);
    } catch {
      // intentionally swallowed — telemetry must not affect rendering
    }
  }, [showPoweredByFooter, track]);

  const [practiceDifficulty, setPracticeDifficulty] =
    useState<PracticeDifficulty | null>(() =>
      enableDifficultyPickerUx ? null : wordPoolDifficulty
    );
  const [difficultyNeedsPick, setDifficultyNeedsPick] = useState(false);

  // Control path: sync practiceDifficulty from word-pool-difficulty flag.
  // Treatment path: when the flag turns on (e.g. after LD hydration), clear any
  // control-path seed so the player must explicitly pick Easy/Medium/Hard.
  useEffect(() => {
    if (!enableDifficultyPickerUx) {
      setPracticeDifficulty(wordPoolDifficulty);
    } else {
      setPracticeDifficulty(null);
      setDifficultyNeedsPick(false);
    }
  }, [enableDifficultyPickerUx, wordPoolDifficulty]);

  // The active puzzle is stateful so players can switch between the shared
  // daily and one-off random "practice" puzzles.
  // When the flag is off this always stays on the daily puzzle (control path).
  const [puzzle, setPuzzle] = useState<Puzzle>(() =>
    makeDailyPuzzle({ dateUtc: today, startPool, graph, steps: 6, targetPool })
  );
  // isDaily is only meaningful when enableRandomPuzzle is on; defaults true.
  const [isDaily, setIsDaily] = useState(true);

  const [path, setPath] = useState<string[]>([puzzle.start]);
  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const current = path[path.length - 1];
  const moves = path.length - 1;
  const won = current === puzzle.target;

  const [streak, setStreak] = useState(() => peekStreak());

  // Timing + once-only guards for metric events.
  const startTimeRef = useRef(Date.now());
  const lastMoveRef = useRef(Date.now());
  const completedRef = useRef(false);

  // Business + latency: fire once when the puzzle is solved.
  useEffect(() => {
    if (!won || completedRef.current) return;
    completedRef.current = true;
    track(METRIC_EVENTS.puzzleCompleted, {
      data: { moves, par: puzzle.par },
    });
    track(METRIC_EVENTS.timeToSolveMs, {
      value: Date.now() - startTimeRef.current,
    });
    if (puzzle.par !== null && moves <= puzzle.par) {
      track(METRIC_EVENTS.madePar, { data: { moves, par: puzzle.par } });
    }
    // Streak only tracks the shared daily puzzle, not one-off practice rounds.
    if (isDaily) {
      setStreak(recordDailyCompletion(today));
    }
  }, [won, moves, puzzle.par, track, isDaily, today]);

  // Error: count an abandon if the player leaves mid-puzzle after moving.
  const wonRef = useRef(won);
  const movesRef = useRef(moves);
  wonRef.current = won;
  movesRef.current = moves;
  useEffect(() => {
    const onLeave = () => {
      if (!wonRef.current && movesRef.current > 0) {
        track(METRIC_EVENTS.puzzleAbandoned, {
          data: { moves: movesRef.current },
        });
      }
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [track]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (won) return;
    const result = validateMove(current, input, graph);
    if (!result.ok) {
      track(METRIC_EVENTS.invalidMove, { data: { reason: result.reason } });
      setFeedback({ kind: "error", text: REJECTION_COPY[result.reason] });
      setInput("");
      return;
    }
    const now = Date.now();
    track(METRIC_EVENTS.moveLatencyMs, { value: now - lastMoveRef.current });
    lastMoveRef.current = now;
    const nextPath = [...path, result.word];
    setPath(nextPath);
    setInput("");
    if (result.word === puzzle.target) {
      setFeedback({ kind: "info", text: "Solved!" });
    } else {
      setFeedback(null);
    }
  }

  function undo() {
    if (path.length <= 1) return;
    setPath(path.slice(0, -1));
    setFeedback({ kind: "info", text: "Reverted to the previous word." });
  }

  function hint() {
    if (won) return;
    // Track hint usage for the guarded-release metric (occurrence only).
    // Wrapped in try/catch so a tracking failure can never break the button.
    try {
      track(METRIC_EVENTS.hintButtonUsed);
    } catch {
      // intentionally swallowed — telemetry must not affect gameplay
    }
    const step = firstStepToward(current, puzzle.target, graph);
    if (!step) {
      setFeedback({ kind: "info", text: "No hint available from here." });
      return;
    }
    setFeedback({ kind: "info", text: `Try a word like "${step}".` });
  }

  function reset() {
    setPath([puzzle.start]);
    setInput("");
    setFeedback(null);
    startTimeRef.current = Date.now();
    lastMoveRef.current = Date.now();
    completedRef.current = false;
  }

  // Swap in a fresh puzzle and reset all per-puzzle state (board + metric guards).
  function startPuzzle(next: Puzzle, daily: boolean) {
    setPuzzle(next);
    setIsDaily(daily);
    setPath([next.start]);
    setInput("");
    setFeedback(null);
    setDifficultyNeedsPick(false);
    startTimeRef.current = Date.now();
    lastMoveRef.current = Date.now();
    completedRef.current = false;
  }

  function newRandomPuzzle(difficulty: PracticeDifficulty) {
    const level = normalizePracticeDifficulty(difficulty);
    const pools = practicePools(level);
    const genStart = Date.now();
    try {
      const puzzle = makePracticePuzzle({
        difficulty: level,
        graph,
        steps: 6,
        ...pools,
      });
      // Latency: measure puzzle-generation time (both treatment and control paths).
      try {
        track(METRIC_EVENTS.practicePuzzleGenerationMs, {
          value: Date.now() - genStart,
          data: { difficulty },
        });
      } catch {
        // telemetry must not affect gameplay
      }
      // Business: practice puzzle successfully started.
      try {
        track(METRIC_EVENTS.practicePuzzleStarted, { data: { difficulty } });
      } catch {
        // telemetry must not affect gameplay
      }
      startPuzzle(puzzle, false);
    } catch {
      // Error: puzzle generation failed — show feedback instead of crashing.
      try {
        track(METRIC_EVENTS.practicePuzzleError, { data: { difficulty } });
      } catch {
        // telemetry must not affect gameplay
      }
      setFeedback({
        kind: "error",
        text: "Couldn't generate a puzzle — try again or pick another difficulty.",
      });
    }
  }

  function onRandomPuzzleClick() {
    if (enableDifficultyPickerUx) {
      // Treatment: require an explicit difficulty selection first.
      if (!practiceDifficulty) {
        setDifficultyNeedsPick(true);
        return;
      }
      newRandomPuzzle(practiceDifficulty);
    } else {
      // Control: original behavior — difficulty is always set (seeded from flag default).
      newRandomPuzzle(practiceDifficulty ?? wordPoolDifficulty);
    }
  }

  function onDifficultyPick(level: PracticeDifficulty) {
    setPracticeDifficulty(level);
    if (enableDifficultyPickerUx) {
      setDifficultyNeedsPick(false);
      if (!isDaily) newRandomPuzzle(level);
    } else {
      // Control: same as original onClick inline handler.
      if (!isDaily) newRandomPuzzle(level);
    }
  }

  function backToDaily() {
    startPuzzle(
      makeDailyPuzzle({ dateUtc: today, startPool, graph, steps: 6, targetPool }),
      true
    );
  }

  async function shareResult() {
    if (puzzle.par === null) return;
    const text = formatDailyShareText(today, moves, puzzle.par);
    try {
      await navigator.clipboard.writeText(text);
      // Business metric: the share action completed successfully.
      try {
        track(METRIC_EVENTS.resultShared);
      } catch {
        // intentionally swallowed — telemetry must not affect gameplay
      }
      setFeedback({ kind: "info", text: "Result copied — paste anywhere to share." });
    } catch {
      // Error metric: clipboard write failed.
      try {
        track(METRIC_EVENTS.clipboardError);
      } catch {
        // intentionally swallowed — telemetry must not affect gameplay
      }
      setFeedback({ kind: "error", text: "Could not copy — try selecting the result manually." });
    }
  }

  return (
    <main className="app">
      <header className="header">
        <h1>Word Golf</h1>
        <p className="tagline">
          Turn the starting word into the target word, one letter at a time.
          Every step must be a real word — anything else reverts to the last
          good word.
        </p>
      </header>

      <section className="goal">
        <WordChip label="Start" word={puzzle.start} />
        <span className="arrow" aria-hidden>
          →
        </span>
        <WordChip label="Target" word={puzzle.target} tone="target" />
      </section>

      <section className="scoreboard">
        <Stat label="Moves" value={String(moves)} />
        <Stat label="Par" value={puzzle.par === null ? "\u2014" : String(puzzle.par)} />
        <Stat
          label={enableRandomPuzzle && !isDaily ? "Practice" : "Daily"}
          value={
            enableRandomPuzzle && !isDaily && practiceDifficulty
              ? practiceDifficulty.charAt(0).toUpperCase() + practiceDifficulty.slice(1)
              : today
          }
        />
        {streak > 0 && <Stat label="Streak" value={`${streak}🔥`} />}
      </section>

      <ol className="track" aria-label="Move history">
        {path.map((word, i) => (
          <li
            key={`${word}-${i}`}
            className={`row ${word === puzzle.target ? "row-target" : ""}`}
          >
            {word.split("").map((ch, j) => (
              <span
                key={j}
                className={`tile ${ch !== puzzle.target[j] ? "tile-off" : "tile-on"}`}
              >
                {ch}
              </span>
            ))}
          </li>
        ))}
      </ol>

      {won ? (
        <section className="win">
          <h2>
            {puzzle.par !== null
              ? `${scoreLabel(moves, puzzle.par)} — solved in ${moves} (par ${puzzle.par})`
              : `Solved in ${moves}`}
          </h2>
          <div className="win-actions">
            {isDaily && enableShareResultButton && (
              <button type="button" onClick={shareResult}>
                Share result
              </button>
            )}
            <button type="button" onClick={reset}>
              Play again
            </button>
          </div>
        </section>
      ) : (
        <form className="controls" onSubmit={submit}>
          <input
            value={input}
            onChange={(e) =>
              setInput(
                e.target.value.replace(/[^a-zA-Z]/g, "").slice(0, WORD_LENGTH)
              )
            }
            placeholder={`${WORD_LENGTH}-letter word`}
            aria-label="Your next word"
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit">Play</button>
          <button type="button" onClick={undo} disabled={path.length <= 1}>
            Undo
          </button>
          {showHintButton && (
            <button type="button" onClick={hint}>
              Hint
            </button>
          )}
        </form>
      )}

      {feedback && (
        <p
          className={`feedback feedback-${feedback.kind}`}
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.text}
        </p>
      )}

      {enableRandomPuzzle && (
        <section className="puzzle-actions" aria-labelledby="try-another-heading">
          <h2 id="try-another-heading" className="puzzle-actions-heading">
            Try another puzzle?
          </h2>
          <div className="puzzle-actions-row">
            <button type="button" onClick={onRandomPuzzleClick}>
              Random puzzle
            </button>
            <div
              className={`difficulty-picker${difficultyNeedsPick ? " needs-pick" : ""}`}
              role="group"
              aria-label="Practice difficulty"
            >
              {PRACTICE_DIFFICULTY_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  className={practiceDifficulty === level ? "active" : ""}
                  aria-pressed={practiceDifficulty === level}
                  onClick={() => onDifficultyPick(level)}
                >
                  {level.charAt(0).toUpperCase() + level.slice(1)}
                </button>
              ))}
            </div>
          </div>
          {!isDaily && (
            <button type="button" className="link" onClick={backToDaily}>
              Back to today's daily
            </button>
          )}
        </section>
      )}

      {showPoweredByFooter && (
        <footer className="powered-by">
          Powered by LaunchDarkly{" "}
          <a
            href="https://launchdarkly.com/platform/code-control/"
            target="_blank"
            rel="noopener noreferrer"
          >
            CodeControl
          </a>
          {" · "}
          <a
            href="https://launchdarkly.com/platform/agent-control/"
            target="_blank"
            rel="noopener noreferrer"
          >
            AgentControl
          </a>
          {" · "}
          <a
            href="https://github.com/alawrenceld/launchdarkly-auto-factory"
            target="_blank"
            rel="noopener noreferrer"
          >
            Software Factory Reference Design
          </a>
        </footer>
      )}

      {/* Flag-evaluation seam: gated by the `show-mission-control` flag. The
          AutoFactory can flip this in LaunchDarkly; the real panel arrives in a
          later phase. */}
      {showMissionControl && (
        <footer className="mission-control-stub">
          Mission Control — coming soon
        </footer>
      )}
    </main>
  );
}

/** Days since launch epoch → spoiler-free daily puzzle number for share text. */
const SHARE_EPOCH = "2024-06-18";

function dailyPuzzleNumber(dateUtc: string): number {
  const epochMs = Date.parse(`${SHARE_EPOCH}T00:00:00Z`);
  const dayMs = Date.parse(`${dateUtc}T00:00:00Z`);
  return Math.floor((dayMs - epochMs) / 86_400_000) + 1;
}

/** Spoiler-free share line (plan.md §2.4): no words from the board revealed. */
function formatDailyShareText(dateUtc: string, moves: number, par: number): string {
  const n = dailyPuzzleNumber(dateUtc);
  const delta = relativeToPar(moves, par);
  const score =
    delta === 0 ? "E" : delta > 0 ? `+${delta}` : String(delta);
  return `Word Golf #${n} — solved in ${moves} (par ${par}) 🏌️ ${score}`;
}

/**
 * First word along a shortest path from `from` to `target` (the move a player
 * should make next), or null when the target is unreachable. Breadth-first so
 * the suggested step always lies on an optimal route.
 */
function firstStepToward(
  from: string,
  target: string,
  graph: WordGraph
): string | null {
  if (from === target) return null;
  const parent = new Map<string, string>();
  const visited = new Set<string>([from]);
  let frontier: string[] = [from];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const word of frontier) {
      for (const w of neighbors(word, graph)) {
        if (visited.has(w)) continue;
        visited.add(w);
        parent.set(w, word);
        if (w === target) {
          let step = w;
          for (let prev = parent.get(step); prev && prev !== from; prev = parent.get(step)) {
            step = prev;
          }
          return step;
        }
        next.push(w);
      }
    }
    frontier = next;
  }
  return null;
}

function WordChip({
  label,
  word,
  tone,
}: {
  label: string;
  word: string;
  tone?: "target";
}) {
  return (
    <div className={`chip ${tone === "target" ? "chip-target" : ""}`}>
      <span className="chip-label">{label}</span>
      <span className="chip-word">{word}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
