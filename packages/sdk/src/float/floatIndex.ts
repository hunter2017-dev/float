/**
 * Float Index (docs/proposals/float-index.md): FIDX, one token over the top
 * graduated Float coins that passes their holder rewards through.
 *
 * - Math: exact mirror of `float-core::index` (weights, creation, redemption,
 *   rewards, drift, rebalance plan). Shared vectors in
 *   `crates/float-core/tests/fixtures/index-vectors.json`.
 * - Methodology from chain data (LaunchLab platform config, graduation, CPMM
 *   reserves, market cap) plus a `stats.json` for 30-day fees until an
 *   indexer exists (format: {@link IndexStats}).
 * - NAV estimate (display only), rebalance plan with impact per swap,
 *   creation/redemption simulator, FIDX holder payouts via `computePayoutRound`.
 *
 * Not an official Float feature.
 */

import { encodeBase58 } from "../core/base58.ts";
import { PublicKey } from "../core/pubkey.ts";
import type { Connection } from "../core/rpc.ts";
import { FLOAT, MINTS } from "../programs/addresses.ts";
import * as cpmm from "../raydium/cpmm.ts";
import * as launchLab from "../raydium/launchlab.ts";
import { isqrt } from "../raydium/math.ts";
import { type HolderState, type PayoutRoundResult, computePayoutRound } from "./holders.ts";

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const FULL = 10_000;

export const MAX_COMPONENTS = 10;
export const DEFAULT_N = 10;
export const DEFAULT_CAP_BPS = 1_500;
export const DEFAULT_LIQ_FACTOR_BPS = 1_000;
export const DEFAULT_BAND_BPS = 200;
export const DEFAULT_TURNOVER_BPS = 3_000;
export const DEFAULT_MIN_POOL_PAIRED_USD = 50_000;
export const DEFAULT_MIN_AGE_SECS = 7 * 86_400;
/** Proposed creation fee: 50 bps to the $FLOAT buyback vault (spec §10, a proposal). */
export const DEFAULT_CREATION_FEE_BPS = 50;
/** Holders' share of the split for standard coins: 17.5 % (https://www.floatlaunch.xyz/docs, Fees). */
export const OFFICIAL_HOLDERS_BPS = 1_750;

export const SIMULATION_DISCLAIMER =
  "Scenarios, not forecasts: figures assume today's reserves, prices and 30-day fees stay the same and that " +
  "Float's payout bot pays program-owned holders (spec §6 Assumption, unconfirmed). Float Index is a community " +
  "proposal, not an official Float feature.";

// ------------------------------------------------------------------ errors

/** Same names as the matching `float_core::CoreError` variants. */
export type IndexErrorCode = "MathOverflow" | "InvalidParams" | "InfeasibleCaps" | "TrackedExceedsBalance";

export class IndexError extends Error {
  readonly code: IndexErrorCode;
  constructor(code: IndexErrorCode, message?: string) {
    super(message ?? code);
    this.name = "IndexError";
    this.code = code;
  }
}

const fail = (code: IndexErrorCode, message?: string): never => {
  throw new IndexError(code, message);
};

function u64(x: bigint, what: string): bigint {
  if (x < 0n || x > U64_MAX) throw new RangeError(`${what} must fit in a u64`);
  return x;
}

// ------------------------------------------------------------------ weights

/** Mirror of `liquidity_cap_bps`. */
export function liquidityCapBps(poolPairedUsd: bigint, aumUsd: bigint, liqFactorBps: number): number {
  if (aumUsd === 0n) return FULL;
  const v = (BigInt(liqFactorBps) * u64(poolPairedUsd, "poolPairedUsd")) / u64(aumUsd, "aumUsd");
  return v > BigInt(FULL) ? FULL : Number(v);
}

export interface WeightInput {
  mint: PublicKey;
  mcap: bigint;
  liqCapBps: number;
}

function largest(c: WeightInput[], raw: bigint[], members: number[]): number | undefined {
  let best: number | undefined;
  for (const i of members) {
    if (best === undefined || raw[i]! > raw[best]! || (raw[i] === raw[best] && c[i]!.mint.compare(c[best]!.mint) < 0)) best = i;
  }
  return best;
}

