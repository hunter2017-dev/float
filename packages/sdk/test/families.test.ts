import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, cpmm, families as f, launchLab } from "../src/index.ts";
import { buildFamilyVectors } from "../../../scripts/dev/fixtures/family.ts";

const FIXTURE = fileURLToPath(new URL("../../../crates/float-core/tests/fixtures/family-vectors.json", import.meta.url));
const key = (b: number) => new PublicKey(new Uint8Array(32).fill(b));
const code = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    if (e instanceof f.FamilyError) return e.code;
    throw e;
  }
};

// ------------------------------------------------------------ shared vectors

test("committed family vectors are up to date (run node scripts/dev/gen-fixtures.ts)", () => {
  const committed = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(committed, JSON.parse(JSON.stringify(buildFamilyVectors())));
});

test("spec §7 worked examples: $262.50/day at 0.75 %, $350/day at 1 %", () => {
  assert.equal(f.dailyParentDemand(200_000n * f.MICRO_USD, 75, 1_750), 262_500_000n);
  assert.equal(f.dailyParentDemand(200_000n * f.MICRO_USD, 100, 1_750), 350n * f.MICRO_USD);
  const sim = f.simulateFamily({ children: 1, dailyVolumeUsd: 200_000, feeBps: 100, holdersBps: 1_750, parentPriceUsd: 2, days: 1 });
  assert.equal(sim.days[0]!.holderRewardsUsd, 350);
  assert.equal(sim.days[0]!.parentBuyUsd, 350);
  assert.equal(sim.days[0]!.parentBought, 175);
});

// ----------------------------------------------------------------- rules

const NOW = 1_800_000_000n;
const eligible: f.EligibilityInput = {
  kind: "Coin",
  isFloatCoin: true,
  graduatedAt: NOW - f.DEFAULT_PARENT_MIN_AGE_SECS,
  now: NOW,
  poolPairedUsd: f.DEFAULT_PARENT_MIN_POOL_USD,
  pairedPaused: false,
  parentDepth: 0,
};

test("eligibility: one error code per rule, in spec order", () => {
  const p = f.DEFAULT_ELIGIBILITY_PARAMS;
  assert.equal(code(() => f.checkParentEligibility(p, eligible)), "ok");
  assert.equal(code(() => f.checkParentEligibility(p, { ...eligible, isFloatCoin: false })), "ParentNotFloatCoin");
  assert.equal(code(() => f.checkParentEligibility(p, { ...eligible, graduatedAt: 0n })), "ParentNotGraduated");
  assert.equal(code(() => f.checkParentEligibility(p, { ...eligible, graduatedAt: eligible.graduatedAt + 1n })), "ParentTooYoung");
  assert.equal(code(() => f.checkParentEligibility(p, { ...eligible, poolPairedUsd: 1n })), "ParentPoolTooThin");
  assert.equal(code(() => f.checkParentEligibility(p, { ...eligible, pairedPaused: true })), "ParentPaused");
  assert.equal(code(() => f.checkParentEligibility(p, { ...eligible, parentDepth: 2 })), "FamilyTooDeep");
  assert.equal(code(() => f.checkParentEligibility(p, { ...eligible, kind: "Flagship", isFloatCoin: false, graduatedAt: 0n })), "ok");
});

test("explainEligibility marks every failing rule", () => {
  const rows = f.explainEligibility(f.DEFAULT_ELIGIBILITY_PARAMS, { ...eligible, poolPairedUsd: 1n, pairedPaused: true });
  assert.deepEqual(rows.filter((r) => !r.ok).map((r) => r.rule), ["liquidity", "not paused"]);
});

test("lineage, mode and route rules", () => {
  assert.equal(f.validateLineage(key(3), key(2), [key(1)], 2), 2);
  assert.equal(code(() => f.validateLineage(key(1), key(2), [key(1)], 3)), "FamilyCycle");
  assert.equal(code(() => f.checkMode("NativeQuote", key(5), key(6))), "FamilyModeMismatch");
  const hops = [
    { pool: key(100), inputMint: key(1), outputMint: key(2) },
    { pool: key(101), inputMint: key(2), outputMint: key(3) },
  ];
  assert.equal(code(() => f.validateRoute(hops, key(1), key(3), [key(100), key(101)])), "ok");
  assert.equal(code(() => f.validateRoute(hops, key(1), key(3), [key(100)])), "RoutePoolNotPinned");
  assert.deepEqual(f.routeMinOuts(1_000_000n, [2n * f.Q64, f.Q64 / 2n, 3n * f.Q64], 200), [1_960_000n, 960_400n, 2_823_576n]);
});

