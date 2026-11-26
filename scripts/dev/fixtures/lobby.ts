/**
 * Shared Fair Launch Lobby vectors: inputs listed here, expected outputs from
 * the TypeScript SDK, checked against float-core by
 * `crates/float-core/tests/lobby_vectors.rs`.
 *
 * Big integers are strings. Every result is `{ "ok": value }` or `{ "err": "CoreErrorName" }`.
 */
import { lobby as l } from "@float-community/sdk";

type Result = { ok: unknown } | { err: string };

const run = (fn: () => unknown): Result => {
  try {
    const v = fn();
    return { ok: v === undefined ? true : v };
  } catch (e) {
    if (e instanceof l.LobbyError) return { err: e.code };
    throw e;
  }
};
const str = (v: unknown): unknown =>
  typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(str) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, str(x)])) : v;

/** Deterministic xorshift64 (same recurrence as the Rust invariant tests). */
function xorshift(seed: bigint) {
  let x = seed;
  const M = (1n << 64n) - 1n;
  return (n: bigint) => {
    x ^= (x << 13n) & M;
    x ^= x >> 7n;
    x ^= (x << 17n) & M;
    return x % n;
  };
}

// Real LaunchLab default curve (same pool as the SDK, CLI and Rust tests).
const VB = 1_073_025_605_596_382n;
const VQ = 30_000_852_951n;
const SELL = 793_100_000_000_000n;
const SUPPLY = 1_000_000_000_000_000n;
const FEE = 10_000n; // 1 %

const ok = l.lobbyParamsWithDefaults(1n);
const paramCases: [string, l.LobbyParams][] = [
  ["defaults", ok],
  ["duration 119", { ...ok, durationSecs: 119 }],
  ["duration 3601", { ...ok, durationSecs: 3_601 }],
  ["duration 120 with lock 60", { ...ok, durationSecs: 120, lockWindowSecs: 60 }],
  ["lock above half", { ...ok, lockWindowSecs: 301 }],
  ["grace 59", { ...ok, finalizeGraceSecs: 59 }],
  ["grace 3600", { ...ok, finalizeGraceSecs: 3_600 }],
  ["min raise 0", { ...ok, minRaise: 0n }],
  ["min wallets 0", { ...ok, minWallets: 0 }],
  ["min wallets 1000", { ...ok, minWallets: 1_000 }],
  ["min wallets 1001", { ...ok, minWallets: 1_001 }],
  ["max supply 0", { ...ok, maxSupplyBps: 0 }],
  ["max supply 2000", { ...ok, maxSupplyBps: 2_000, walletSupplyBps: 2_000 }],
  ["max supply 2001", { ...ok, maxSupplyBps: 2_001 }],
  ["wallet 0", { ...ok, walletSupplyBps: 0 }],
  ["wallet above max", { ...ok, maxSupplyBps: 100, walletSupplyBps: 101 }],
  ["unlock 3600", { ...ok, unlockSecs: 3_600 }],
  ["unlock 3601", { ...ok, unlockSecs: 3_601 }],
];

const phaseTimes: [l.LobbyState, boolean, bigint][] = [
  ["Open", true, 999n],
  ["Open", false, 1_000n],
  ["Open", false, 1_539n],
  ["Open", false, 1_540n],
  ["Open", false, 1_599n],
  ["Open", true, 1_600n],
  ["Open", true, 2_200n],
  ["Open", true, 2_201n],
  ["Open", false, 1_600n],
  ["Finalized", false, 0n],
  ["Cancelled", true, 1_700n],
];

const actions: l.Action[] = ["Deposit", "Withdraw", "Finalize", "Cancel", "Claim", "Refund"];
const phases: l.Phase[] = ["Pending", "Open", "Locked", "Finalizable", "Expired", "Finalized", "Cancelled"];

type TotalsOp = { op: "deposit"; wallet: bigint; amount: bigint; cap: bigint } | { op: "withdraw"; wallet: bigint; amount: bigint };
const totalsOps: TotalsOp[] = [
  { op: "deposit", wallet: 0n, amount: 30n, cap: 40n },
  { op: "deposit", wallet: 30n, amount: 10n, cap: 40n },
  { op: "deposit", wallet: 40n, amount: 1n, cap: 40n },
  { op: "deposit", wallet: 0n, amount: 20n, cap: 40n },
  { op: "withdraw", wallet: 20n, amount: 21n },
  { op: "withdraw", wallet: 20n, amount: 20n },
  { op: "deposit", wallet: 0n, amount: 0n, cap: 40n },
  { op: "withdraw", wallet: 40n, amount: 0n },
  { op: "deposit", wallet: (1n << 64n) - 1n, amount: 1n, cap: (1n << 64n) - 1n },
];

const genesis = l.genesisCurve(VB, VQ, SELL);
const quoteCases: [string, l.CurveState, bigint, bigint][] = [
  ["1 SOL at genesis, 1 % fee", genesis, 1_000_000_000n, FEE],
  ["zero input", genesis, 0n, FEE],
  ["one lamport", genesis, 1n, FEE],
  ["no fee", genesis, 123_456_789n, 0n],
  ["after some sales", { ...genesis, realBase: 300_000_000_000_000n, realQuote: 15_000_000_000n }, 2_500_000_000n, 12_500n],
  ["caps at the remaining curve", { ...genesis, realBase: SELL - 1_000n, realQuote: 84_000_000_000n }, 1n << 60n, FEE],
  ["fee rate 100 %", genesis, 1n, 1_000_000n],
  ["empty base reserve", { ...genesis, realBase: VB }, 1n, FEE],
];

