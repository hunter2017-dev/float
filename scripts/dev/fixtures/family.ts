/**
 * Shared Coin Families vectors: inputs are listed here, expected outputs come
 * from the TypeScript SDK, and `crates/float-core/tests/family_vectors.rs`
 * checks that float-core produces the same results.
 *
 * Addresses are written as one byte `b` meaning the 32-byte key `[b; 32]`.
 * Big integers are strings. Every result is `{ "ok": value }` or `{ "err": "CoreErrorName" }`.
 */
import { PublicKey, families as f } from "@float-community/sdk";

type Result = { ok: unknown } | { err: string };

const key = (b: number) => new PublicKey(new Uint8Array(32).fill(b));
const run = (fn: () => unknown): Result => {
  try {
    const v = fn();
    return { ok: v === undefined ? true : v };
  } catch (e) {
    if (e instanceof f.FamilyError) return { err: e.code };
    throw e;
  }
};
const str = (v: unknown): unknown =>
  typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(str) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, str(x)])) : v;

const NOW = 1_800_000_000n;
const DAY = 86_400n;
const Q64 = f.Q64;

// --------------------------------------------------------------- eligibility

const P = { parentMinAgeSecs: 7n * DAY, parentMinPoolUsd: 100_000_000_000n, maxDepth: 2 };
const base: f.EligibilityInput = {
  kind: "Coin",
  isFloatCoin: true,
  graduatedAt: NOW - 7n * DAY,
  now: NOW,
  poolPairedUsd: 100_000_000_000n,
  pairedPaused: false,
  parentDepth: 0,
};
const eligibilityCases: [string, f.EligibilityParams, f.EligibilityInput][] = [
  ["eligible at exact bounds", P, base],
  ["flagship always eligible", P, { ...base, kind: "Flagship", isFloatCoin: false, graduatedAt: 0n, poolPairedUsd: 0n, pairedPaused: true, parentDepth: 9 }],
  ["not a float coin", P, { ...base, isFloatCoin: false }],
  ["not graduated", P, { ...base, graduatedAt: 0n }],
  ["one second too young", P, { ...base, graduatedAt: NOW - 7n * DAY + 1n }],
  ["graduation in the future", P, { ...base, graduatedAt: NOW + 10n }],
  ["pool one micro-dollar short", P, { ...base, poolPairedUsd: 99_999_999_999n }],
  ["paired asset paused", P, { ...base, pairedPaused: true }],
  ["depth 1 parent allowed", P, { ...base, parentDepth: 1 }],
  ["depth 2 parent too deep", P, { ...base, parentDepth: 2 }],
  ["first failing rule wins", P, { ...base, graduatedAt: 0n, poolPairedUsd: 0n, pairedPaused: true, parentDepth: 9 }],
  ["max_depth 0 is invalid", { ...P, maxDepth: 0 }, base],
  ["negative min age is invalid", { ...P, parentMinAgeSecs: -1n }, base],
  ["custom thresholds", { parentMinAgeSecs: 3n * DAY, parentMinPoolUsd: 5_000_000_000n, maxDepth: 3 }, { ...base, graduatedAt: NOW - 3n * DAY, poolPairedUsd: 5_000_000_000n, parentDepth: 2 }],
  ["age overflow", P, { ...base, graduatedAt: 1n, now: -(1n << 63n) }],
];

// ------------------------------------------------------------------- lineage

const lineageCases: [number, number, number[], number][] = [
  [2, 1, [], 2],
  [3, 2, [1], 2],
  [4, 3, [2, 1], 2],
  [4, 3, [2, 1], 3],
  [2, 2, [], 2],
  [2, 3, [2], 2],
  [4, 3, [3], 3],
  [4, 3, [2, 2], 3],
  [1, 2, [], 1],
  [1, 3, [2], 1],
];

const modeCases: [f.FamilyMode, number, number][] = [
  ["NativeQuote", 1, 1],
  ["NativeQuote", 2, 1],
  ["RewardLinked", 2, 1],
  ["RewardLinked", 1, 1],
];

// -------------------------------------------------------------------- routes

type H = [number, number, number];
const routeCases: [string, H[], number, number, number[]][] = [
  ["one hop", [[100, 1, 2]], 1, 2, [100, 101, 102]],
  ["two hops", [[100, 1, 2], [101, 2, 3]], 1, 3, [100, 101, 102]],
  ["three hops", [[100, 1, 2], [101, 2, 3], [102, 3, 4]], 1, 4, [100, 101, 102]],
  ["empty", [], 1, 4, [100]],
  ["four hops", [[100, 1, 2], [101, 2, 3], [102, 3, 5], [103, 5, 4]], 1, 4, [100, 101, 102, 103]],
  ["wrong start", [[100, 2, 4]], 1, 4, [100]],
  ["gap between hops", [[100, 1, 2], [101, 3, 4]], 1, 4, [100, 101]],
  ["wrong end", [[100, 1, 2]], 1, 4, [100]],
  ["self hop", [[100, 1, 1]], 1, 1, [100]],
  ["revisits the start", [[100, 1, 2], [101, 2, 1], [102, 1, 4]], 1, 4, [100, 101, 102]],
  ["revisits a middle mint", [[100, 1, 2], [101, 2, 3], [102, 3, 2]], 1, 2, [100, 101, 102]],
  ["pool reused", [[100, 1, 2], [100, 2, 4]], 1, 4, [100]],
  ["pool not pinned", [[100, 1, 2], [200, 2, 4]], 1, 4, [100, 101]],
  ["broken beats unpinned", [[200, 1, 3]], 1, 4, [100]],
];