/** Mirror of `target_weights`: bps per candidate in input order, summing to 10 000. */
export function targetWeights(candidates: WeightInput[], capBps: number): number[] {
  const n = candidates.length;
  if (n === 0 || n > MAX_COMPONENTS) fail("InvalidParams", `Need 1-${MAX_COMPONENTS} candidates`);
  candidates.forEach((c, i) => {
    if (candidates.slice(0, i).some((d) => d.mint.equals(c.mint))) fail("InvalidParams", "Duplicate mint");
  });
  const raw = candidates.map((c) => isqrt(u64(c.mcap, "mcap")));
  const cap = candidates.map((c) => Math.min(capBps, c.liqCapBps, FULL));
  const total = raw.reduce((a, b) => a + b, 0n);
  if (total === 0n) fail("InvalidParams", "Every candidate has a zero market cap");
  if (cap.reduce((a, b) => a + b, 0) < FULL) fail("InfeasibleCaps", "Caps cannot add up to 100 %: lower N or raise the caps");

  const w = raw.map((r) => Number((BigInt(FULL) * r) / total));
  const all = [...Array(n).keys()];
  w[largest(candidates, raw, all)!]! += FULL - w.reduce((a, b) => a + b, 0);
  const pinned = new Array<boolean>(n).fill(false);
  for (let pass = 0; pass <= n; pass++) {
    let excess = 0;
    for (let i = 0; i < n; i++) {
      if (w[i]! > cap[i]!) {
        excess += w[i]! - cap[i]!;
        w[i] = cap[i]!;
        pinned[i] = true;
      }
    }
    if (excess === 0) return w;
    const free = all.filter((i) => !pinned[i]);
    const freeRaw = free.reduce((a, i) => a + raw[i]!, 0n);
    const top = largest(candidates, raw, free);
    if (top === undefined) fail("InfeasibleCaps");
    let spread = 0;
    for (const i of free) {
      const add = freeRaw === 0n ? 0 : Number((BigInt(excess) * raw[i]!) / freeRaw);
      w[i]! += add;
      spread += add;
    }
    w[top!]! += excess - spread;
  }
  return fail("InfeasibleCaps");
}

// ------------------------------------------------- creation and redemption

/** Mirror of `creation_shares`. */
export function creationShares(supply: bigint, qOld: bigint[], qNew: bigint[], tNet: bigint): bigint {
  if (u64(supply, "supply") === 0n) return u64(tNet, "tNet");
  if (qOld.length !== qNew.length || qOld.length === 0) fail("InvalidParams");
  let shares = U64_MAX;
  qOld.forEach((o, j) => {
    if (u64(o, "qOld") === 0n) fail("InvalidParams", "A held quantity is 0");
    const s = (supply * u64(qNew[j]!, "qNew")) / o;
    if (s < shares) shares = s;
  });
  return shares;
}

/** Mirror of `ticket_shares`. */
export function ticketShares(epochShares: bigint, ticket: bigint, epochTotal: bigint): bigint {
  if (epochTotal === 0n || ticket > epochTotal) fail("InvalidParams");
  return (u64(epochShares, "epochShares") * ticket) / epochTotal;
}

/** Mirror of `redeem_amounts`. */
export function redeemAmounts(quantities: bigint[], x: bigint, supply: bigint): bigint[] {
  if (supply === 0n || x > supply) fail("InvalidParams");
  return quantities.map((q) => (u64(q, "quantity") * x) / supply);
}

/** Mirror of `reward_available`. */
export const rewardAvailable = (balance: bigint, tracked: bigint): bigint => (tracked > balance ? fail("TrackedExceedsBalance") : balance - tracked);

// ---------------------------------------------------------------- rebalance

function value(q: bigint, priceQ64: bigint): bigint {
  const v = u64(q, "quantity") * priceQ64;
  return v > U128_MAX ? fail("MathOverflow") : v >> 64n;
}

function checkLengths(q: bigint[], prices: bigint[], targets: number[]) {
  if (q.length === 0 || q.length > MAX_COMPONENTS || q.length !== prices.length || q.length !== targets.length) fail("InvalidParams");
  if (targets.reduce((a, b) => a + b, 0) !== FULL || prices.some((p) => p === 0n)) fail("InvalidParams");
  for (const p of prices) if (p < 0n || p > U128_MAX) throw new RangeError("prices must fit in a u128");
}