const capCases: [string, l.CurveState, bigint, number, bigint][] = [
  ["15 % default curve", genesis, SUPPLY, 1_500, FEE],
  ["1 % default curve", genesis, SUPPLY, 100, FEE],
  ["20 % no fee", genesis, SUPPLY, 2_000, 0n],
  ["1 bps", genesis, SUPPLY, 1, FEE],
  ["coin costs many quote units", l.genesisCurve(10_000n, 10_000_000n, 5_000n), 10_000n, 1_000, FEE],
  ["share not below the curve", genesis, SUPPLY, 8_000, FEE],
  ["fee rate 100 %", genesis, SUPPLY, 100, 1_000_000n],
];

function allocationCase(name: string, deposits: bigint[], R: bigint, B: bigint) {
  const D = deposits.reduce((a, b) => a + b, 0n);
  return { name, deposits, totalDeposits: D, raiseSpent: R, tokensBought: B, expected: deposits.map((d) => run(() => l.claimAmounts(d, D, R, B))) };
}

function randomAllocations() {
  const rnd = xorshift(0x9e3779b97f4a7c15n);
  const out = [];
  for (let i = 0; i < 6; i++) {
    const n = Number(1n + rnd(25n));
    const deposits = Array.from({ length: n }, () => 1n + rnd(5_000_000_000n));
    const D = deposits.reduce((a, b) => a + b, 0n);
    const R = rnd(D + 1n);
    const B = rnd(200_000_000_000_000n);
    out.push(allocationCase(`xorshift batch ${i + 1}`, deposits, R, B));
  }
  return out;
}

const claimableCases: [bigint, bigint, bigint, number, bigint][] = [
  [1_000n, 100n, 50n, 0, 0n],
  [1_000n, 100n, 100n, 600, 0n],
  [1_000n, 100n, 50n, 600, 0n],
  [1_000n, 100n, 400n, 600, 0n],
  [1_000n, 100n, 400n, 600, 200n],
  [1_000n, 100n, 101n, 600, 0n],
  [1_000n, 100n, 10_000n, 600, 999n],
  [1_000n, 100n, 400n, 600, 501n],
];

export function buildLobbyVectors() {
  const timing = l.lobbyTiming(1_000n, ok);
  const curveJson = (s: l.CurveState) => s;
  return str({
    description: "Generated by scripts/dev/gen-fixtures.ts from scripts/dev/fixtures/lobby.ts. Do not edit by hand",
    spec: "docs/proposals/fair-launch-lobby.md",
    params: paramCases.map(([name, p]) => ({ name, params: p, expected: run(() => l.validateLobbyParams(p)) })),
    timing: { openAt: 1_000n, params: ok, expected: timing },
    phases: phaseTimes.map(([state, quorum, now]) => ({ state, quorum, now, expected: l.phaseAt(timing, state, quorum, now) })),
    actions: phases.flatMap((phase) =>
      actions.flatMap((action) => [false, true].map((launcher) => ({ phase, action, launcher, expected: run(() => l.checkAction(phase, action, launcher)) }))),
    ),
    totals: (() => {
      let t: l.LobbyTotals = { totalDeposits: 0n, depositors: 0 };
      return totalsOps.map((op) => {
        const r = run(() => {
          const res = op.op === "deposit" ? l.applyDeposit(t, op.wallet, op.amount, op.cap) : l.applyWithdraw(t, op.wallet, op.amount);
          t = res.totals;
          return { deposit: res.deposit, totals: res.totals };
        });
        return { ...op, expected: r };
      });
    })(),
    quotes: quoteCases.map(([name, s, amountIn, feeRate]) => ({ name, curve: curveJson(s), amountIn, feeRate, expected: run(() => l.quoteBuyExactIn(s, amountIn, feeRate)) })),
    caps: capCases.map(([name, s, supply, bps, feeRate]) => ({ name, curve: curveJson(s), supply, bps, feeRate, expected: run(() => l.capForSupplyBps(s, supply, bps, feeRate)) })),
    defaultCaps: { curve: genesis, supply: SUPPLY, feeRate: FEE, params: ok, expected: run(() => l.lobbyCaps(genesis, SUPPLY, ok, FEE)) },
    allocation: [
      allocationCase("spec §6.2: 40/30/20, R = 60, B = 5 901", [40n, 30n, 20n], 60n, 5_901n),
      allocationCase("undersubscribed: nothing refunded", [10n, 20n], 30n, 999n),
      allocationCase("single wallet", [7n], 3n, 10n),
      ...randomAllocations(),
    ],
    feeShares: [
      [100n, 1n, 3n],
      [10_000_000n, 40n, 90n],
      [100n, 4n, 3n],
    ].map(([fee, d, D]) => ({ fee, deposit: d, totalDeposits: D, expected: run(() => l.feeShare(fee!, d!, D!)) })),
    claimable: claimableCases.map(([tokens, finalizedAt, now, unlockSecs, already]) => ({
      tokens,
      finalizedAt,
      now,
      unlockSecs,
      alreadyClaimed: already,
      expected: run(() => l.claimable(tokens, finalizedAt, now, unlockSecs, already)),
    })),
  });
}
