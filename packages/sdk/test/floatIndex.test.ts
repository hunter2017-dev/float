import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair, MINTS, PublicKey, TOKEN_PROGRAM_ID, cpmm, floatIndex as x } from "../src/index.ts";
import { buildIndexVectors } from "../../../scripts/dev/fixtures/index.ts";

const FIXTURE = fileURLToPath(new URL("../../../crates/float-core/tests/fixtures/index-vectors.json", import.meta.url));
const key = (b: number) => new PublicKey(new Uint8Array(32).fill(b));
const Q64 = 1n << 64n;
const code = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    if (e instanceof x.IndexError) return e.code;
    throw e;
  }
};

test("committed index vectors are up to date (run node scripts/dev/gen-fixtures.ts)", () => {
  assert.deepEqual(JSON.parse(readFileSync(FIXTURE, "utf8")), JSON.parse(JSON.stringify(buildIndexVectors())));
});

test("spec §4 vector: q_old [1000, 500, 200], S = 100, q_new [100, 52, 19] → 9 shares, nobody diluted", () => {
  const s = x.creationShares(100n, [1_000n, 500n, 200n], [100n, 52n, 19n], 0n);
  assert.equal(s, 9n);
  for (const [o, n] of [[1_000n, 100n], [500n, 52n], [200n, 19n]] as const) assert.ok(o * (100n + s) <= (o + n) * 100n);
  // Surplus over an exactly proportional purchase stays in the vault.
  assert.deepEqual([1_000n, 500n, 200n].map((o, i) => [100n, 52n, 19n][i]! - (o * s) / 100n), [10n, 7n, 1n]);
});

test("target weights: √mcap, iterative capping, ties by mint", () => {
  const c = (b: number, mcap: bigint, liq = 10_000) => ({ mint: key(b), mcap, liqCapBps: liq });
  assert.deepEqual(x.targetWeights([c(3, 100n), c(1, 100n), c(2, 100n)], 10_000), [3_333, 3_334, 3_333]);
  assert.deepEqual(x.targetWeights([c(1, 160_000n), c(2, 90_000n), c(3, 40_000n), c(4, 10_000n)], 3_500), [3_500, 3_251, 2_166, 1_083]);
  assert.equal(code(() => x.targetWeights([1, 2, 3, 4, 5, 6].map((b) => c(b, 100n)), 1_500)), "InfeasibleCaps");
  assert.equal(x.liquidityCapBps(500_000n, 1_000_000n, 1_000), 500);
});

test("redemption, rewards, drift and rebalance mirror float-core", () => {
  assert.deepEqual(x.redeemAmounts([1_100n, 552n, 219n], 10n, 109n), [100n, 50n, 20n]);
  assert.equal(x.rewardAvailable(150n, 100n), 50n);
  assert.equal(code(() => x.rewardAvailable(99n, 100n)), "TrackedExceedsBalance");
  assert.deepEqual(x.driftBps([500n, 300n, 200n], [Q64, Q64, Q64], [4_000, 4_000, 2_000]), [1_000, -1_000, 0]);
  assert.deepEqual(x.rebalancePlan([500n, 300n, 200n], [Q64, Q64, Q64], [4_000, 4_000, 2_000], 200, 1_000), [
    { sell: 50n, buy: 0n },
    { sell: 0n, buy: 50n },
    { sell: 0n, buy: 0n },
  ]);
});

const ammConfig = Keypair.generate().publicKey;
function pool(coin: PublicKey, coinReserve: bigint, solReserve: bigint): cpmm.CpmmPoolBundle {
  const [m0, m1] = cpmm.sortMints(coin, MINTS.WSOL);
  const coinIs0 = m0.equals(coin);
  return {
    address: cpmm.cpmmPda.pool(ammConfig, m0, m1),
    pool: {
      token_0_mint: m0, token_1_mint: m1, token_0_program: TOKEN_PROGRAM_ID, token_1_program: TOKEN_PROGRAM_ID,
      protocol_fees_token_0: 0n, protocol_fees_token_1: 0n, fund_fees_token_0: 0n, fund_fees_token_1: 0n,
      creator_fees_token_0: 0n, creator_fees_token_1: 0n, creator_fee_on: 0, enable_creator_fee: false, status: 0, open_time: 0n,
    } as unknown as cpmm.CpmmPool,
    config: { trade_fee_rate: 2_500n, protocol_fee_rate: 0n, fund_fee_rate: 0n, creator_fee_rate: 0n } as unknown as cpmm.CpmmAmmConfig,
    vault0: coinIs0 ? coinReserve : solReserve,
    vault1: coinIs0 ? solReserve : coinReserve,
  };
}