/** Mirror of `drift_bps`: current weight minus target, per component. */
export function driftBps(quantities: bigint[], pricesQ64: bigint[], targetsBps: number[]): number[] {
  checkLengths(quantities, pricesQ64, targetsBps);
  const values = quantities.map((q, i) => value(q, pricesQ64[i]!));
  const total = values.reduce((a, b) => a + b, 0n);
  if (total > U128_MAX) fail("MathOverflow");
  if (total === 0n) fail("InvalidParams", "Empty vault");
  return values.map((v, i) => {
    if (v * BigInt(FULL) > U128_MAX) fail("MathOverflow");
    return Number((v * BigInt(FULL)) / total) - targetsBps[i]!;
  });
}

export interface RebalanceLeg {
  sell: bigint;
  buy: bigint;
}

/** Mirror of `rebalance_plan` (buys funded by sells; turnover cap on sells). */
export function rebalancePlan(quantities: bigint[], pricesQ64: bigint[], targetsBps: number[], bandBps: number, turnoverBps: number): RebalanceLeg[] {
  if (turnoverBps > FULL) fail("InvalidParams");
  const drift = driftBps(quantities, pricesQ64, targetsBps);
  const total = quantities.reduce((a, q, i) => a + value(q, pricesQ64[i]!), 0n);
  let sellValue = 0n;
  let buyValue = 0n;
  const legs = quantities.map((q, i): RebalanceLeg => {
    if (Math.abs(drift[i]!) <= bandBps) return { sell: 0n, buy: 0n };
    const targetValue = (total * BigInt(targetsBps[i]!)) / BigInt(FULL);
    const scaled = targetValue << 64n;
    if (scaled > U128_MAX) fail("MathOverflow");
    const targetQ = scaled / pricesQ64[i]!;
    if (targetQ > U64_MAX) fail("MathOverflow");
    if (targetQ < q) {
      const maxSell = (q * BigInt(turnoverBps)) / BigInt(FULL);
      const sell = q - targetQ < maxSell ? q - targetQ : maxSell;
      sellValue += value(sell, pricesQ64[i]!);
      return { sell, buy: 0n };
    }
    const buy = targetQ - q;
    buyValue += value(buy, pricesQ64[i]!);
    if (buyValue > U128_MAX) fail("MathOverflow");
    return { sell: 0n, buy };
  });
  if (buyValue > sellValue) {
    for (const leg of legs) {
      if (leg.buy * sellValue > U128_MAX) fail("MathOverflow");
      leg.buy = (leg.buy * sellValue) / buyValue;
    }
  }
  return legs;
}

/** Micro-USD per raw unit as Q64.64, the common value unit for drift and rebalance. */
export function usdPriceQ64(usdPerRawUnit: number): bigint {
  if (!(usdPerRawUnit > 0)) throw new RangeError("price must be > 0");
  const microQ64 = BigInt(Math.round(usdPerRawUnit * 1e6 * 2 ** 32)) << 32n;
  return microQ64 === 0n ? 1n : microQ64;
}

// --------------------------------------------------------------- 30-day fees

/**
 * `stats.json`: the inputs the chain cannot provide yet (no indexer).
 *
 * ```json
 * {
 *   "asOf": "2026-11-25T00:00:00Z",
 *   "windowDays": 30,
 *   "platformConfig": "<Float's LaunchLab platform config>",
 *   "prices": { "SOL": 150, "USDC": 1, "<paired mint>": 182.4 },
 *   "coins": [
 *     { "mint": "<coin mint>", "pair": "SOL", "fees30dUsd": 125000,
 *       "paused": false, "pausedReason": "" }
 *   ]
 * }
 * ```
 *
 * - `fees30dUsd`: USD value of the coin's fees that went through Float's split
 *   in the window (sum of `FeesCycled.amount`, or `CoinRecord.total_cycled`
 *   deltas, priced at the time of each cycle).
 * - `pair`: `SOL`, `USDC` or the paired mint (default `SOL`).
 * - `prices`: USD per whole paired token, keyed by symbol or mint (`USDC` defaults to 1).
 * - `paused`: the operator flag of spec §3.1, with a public `pausedReason`.
 */
export interface IndexStats {
  asOf?: string;
  windowDays?: number;
  platformConfig?: string;
  prices?: Record<string, number>;
  coins: { mint: string; pair?: string; fees30dUsd: number; paused?: boolean; pausedReason?: string }[];
}