const minOutCases: [bigint, bigint[], number][] = [
  [1_000_000n, [2n * Q64, Q64 / 2n, 3n * Q64], 200],
  [1_000n, [Q64 / 2n], 200],
  [1_000n, [Q64], 0],
  [3n, [Q64 / 3n], 0],
  [123_456_789n, [Q64 + 12_345n, (Q64 * 7n) / 9n], 150],
  [1_000n, [Q64], 10_000],
  [1_000n, [Q64], 10_001],
  [1n, [], 200],
  [1n, [Q64, Q64, Q64, Q64], 200],
  [(1n << 64n) - 1n, [2n * Q64], 0],
];

const feeA = { tradeFeeRate: 2_500n, creatorFeeRate: 0n, protocolFeeRate: 0n, fundFeeRate: 0n, creatorFeeOnInput: true };
const feeB = { tradeFeeRate: 2_500n, creatorFeeRate: 500n, protocolFeeRate: 120_000n, fundFeeRate: 40_000n, creatorFeeOnInput: false };
const maxHopCases: [bigint, bigint, f.HopFees, number][] = [
  [1_000_000_000n, 5_000_000_000n, feeA, 100],
  [2_000_000_000_000n, 50_000_000_000_000n, feeA, 100],
  [2_000_000_000_000n, 50_000_000_000_000n, feeB, 50],
  [7_777_777n, 3_333_333n, feeB, 300],
  [1n, 1n, feeA, 100],
  [0n, 5n, feeA, 100],
];

// -------------------------------------------------------------------- ledger

type Op = { op: "conversion"; amountIn: bigint; before: bigint; after: bigint } | { op: "payout"; total: bigint };
const ledgerCases: [string, f.ModeBLedger, Op[]][] = [
  [
    "credit received, then pay out",
    f.emptyLedger(1_000n),
    [
      { op: "conversion", amountIn: 600n, before: 10_000n, after: 10_495n },
      { op: "payout", total: 400n },
      { op: "conversion", amountIn: 400n, before: 10_095n, after: 10_500n },
      { op: "payout", total: 500n },
    ],
  ],
  [
    "errors leave the ledger untouched",
    { ...f.emptyLedger(100n), holdersUnpaidParent: 50n },
    [
      { op: "conversion", amountIn: 0n, before: 0n, after: 0n },
      { op: "conversion", amountIn: 101n, before: 0n, after: 10n },
      { op: "conversion", amountIn: 10n, before: 10n, after: 9n },
      { op: "payout", total: 51n },
      { op: "payout", total: 50n },
    ],
  ],
  ["overflow on credit", { ...f.emptyLedger(1n), holdersUnpaidParent: (1n << 64n) - 1n }, [{ op: "conversion", amountIn: 1n, before: 0n, after: 1n }]],
];

const demandCases: [string, bigint, number, number][] = [
  ["spec §7 example at 1 %: $350", 200_000_000_000n, 100, 1_750],
  ["spec §7 example at 0.75 %: $262.50", 200_000_000_000n, 75, 1_750],
  ["floors to the micro-dollar", 1n, 100, 1_750],
  ["u64 max at 100 %", (1n << 64n) - 1n, 10_000, 10_000],
  ["fee above 100 %", 1n, 10_001, 0],
  ["holders above 100 %", 1n, 0, 10_001],
];

// -------------------------------------------------------------------- output

export function buildFamilyVectors() {
  const hops = (hs: H[]) => hs.map(([pool, i, o]) => ({ pool: key(pool), inputMint: key(i), outputMint: key(o) }));
  return str({
    description: "Generated by scripts/dev/gen-fixtures.ts from scripts/dev/fixtures/family.ts. Do not edit by hand",
    spec: "docs/proposals/coin-families.md",
    eligibility: eligibilityCases.map(([name, params, input]) => ({ name, params, input, expected: run(() => f.checkParentEligibility(params, input)) })),
    lineage: lineageCases.map(([child, parent, ancestors, maxDepth]) => ({
      child,
      parent,
      ancestors,
      maxDepth,
      expected: run(() => f.validateLineage(key(child), key(parent), ancestors.map(key), maxDepth)),
    })),
    mode: modeCases.map(([mode, paired, parent]) => ({ mode, paired, parent, expected: run(() => f.checkMode(mode, key(paired), key(parent))) })),
    routes: routeCases.map(([name, hs, from, to, pinned]) => ({
      name,
      hops: hs,
      from,
      to,
      pinned,
      expected: run(() => f.validateRoute(hops(hs), key(from), key(to), pinned.map(key))),
    })),
    minOuts: minOutCases.map(([amountIn, prices, guardBps]) => ({ amountIn, prices, guardBps, expected: run(() => f.routeMinOuts(amountIn, prices, guardBps)) })),
    maxHopInput: maxHopCases.map(([inputReserve, outputReserve, fees, maxImpactBps]) => ({
      inputReserve,
      outputReserve,
      fees,
      maxImpactBps,
      expected: run(() => f.maxHopInput(inputReserve, outputReserve, fees, maxImpactBps)),
    })),
    ledger: ledgerCases.map(([name, start, ops]) => {
      let l = start;
      const results = ops.map((op) =>
        run(() => {
          if (op.op === "payout") {
            l = f.recordPayout(l, op.total);
            return { ledger: l };
          }
          const r = f.recordConversion(l, op.amountIn, op.before, op.after);
          l = r.ledger;
          return { ledger: l, received: r.received };
        }),
      );
      return { name, start, ops, expected: results };
    }),
    dailyDemand: demandCases.map(([name, volumeUsd, feeBps, holdersBps]) => ({
      name,
      volumeUsd,
      feeBps,
      holdersBps,
      expected: run(() => f.dailyParentDemand(volumeUsd, feeBps, holdersBps)),
    })),
  });
}