test("planRebalance: quantities from the core plan, impact on each coin's pool", () => {
  const [a, b] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const comps: x.RebalanceComponent[] = [
    { mint: a, quantity: 600_000_000n, decimals: 6, priceUsd: 1, targetBps: 5_000, pool: pool(a, 1_000_000_000_000n, 6_666_000_000_000n) },
    { mint: b, quantity: 400_000_000n, decimals: 6, priceUsd: 1, targetBps: 5_000, pool: pool(b, 1_000_000_000_000n, 6_666_000_000_000n) },
  ];
  const plan = x.planRebalance(comps, 200, 10_000);
  assert.deepEqual(plan.map((t) => [t.driftBps, t.sell, t.buy]), [[1_000, 100_000_000n, 0n], [-1_000, 0n, 100_000_000n]]);
  assert.ok(plan.every((t) => t.priceImpact !== null && t.priceImpact > 0 && t.priceImpact < 0.001));
  const nav = x.estimateNav(comps, 1_000_000_000n);
  assert.equal(nav.navUsd, 1_000);
  assert.equal(nav.perShareUsd, 1_000);
});

test("computeMethodology explains exclusions and simulateIndex passes rewards through", () => {
  const mk = (b: number, fees: number, extra: Partial<x.IndexCoin> = {}): x.IndexCoin => {
    const mint = key(b);
    return {
      mint, pairedMint: MINTS.WSOL, fees30dUsd: fees, isFloatCoin: true, isFlagship: false, graduatedAt: 1n, operatorPaused: false, swapsPaused: false,
      launchLabPool: key(200 + b), cpmmPool: pool(mint, 100_000_000_000n, 1_000_000_000_000n), supply: 1_000_000_000_000_000n, coinDecimals: 6, pairedDecimals: 9,
      coinReserve: 100_000_000_000n, pairedReserve: 1_000_000_000_000n, priceUsd: 1.5, mcapUsd: 1.5e9 / b, poolPairedUsd: 150_000, ...extra,
    };
  };
  const coins = [1, 2, 3, 4, 5, 6, 7].map((b) => mk(b, 10_000 * b));
  coins.push(mk(8, 1_000, { operatorPaused: true, pausedReason: "issuer pause" }), mk(9, 1_000, { isFloatCoin: false }), mk(10, 0));
  const m = x.computeMethodology(coins, { now: 30n * 86_400n });
  assert.equal(m.basket.length, 7);
  assert.equal(m.basket.reduce((s, b) => s + b.weightBps, 0), 10_000);
  const why = (b: number) => m.rows.find((r) => r.mint.equals(key(b)))!.reason;
  assert.equal(why(8), "paused by operator: issuer pause");
  assert.equal(why(9), "not on Float's LaunchLab platform config");
  assert.equal(why(10), "no 30-day fees in stats.json");
  assert.match(why(7), /top 10 by 30-day fees \(#1\)/);

  const byMint = new Map(coins.map((c) => [c.mint.toBase58(), c]));
  const sim = x.simulateIndex({ depositSol: 10, days: 30, solUsd: 150, basket: m.basket.map((b) => ({ ...b, coin: byMint.get(b.mint.toBase58())! })) });
  assert.equal(sim.feeSol, 0.05);
  assert.equal(sim.genesisShares, 9_950_000_000n);
  const r0 = sim.rows[0]!;
  // Holder rewards: fees/30 × 17.5 % × coins bought / (supply − pool reserve).
  const c0 = byMint.get(r0.mint.toBase58())!;
  assert.ok(Math.abs(r0.rewardsUsdPerDay - (c0.fees30dUsd / 30) * 0.175 * r0.holderShare) < 1e-12);
  assert.ok(sim.redeemUsd < 9.95 * 150 && sim.redeemUsd > 9.95 * 150 * 0.98);
  assert.equal(sim.disclaimer, x.SIMULATION_DISCLAIMER);
});

test("planFidxPayout reuses computePayoutRound and skips excluded owners", () => {
  const h = (owner: string, balance: bigint, hasTokenAccount = true) => ({ owner, balance, previousBalance: balance, carried: 0n, hasTokenAccount });
  const r = x.planFidxPayout({ available: 1_000n, holders: [h("alice", 3n), h("bob", 1n), h("fidx-pool", 4n)], usdPerUnit: 1, exclude: ["fidx-pool"] });
  assert.deepEqual(r.lines.map((l) => [l.owner, l.pay]), [["alice", 750n], ["bob", 250n]]);
});

test("parseIndexStats validates the documented format", () => {
  assert.throws(() => x.parseIndexStats({}), /coins array/);
  assert.throws(() => x.parseIndexStats({ coins: [{ mint: Keypair.generate().publicKey.toBase58(), fees30dUsd: -1 }] }), /fees30dUsd/);
  const ok = x.parseIndexStats({ coins: [{ mint: Keypair.generate().publicKey.toBase58(), fees30dUsd: 5 }] });
  assert.equal(ok.coins.length, 1);
});