export function parseIndexStats(raw: unknown): IndexStats {
  const s = raw as IndexStats;
  if (!s || typeof s !== "object" || !Array.isArray(s.coins)) throw new Error("stats.json: expected an object with a coins array");
  s.coins.forEach((c, i) => {
    if (typeof c.mint !== "string") throw new Error(`stats.json: coins[${i}].mint must be a string`);
    new PublicKey(c.mint);
    if (typeof c.fees30dUsd !== "number" || !(c.fees30dUsd >= 0)) throw new Error(`stats.json: coins[${i}].fees30dUsd must be a number >= 0`);
  });
  return s;
}

const resolvePair = (p?: string): PublicKey => (!p || p.toUpperCase() === "SOL" || p.toUpperCase() === "WSOL" ? MINTS.WSOL : p.toUpperCase() === "USDC" ? MINTS.USDC : new PublicKey(p));

function pairedUsd(stats: IndexStats, mint: PublicKey): number | undefined {
  const p = stats.prices ?? {};
  const key = mint.toBase58();
  if (p[key] !== undefined) return p[key];
  if (mint.equals(MINTS.WSOL)) return p.SOL ?? p.WSOL;
  if (mint.equals(MINTS.USDC)) return p.USDC ?? 1;
  return undefined;
}

// --------------------------------------------------------- chain observation

export interface IndexCoin {
  mint: PublicKey;
  pairedMint: PublicKey;
  fees30dUsd: number;
  isFloatCoin: boolean;
  isFlagship: boolean;
  graduatedAt: bigint;
  operatorPaused: boolean;
  pausedReason?: string;
  swapsPaused: boolean;
  launchLabPool?: PublicKey;
  cpmmPool?: cpmm.CpmmPoolBundle;
  supply: bigint;
  coinDecimals: number;
  pairedDecimals: number;
  coinReserve: bigint;
  pairedReserve: bigint;
  /** USD per whole coin, from the CPMM reserves. */
  priceUsd?: number;
  mcapUsd?: number;
  poolPairedUsd?: number;
  error?: string;
}

/**
 * Graduated pools on a LaunchLab platform config, found with
 * `getProgramAccounts` filters on `PoolState.platform_config` (offset 173)
 * and `status == 2` (offset 17): how Float coins are detected on mainnet.
 */
export async function discoverFloatCoins(conn: Connection, platformConfig: PublicKey): Promise<{ pool: PublicKey; mint: PublicKey; pairedMint: PublicKey }[]> {
  const accounts = await conn.getProgramAccounts(launchLab.LAUNCHLAB_PROGRAM_ID, [
    { memcmp: { offset: 173, bytes: platformConfig.toBase58() } },
    { memcmp: { offset: 17, bytes: encodeBase58(Uint8Array.of(launchLab.PoolStatus.Trade)) } },
  ]);
  return accounts.map((a) => {
    const p = launchLab.decodeLaunchLabPool(a.data);
    return { pool: a.address, mint: p.base_mint, pairedMint: p.quote_mint };
  });
}

/**
 * Observes every coin in `stats` (plus `extra` coins, e.g. from
 * {@link discoverFloatCoins}) from chain data.
 *
 * Interpretations: graduation time = CPMM pool `open_time`; paused =
 * operator flag or pool swaps disabled; market cap = CPMM spot price × supply.
 */