test("Mode B ledger credits what the vault received (Token-2022 fee included)", () => {
  const { ledger, received } = f.recordConversion(f.emptyLedger(1_000n), 600n, 10_000n, 10_495n);
  assert.equal(received, 495n);
  assert.equal(ledger.holdersUnpaidParent, 495n);
  assert.equal(code(() => f.recordPayout(ledger, 496n)), "ExceedsUnpaid");
  assert.equal(f.recordPayout(ledger, 495n).holdersUnpaidParent, 0n);
  assert.equal(f.parentVaultSolvent(495n, [ledger.holdersUnpaidParent]), true);
  assert.equal(f.parentVaultSolvent(494n, [ledger.holdersUnpaidParent]), false);
});

// ---------------------------------------------------------- route planning

const ammConfig = Keypair.generate().publicKey;
function bundle(mintA: PublicKey, mintB: PublicKey, reserveA: bigint, reserveB: bigint): cpmm.CpmmPoolBundle {
  const [m0, m1] = cpmm.sortMints(mintA, mintB);
  const aIs0 = m0.equals(mintA);
  return {
    address: cpmm.cpmmPda.pool(ammConfig, m0, m1),
    pool: {
      token_0_mint: m0, token_1_mint: m1, token_0_program: TOKEN_PROGRAM_ID, token_1_program: TOKEN_PROGRAM_ID,
      protocol_fees_token_0: 0n, protocol_fees_token_1: 0n, fund_fees_token_0: 0n, fund_fees_token_1: 0n,
      creator_fees_token_0: 0n, creator_fees_token_1: 0n, creator_fee_on: 0, enable_creator_fee: false,
      status: 0, open_time: 0n, mint_0_decimals: 6, mint_1_decimals: 6,
    } as unknown as cpmm.CpmmPool,
    config: { trade_fee_rate: 2_500n, protocol_fee_rate: 120_000n, fund_fee_rate: 40_000n, creator_fee_rate: 0n } as unknown as cpmm.CpmmAmmConfig,
    vault0: aIs0 ? reserveA : reserveB,
    vault1: aIs0 ? reserveB : reserveA,
  };
}

test("planRoute: best route through pinned pools only, quoted hop by hop", () => {
  const [usdc, sol, parent, other] = [key(10), key(11), key(12), key(13)];
  const usdcSol = bundle(usdc, sol, 15_000_000_000_000n, 100_000_000_000n); // 150 USDC/SOL
  const solParent = bundle(sol, parent, 1_000_000_000_000n, 500_000_000_000_000n); // 500 parent/SOL
  const usdcParent = bundle(usdc, parent, 1_000_000_000n, 1_000_000_000n); // tiny, bad direct pool

  const plan = f.planRoute([usdcSol, solParent, usdcParent], usdc, parent, 1_000_000_000n)!;
  assert.equal(plan.hops.length, 2);
  assert.ok(plan.hops[0]!.inputMint.equals(usdc) && plan.hops[1]!.outputMint.equals(parent));
  assert.equal(plan.hops[1]!.amountIn, plan.hops[0]!.amountOut);
  const q1 = cpmm.quoteCpmmSwap(usdcSol, usdc, 1_000_000_000n).outputAmount;
  assert.equal(plan.hops[0]!.amountOut, q1);
  assert.equal(plan.amountOut, cpmm.quoteCpmmSwap(solParent, sol, q1).outputAmount);
  assert.deepEqual(plan.minOuts, f.routeMinOuts(1_000_000_000n, plan.hops.map((h) => h.referencePriceQ64), 200));
  assert.ok(plan.minOuts[1]! <= plan.amountOut);
  assert.equal(plan.withinImpact, true);

  assert.equal(f.planRoute([usdcSol], usdc, other, 1_000n), null);
  assert.equal(f.planRoute([usdcSol, solParent], usdc, parent, 1_000n, { maxHops: 1 }), null);
  const big = f.planRoute([usdcSol, solParent], usdc, parent, 2_000_000_000_000n)!;
  assert.equal(big.withinImpact, false);
});

// ------------------------------------------------------- Mode A curve sizing

