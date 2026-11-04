// Sim parity test: the Cloudflare Worker's simulateRun must produce
// byte-identical results to the Muse-hosted server's simulateRun for
// the same seed + character + level + input log (scoring is server-
// recomputed in both homes, so any drift would split the leaderboard).
// Run: bun ./tests/sim-parity.ts   (from the cloudflare/ directory)

import { simulateRun as hostedSimulate } from "../../server/src/sim";
import { simulateRun as cfSimulate } from "../worker/src/sim";
import type { InputEvent } from "../worker/src/sim";

/** Deterministic pseudo input log: an action every 37 ticks, cycling
 *  through the four actions — always ≥4 ticks apart, always valid. */
function makeInputs(count: number): InputEvent[] {
  const actions = ["jump", "left", "slide", "right"] as const;
  const inputs: InputEvent[] = [];
  for (let i = 0; i < count; i++) {
    inputs.push({ tick: 10 + i * 37, action: actions[i % actions.length]! });
  }
  return inputs;
}

const cases: { seed: number; characterId: string; level: number; inputs: InputEvent[] }[] = [
  { seed: 20261102, characterId: "lizi", level: 1, inputs: [] },
  { seed: 20261102, characterId: "lizi", level: 1, inputs: makeInputs(24) },
  { seed: 5973, characterId: "lizi", level: 3, inputs: makeInputs(40) },
  { seed: 123456, characterId: "xueqiu", level: 2, inputs: makeInputs(30) },
  { seed: 987654, characterId: "meiqiu", level: 5, inputs: makeInputs(30) },
  { seed: 424242, characterId: "huasheng", level: 1, inputs: makeInputs(18) },
  { seed: 777, characterId: "zhima", level: 4, inputs: makeInputs(36) },
  { seed: 31337, characterId: "imdpepe", level: 1, inputs: makeInputs(50) },
  // an invalid log (actions too dense) must be rejected identically
  {
    seed: 20261102,
    characterId: "lizi",
    level: 1,
    inputs: [
      { tick: 5, action: "jump" },
      { tick: 6, action: "left" },
    ],
  },
];

let failures = 0;
for (const c of cases) {
  const hosted = hostedSimulate(c.seed, c.characterId, c.inputs, c.level);
  const cf = cfSimulate(c.seed, c.characterId, c.inputs, c.level);
  const same = JSON.stringify(hosted) === JSON.stringify(cf);
  console.log(
    `${same ? "OK  " : "FAIL"} seed=${c.seed} char=${c.characterId} lv=${c.level} inputs=${c.inputs.length}` +
      ` → hosted score=${hosted.score} dist=${hosted.distance} seeds=${hosted.seeds} ticks=${hosted.ticks} valid=${hosted.valid}` +
      ` | cf score=${cf.score} dist=${cf.distance} seeds=${cf.seeds} ticks=${cf.ticks} valid=${cf.valid}`,
  );
  if (!same) {
    failures++;
    console.log("  hosted:", hosted);
    console.log("  cf:    ", cf);
  }
}

if (failures > 0) {
  console.error(`\n${failures} parity case(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} parity cases match (startRun → submitRun recompute is identical).`);