export async function observeIndexCoins(conn: Connection, stats: IndexStats, opts: { platformConfig?: PublicKey; extra?: { mint: PublicKey; pairedMint: PublicKey }[] } = {}): Promise<IndexCoin[]> {
  const platformConfig = opts.platformConfig ?? (stats.platformConfig ? new PublicKey(stats.platformConfig) : undefined);
  const entries = new Map<string, { mint: PublicKey; pairedMint: PublicKey; fees: number; paused: boolean; reason?: string }>();
  for (const c of stats.coins) {
    entries.set(c.mint, { mint: new PublicKey(c.mint), pairedMint: resolvePair(c.pair), fees: c.fees30dUsd, paused: Boolean(c.paused), ...(c.pausedReason ? { reason: c.pausedReason } : {}) });
  }
  for (const e of opts.extra ?? []) if (!entries.has(e.mint.toBase58())) entries.set(e.mint.toBase58(), { mint: e.mint, pairedMint: e.pairedMint, fees: 0, paused: false });

  const out: IndexCoin[] = [];
  for (const e of entries.values()) {
    const coin: IndexCoin = {
      mint: e.mint, pairedMint: e.pairedMint, fees30dUsd: e.fees, isFloatCoin: false, isFlagship: e.mint.equals(FLOAT.flagshipMint),
      graduatedAt: 0n, operatorPaused: e.paused, ...(e.reason ? { pausedReason: e.reason } : {}), swapsPaused: false,
      supply: 0n, coinDecimals: 6, pairedDecimals: 9, coinReserve: 0n, pairedReserve: 0n,
    };
    try {
      const llPool = launchLab.launchLabPda.pool(e.mint, e.pairedMint);
      const b = await launchLab.fetchLaunchLabPool(conn, llPool);
      coin.launchLabPool = llPool;
      coin.isFloatCoin = Boolean(platformConfig && b.pool.platform_config.equals(platformConfig));
      coin.supply = b.pool.supply;
      coin.coinDecimals = b.pool.base_decimals;
      coin.pairedDecimals = b.pool.quote_decimals;
      if (b.pool.status === launchLab.PoolStatus.Trade && b.pool.migrate_type === 1) {
        const [m0, m1] = cpmm.sortMints(e.mint, e.pairedMint);
        const cb = await cpmm.fetchCpmmPool(conn, cpmm.cpmmPda.pool(b.platformConfig.cpswap_config, m0, m1));
        const { reserve0, reserve1 } = cpmm.tradableReserves(cb);
        const coinIs0 = cb.pool.token_0_mint.equals(e.mint);
        coin.cpmmPool = cb;
        coin.graduatedAt = cb.pool.open_time;
        coin.swapsPaused = (cb.pool.status & (1 << 2)) !== 0;
        coin.coinReserve = coinIs0 ? reserve0 : reserve1;
        coin.pairedReserve = coinIs0 ? reserve1 : reserve0;
        const usd = pairedUsd(stats, e.pairedMint);
        if (usd !== undefined && coin.coinReserve > 0n) {
          const paired = Number(coin.pairedReserve) / 10 ** coin.pairedDecimals;
          coin.poolPairedUsd = paired * usd;
          coin.priceUsd = (paired / (Number(coin.coinReserve) / 10 ** coin.coinDecimals)) * usd;
          coin.mcapUsd = coin.priceUsd * (Number(coin.supply) / 10 ** coin.coinDecimals);
        } else if (usd === undefined) coin.error = `no USD price for paired mint ${e.pairedMint.toBase58()} in stats.prices`;
      }
    } catch (err) {
      coin.error = err instanceof Error ? err.message : String(err);
    }
    out.push(coin);
  }
  return out;
}

// --------------------------------------------------------------- methodology

export interface MethodologyParams {
  n?: number;
  capBps?: number;
  liqFactorBps?: number;
  minPoolPairedUsd?: number;
  minAgeSecs?: number;
  /** Target AUM in USD for the liquidity cap; 0 or omitted = no liquidity cap. */
  aumUsd?: number;
  /** Unix seconds; default now. */
  now?: bigint;
}

export interface MethodologyRow {
  mint: PublicKey;
  included: boolean;
  weightBps: number;
  /** Rank by 30-day fees among eligible coins (1-based), if eligible. */
  rank?: number;
  fees30dUsd: number;
  mcapUsd?: number;
  poolPairedUsd?: number;
  capBps?: number;
  reason: string;
}

export interface Methodology {
  rows: MethodologyRow[];
  basket: { mint: PublicKey; weightBps: number }[];
  error?: string;
}

const usdStr = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;