test("constantCurveVirtualReserves reproduces a real LaunchLab default pool", () => {
  const r = launchLab.constantCurveVirtualReserves({ supply: 1_000_000_000_000_000n, totalBaseSell: 793_100_000_000_000n, totalQuoteFundRaising: 85_000_000_000n });
  assert.equal(r.virtualBase, 1_073_025_605_596_382n);
  assert.equal(r.virtualQuote, 30_000_852_951n);
});

test("curveParamsForTargetUsd hits the official $20k start and $150k graduation", () => {
  for (const [price, decimals] of [[0.02, 6], [150, 9], [0.000_04, 6]] as const) {
    const r = f.curveParamsForTargetUsd(price, { parentDecimals: decimals });
    assert.ok(Math.abs(r.startMcapUsd / 20_000 - 1) < 1e-3, `start ${r.startMcapUsd} at $${price}`);
    assert.ok(Math.abs(r.graduationMcapUsd / 150_000 - 1) < 1e-3, `graduation ${r.graduationMcapUsd} at $${price}`);
    assert.equal(r.supply, 1_000_000_000_000_000n);
    assert.ok(r.totalBaseSell < r.supply);
  }
  assert.throws(() => f.curveParamsForTargetUsd(0, { parentDecimals: 6 }), RangeError);
  assert.throws(() => f.curveParamsForTargetUsd(1, { parentDecimals: 6, startMcapUsd: 10, graduationMcapUsd: 5 }), RangeError);
});

// -------------------------------------------------------------- simulator

test("simulateFamily: Mode B impact, decay and Mode A locked supply", () => {
  const pool: f.ParentPoolState = {
    parentReserve: 10_000_000_000n, pairedReserve: 1_000_000_000_000n, parentDecimals: 6, pairedDecimals: 9, pairedPriceUsd: 100,
    fees: { tradeFeeRate: 2_500n, creatorFeeRate: 0n, protocolFeeRate: 0n, fundFeeRate: 0n, creatorFeeOnInput: true },
  };
  const b = f.simulateFamily({ children: 5, dailyVolumeUsd: 200_000, days: 3, volumeDecay: 0.5, parentPool: pool });
  assert.equal(b.parentPriceUsd, 10); // 1 000 paired × $100 / 10 000 parent
  assert.deepEqual(b.days.map((d) => d.holderRewardsUsd), [1_312.5, 656.25, 328.125]); // 5 × V × 0.75 % × 17.5 %
  assert.ok(b.days[0]!.priceImpact! > b.days[1]!.priceImpact!);
  const cap = f.maxHopInput(pool.pairedReserve, pool.parentReserve, pool.fees, 100);
  for (const d of b.days) {
    const pairedIn = BigInt(Math.round((d.parentBuyUsd / 100) * 1e9));
    assert.equal(d.swapsWithinCap, Number((pairedIn + cap - 1n) / cap));
  }
  assert.deepEqual(b.days.map((d) => d.swapsWithinCap), [3, 2, 1]);
  assert.equal(b.disclaimer, f.SIMULATION_DISCLAIMER);

  const a = f.simulateFamily({ mode: "A", children: 4, dailyVolumeUsd: 100_000, days: 1, parentPriceUsd: 1, netInflowBps: 500, graduationProbability: 0.25, lockedPerGraduationUsd: 40_000 });
  assert.equal(a.days[0]!.parentBuyUsd, 20_000);
  assert.equal(a.lockedParentUsd, 40_000);
  assert.equal(a.lockedParent, 40_000);
  assert.throws(() => f.simulateFamily({ children: 1, dailyVolumeUsd: 1 }), RangeError);
});

// ----------------------------------------------------------- observation

test("isMintPaused reads the Token-2022 Pausable extension", () => {
  const mint = (paused: number) => {
    const d = new Uint8Array(166 + 4 + 33);
    d[165] = 1; // AccountType::Mint
    d.set([26, 0, 33, 0], 166);
    d[166 + 4 + 32] = paused;
    return d;
  };
  assert.equal(f.isMintPaused(mint(1), TOKEN_2022_PROGRAM_ID), true);
  assert.equal(f.isMintPaused(mint(0), TOKEN_2022_PROGRAM_ID), false);
  assert.equal(f.isMintPaused(mint(1), TOKEN_PROGRAM_ID), false);
  assert.equal(f.isMintPaused(new Uint8Array(82), TOKEN_2022_PROGRAM_ID), false);
});