/** Spec §3: universe, selection by 30-day fees, √mcap weights, caps. Explains every in/out. */
export function computeMethodology(coins: IndexCoin[], p: MethodologyParams = {}): Methodology {
  const n = p.n ?? DEFAULT_N;
  if (!Number.isInteger(n) || n < 1 || n > MAX_COMPONENTS) throw new RangeError(`n must be 1-${MAX_COMPONENTS}`);
  const capBps = p.capBps ?? DEFAULT_CAP_BPS;
  const liqFactor = p.liqFactorBps ?? DEFAULT_LIQ_FACTOR_BPS;
  const minPool = p.minPoolPairedUsd ?? DEFAULT_MIN_POOL_PAIRED_USD;
  const minAge = BigInt(p.minAgeSecs ?? DEFAULT_MIN_AGE_SECS);
  const now = p.now ?? BigInt(Math.floor(Date.now() / 1000));

  const rows: MethodologyRow[] = coins.map((c) => {
    const base = { mint: c.mint, included: false, weightBps: 0, fees30dUsd: c.fees30dUsd, ...(c.mcapUsd !== undefined ? { mcapUsd: c.mcapUsd } : {}), ...(c.poolPairedUsd !== undefined ? { poolPairedUsd: c.poolPairedUsd } : {}) };
    const out = (reason: string): MethodologyRow => ({ ...base, reason });
    if (c.isFlagship) return out("$FLOAT: optional fixed slot decided by Float (§10), not ranked");
    if (c.error && !c.launchLabPool) return out(`no LaunchLab pool: ${c.error}`);
    if (!c.isFloatCoin) return out("not on Float's LaunchLab platform config");
    if (c.graduatedAt === 0n || !c.cpmmPool) return out("not graduated");
    const age = now - c.graduatedAt;
    if (age < minAge) return out(`graduated ${(Number(age) / 86_400).toFixed(1)} days ago (min ${Number(minAge) / 86_400})`);
    if (c.operatorPaused) return out(`paused by operator: ${c.pausedReason ?? "no reason given"}`);
    if (c.swapsPaused) return out("pool swaps paused");
    if (c.error) return out(c.error);
    if ((c.poolPairedUsd ?? 0) < minPool) return out(`pool ${usdStr(c.poolPairedUsd ?? 0)} paired side (min ${usdStr(minPool)})`);
    if (!(c.fees30dUsd > 0)) return out("no 30-day fees in stats.json");
    return out("eligible");
  });

  const eligible = rows.filter((r) => r.reason === "eligible");
  eligible.sort((a, b) => b.fees30dUsd - a.fees30dUsd || a.mint.compare(b.mint));
  eligible.forEach((r, i) => {
    r.rank = i + 1;
    if (i >= n) r.reason = `rank #${i + 1} by 30-day fees, outside the top ${n}`;
  });
  const selected = eligible.slice(0, n);
  if (selected.length === 0) return { rows, basket: [], error: "No eligible coins" };

  const aum = BigInt(Math.round(p.aumUsd ?? 0));
  const inputs: WeightInput[] = selected.map((r) => {
    const liq = liquidityCapBps(BigInt(Math.round(r.poolPairedUsd ?? 0)), aum, liqFactor);
    r.capBps = Math.min(capBps, liq);
    return { mint: r.mint, mcap: BigInt(Math.round((r.mcapUsd ?? 0) * 1e6)), liqCapBps: liq };
  });
  try {
    const w = targetWeights(inputs, capBps);
    selected.forEach((r, i) => {
      r.included = true;
      r.weightBps = w[i]!;
      r.reason = `top ${n} by 30-day fees (#${r.rank})${w[i] === r.capBps ? `, capped at ${r.capBps} bps` : ""}`;
    });
    return { rows, basket: selected.map((r) => ({ mint: r.mint, weightBps: r.weightBps })) };
  } catch (e) {
    if (!(e instanceof IndexError)) throw e;
    selected.forEach((r) => (r.reason = `selected (#${r.rank}) but weights failed: ${e.code}`));
    return { rows, basket: [], error: `${e.code}: ${e.message}` };
  }
}

// ----------------------------------------------------------- NAV and rebalance

export interface Holding {
  mint: PublicKey;
  quantity: bigint;
  decimals: number;
  priceUsd: number;
}

/** NAV estimate (display only: the index never uses prices to mint or redeem). */
export function estimateNav(holdings: Holding[], shares: bigint, shareDecimals = 9): { navUsd: number; perShareUsd: number } {
  const navUsd = holdings.reduce((a, h) => a + (Number(h.quantity) / 10 ** h.decimals) * h.priceUsd, 0);
  return { navUsd, perShareUsd: shares === 0n ? 0 : navUsd / (Number(shares) / 10 ** shareDecimals) };
}

export interface RebalanceComponent extends Holding {
  targetBps: number;
  /** The coin's CPMM pool (coin ↔ paired) for impact estimates. */
  pool?: cpmm.CpmmPoolBundle;
}

export interface RebalanceTrade {
  mint: PublicKey;
  driftBps: number;
  sell: bigint;
  buy: bigint;
  /** Price impact of the trade on the coin's own pool, if known. */
  priceImpact: number | null;
}

/**
 * Rebalance plan (§7) in quantities via the mirrored `rebalance_plan`, with
 * the impact of each trade on the coin's own CPMM pool.
 *
 * The impact estimate covers the coin ↔ paired hop. For coins not paired
 * with SOL, quote the pinned paired ↔ WSOL hop of §7 with `families.planRoute`.
 */
export function planRebalance(components: RebalanceComponent[], bandBps = DEFAULT_BAND_BPS, turnoverBps = DEFAULT_TURNOVER_BPS): RebalanceTrade[] {
  const prices = components.map((c) => usdPriceQ64(c.priceUsd / 10 ** c.decimals));
  const q = components.map((c) => c.quantity);
  const targets = components.map((c) => c.targetBps);
  const drift = driftBps(q, prices, targets);
  const legs = rebalancePlan(q, prices, targets, bandBps, turnoverBps);
  return components.map((c, i) => {
    const leg = legs[i]!;
    let priceImpact: number | null = null;
    if (c.pool && (leg.sell > 0n || leg.buy > 0n)) {
      const paired = c.pool.pool.token_0_mint.equals(c.mint) ? c.pool.pool.token_1_mint : c.pool.pool.token_0_mint;
      if (leg.sell > 0n) priceImpact = cpmm.quoteCpmmSwap(c.pool, c.mint, leg.sell).priceImpact;
      else {
        // Buying `buy` coins: estimate the paired input at spot, then quote it.
        const { reserve0, reserve1 } = cpmm.tradableReserves(c.pool);
        const coinIs0 = c.pool.pool.token_0_mint.equals(c.mint);
        const [coinR, pairedR] = coinIs0 ? [reserve0, reserve1] : [reserve1, reserve0];
        const pairedIn = coinR > 0n ? (leg.buy * pairedR) / coinR : 0n;
        if (pairedIn > 0n) priceImpact = cpmm.quoteCpmmSwap(c.pool, paired, pairedIn).priceImpact;
      }
    }
    return { mint: c.mint, driftBps: drift[i]!, sell: leg.sell, buy: leg.buy, priceImpact };
  });
}

// -------------------------------------------------------------- simulator

export interface BasketComponent {
  mint: PublicKey;
  weightBps: number;
  coin: IndexCoin;
}

export interface IndexSimInput {
  depositSol: number;
  days: number;
  solUsd: number;
  basket: BasketComponent[];
  creationFeeBps?: number;
  holdersBps?: number;
  windowDays?: number;
}

export interface IndexSimRow {
  mint: PublicKey;
  weightBps: number;
  spendUsd: number;
  coinsBought: number;
  buyImpact: number | null;
  /** Share of the coin's holder base the deposit would own. */
  holderShare: number;
  rewardsUsdPerDay: number;
  redeemUsd: number;
}

export interface IndexSimResult {
  depositSol: number;
  feeSol: number;
  netSol: number;
  /** Shares for a genesis epoch: 1 share = 1 lamport (§4). */
  genesisShares: bigint;
  rows: IndexSimRow[];
  rewardsUsdPerDay: number;
  rewardsUsdTotal: number;
  /** Value of an in-kind redemption sold back through the same pools. */
  redeemUsd: number;
  disclaimer: string;
}

function sideOf(pool: cpmm.CpmmPoolBundle, inputMint: PublicKey) {
  const zeroForOne = pool.pool.token_0_mint.equals(inputMint);
  const { reserve0, reserve1 } = cpmm.tradableReserves(pool);
  return {
    inputReserve: zeroForOne ? reserve0 : reserve1,
    outputReserve: zeroForOne ? reserve1 : reserve0,
    tradeFeeRate: pool.config.trade_fee_rate,
    creatorFeeRate: pool.pool.enable_creator_fee ? pool.config.creator_fee_rate : 0n,
    protocolFeeRate: pool.config.protocol_fee_rate,
    fundFeeRate: pool.config.fund_fee_rate,
    creatorFeeOnInput: cpmm.isCreatorFeeOnInput(pool.pool.creator_fee_on, zeroForOne),
  };
}

/**
 * Creation → rewards → redemption for one deposit (genesis epoch).
 *
 * Interpretations: each component is bought with its weight of the net
 * deposit through its own pool (paired side valued at the stats price);
 * the deposit's share of a coin's holder rewards is
 * `coins / (supply − pool reserve)`; daily holder rewards are
 * `fees30dUsd / windowDays × holders share`.
 */
export function simulateIndex(input: IndexSimInput): IndexSimResult {
  const feeBps = input.creationFeeBps ?? DEFAULT_CREATION_FEE_BPS;
  const holdersBps = input.holdersBps ?? OFFICIAL_HOLDERS_BPS;
  const window = input.windowDays ?? 30;
  if (!(input.depositSol > 0) || !(input.solUsd > 0) || !Number.isInteger(input.days) || input.days < 1) throw new RangeError("Need depositSol > 0, solUsd > 0 and days >= 1");
  const feeSol = (input.depositSol * feeBps) / 10_000;
  const netSol = input.depositSol - feeSol;
  const netUsd = netSol * input.solUsd;

  const rows = input.basket.map((b): IndexSimRow => {
    const c = b.coin;
    const spendUsd = (netUsd * b.weightBps) / 10_000;
    const pairedPrice = c.priceUsd !== undefined && c.coinReserve > 0n ? (c.priceUsd * Number(c.coinReserve) / 10 ** c.coinDecimals) / (Number(c.pairedReserve) / 10 ** c.pairedDecimals) : undefined;
    let coinsRaw = 0n;
    let buyImpact: number | null = null;
    if (c.cpmmPool && pairedPrice) {
      const pairedIn = BigInt(Math.floor((spendUsd / pairedPrice) * 10 ** c.pairedDecimals));
      if (pairedIn > 0n) {
        const r = cpmm.swapBaseInput({ amountIn: pairedIn, ...sideOf(c.cpmmPool, c.pairedMint) });
        coinsRaw = r.outputAmount;
        buyImpact = r.priceImpact;
      }
    }
    const coinsBought = Number(coinsRaw) / 10 ** c.coinDecimals;
    const holderBase = Number(c.supply - c.coinReserve) / 10 ** c.coinDecimals;
    const holderShare = holderBase > 0 ? coinsBought / holderBase : 0;
    const rewardsUsdPerDay = (c.fees30dUsd / window) * (holdersBps / 10_000) * holderShare;
    let redeemUsd = 0;
    if (c.cpmmPool && pairedPrice && coinsRaw > 0n) {
      const out = cpmm.swapBaseInput({ amountIn: coinsRaw, ...sideOf(c.cpmmPool, c.mint) }).outputAmount;
      redeemUsd = (Number(out) / 10 ** c.pairedDecimals) * pairedPrice;
    }
    return { mint: b.mint, weightBps: b.weightBps, spendUsd, coinsBought, buyImpact, holderShare, rewardsUsdPerDay, redeemUsd };
  });
  const perDay = rows.reduce((a, r) => a + r.rewardsUsdPerDay, 0);
  return {
    depositSol: input.depositSol,
    feeSol,
    netSol,
    genesisShares: BigInt(Math.floor(netSol * 1e9)),
    rows,
    rewardsUsdPerDay: perDay,
    rewardsUsdTotal: perDay * input.days,
    redeemUsd: rows.reduce((a, r) => a + r.redeemUsd, 0),
    disclaimer: SIMULATION_DISCLAIMER,
  };
}

// ----------------------------------------------------------- FIDX payouts

/**
 * Plans one FIDX holder payout of `available` units of a reward mint
 * (`reward_available`, §6) with the same model Float uses for coin holders
 * (`computePayoutRound`: $2 token-account threshold, rollovers, seller
 * forfeit). Index-owned accounts and FIDX pools must be excluded (§6).
 */
export function planFidxPayout(input: { available: bigint; holders: HolderState[]; usdPerUnit: number; exclude?: string[]; ataThresholdUsd?: number }): PayoutRoundResult {
  const skip = new Set(input.exclude ?? []);
  return computePayoutRound({
    amount: input.available,
    holders: input.holders.filter((h) => !skip.has(h.owner)),
    usdPerUnit: input.usdPerUnit,
    ...(input.ataThresholdUsd !== undefined ? { ataThresholdUsd: input.ataThresholdUsd } : {}),
  });
}
