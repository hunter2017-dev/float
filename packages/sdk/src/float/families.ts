/**
 * Coin Families (docs/proposals/coin-families.md): a child coin pays its
 * holders in a parent coin or $FLOAT.
 *
 * - Rules: exact mirror of `float-core::family` (eligibility, lineage, mode,
 *   routes, guards, Mode B accounting, daily demand). Shared vectors in
 *   `crates/float-core/tests/fixtures/family-vectors.json` keep both in step.
 * - Planning: multi-hop route quotes over pinned CPMM pools, Mode A curve
 *   sizing (`curveParamsForTargetUsd`) and the economics simulator.
 * - On-chain observation: eligibility inputs read from LaunchLab / CPMM /
 *   SPL accounts (no float-router is deployed on mainnet).
 *
 * Not an official Float feature.
 */

import { PublicKey } from "../core/pubkey.ts";
import type { Connection } from "../core/rpc.ts";
import { FLOAT, MINTS, TOKEN_2022_PROGRAM_ID } from "../programs/addresses.ts";
import * as cpmm from "../raydium/cpmm.ts";
import * as launchLab from "../raydium/launchlab.ts";

// -------------------------------------------------------------- constants

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const BPS = 10_000n;

/** Q64.64 fixed-point one (reference prices are output per input in Q64.64). */
export const Q64 = 1n << 64n;
/** Micro-USD per USD. */
export const MICRO_USD = 1_000_000n;
/** Seconds per day. */
export const SECS_PER_DAY = 86_400n;
/** Maximum hops in a conversion route (§4.1). */
export const MAX_ROUTE_HOPS = 3;
/** Default `parent_min_age`: 7 days, matching the official 7-day rule for new pairs. */
export const DEFAULT_PARENT_MIN_AGE_SECS = 7n * SECS_PER_DAY;
/** Default `parent_min_pool_usd`: $100 000 on the paired side, in micro-USD. */
export const DEFAULT_PARENT_MIN_POOL_USD = 100_000n * MICRO_USD;
/** Default `max_depth`: $FLOAT → child → grandchild. */
export const DEFAULT_MAX_DEPTH = 2;
/** Default guard for operator swaps (2 %), same as `float_core::guard::DEFAULT_GUARD_BPS`. */
export const DEFAULT_GUARD_BPS = 200;
/** Default per-hop price-impact cap (1 %), same as the buyback cap. */
export const DEFAULT_MAX_IMPACT_BPS = 100;

/**
 * Holders' share of the split for standard coins: 17.5 %.
 * Source: https://www.floatlaunch.xyz/docs (Fees). A parameter everywhere.
 */
export const OFFICIAL_HOLDERS_BPS = 1_750;
/** Trading fee of new standard coins: 1 % per buy and sell (official docs, Fees). */
export const OFFICIAL_TRADING_FEE_BPS = 100;
/** Part of the fee Raydium keeps while a coin is on its curve: 0.25 % (official docs, Fees). */
export const OFFICIAL_RAYDIUM_CURVE_FEE_BPS = 25;
/**
 * Default fee rate that goes through Float's split: 1 % − 0.25 % = 0.75 %.
 * Interpretation: the docs give Raydium's share only for the curve stage; the
 * same 0.75 % is assumed after graduation unless the caller passes another rate.
 */
export const DEFAULT_SPLIT_FEE_BPS = OFFICIAL_TRADING_FEE_BPS - OFFICIAL_RAYDIUM_CURVE_FEE_BPS;
/** Official curve targets: "about $20,000" start, graduation "roughly $150,000" (official docs, How it works). */
export const OFFICIAL_START_MCAP_USD = 20_000;
export const OFFICIAL_GRADUATION_MCAP_USD = 150_000;
/** Fixed supply of every Float coin: 1,000,000,000 (official docs, How it works). */
export const OFFICIAL_SUPPLY_TOKENS = 1_000_000_000n;

export const SIMULATION_DISCLAIMER =
  "Scenarios, not forecasts: every figure follows from the inputs you chose (volume, fee rate, holders share, " +
  "reserves, prices). Real volume, prices and liquidity will differ. Coin Families is a community proposal, " +
  "not an official Float feature.";

// ------------------------------------------------------------------ errors

/** Same names as the matching `float_core::CoreError` variants. */
export type FamilyErrorCode =
  | "MathOverflow"
  | "InvalidReserves"
  | "InvalidParams"
  | "ParentNotFloatCoin"
  | "ParentNotGraduated"
  | "ParentTooYoung"
  | "ParentPoolTooThin"
  | "ParentPaused"
  | "FamilyTooDeep"
  | "FamilyCycle"
  | "FamilyModeMismatch"
  | "RouteEmpty"
  | "RouteTooLong"
  | "RouteBroken"
  | "RoutePoolReused"
  | "RoutePoolNotPinned"
  | "ExceedsUnpaid";

export class FamilyError extends Error {
  readonly code: FamilyErrorCode;
  constructor(code: FamilyErrorCode, message?: string) {
    super(message ?? code);
    this.name = "FamilyError";
    this.code = code;
  }
}

const fail = (code: FamilyErrorCode): never => {
  throw new FamilyError(code);
};

function u64(x: bigint, what = "value"): bigint {
  if (x < 0n || x > U64_MAX) throw new RangeError(`${what} must fit in a u64`);
  return x;
}

const checkedAdd = (a: bigint, b: bigint) => (a + b > U64_MAX ? fail("MathOverflow") : a + b);
const checkedSub = (a: bigint, b: bigint, code: FamilyErrorCode = "MathOverflow") => (b > a ? fail(code) : a - b);

// ------------------------------------------------------------ eligibility

export type FamilyMode = "RewardLinked" | "NativeQuote";
export type ParentKind = "Flagship" | "Coin";

/** On-chain encoding: 0 = Mode B (reward-linked), 1 = Mode A (native quote). */
export const familyModeToU8 = (m: FamilyMode): number => (m === "RewardLinked" ? 0 : 1);
export function familyModeFromU8(v: number): FamilyMode {
  if (v === 0) return "RewardLinked";
  if (v === 1) return "NativeQuote";
  return fail("InvalidParams");
}

export interface EligibilityParams {
  /** Minimum time since graduation, in seconds. */
  parentMinAgeSecs: bigint;
  /** Minimum paired-side liquidity of the parent's CPMM pool, in micro-USD. */
  parentMinPoolUsd: bigint;
  /** Deepest allowed child depth ($FLOAT and root coins are depth 0). */
  maxDepth: number;
}

export const DEFAULT_ELIGIBILITY_PARAMS: Readonly<EligibilityParams> = Object.freeze({
  parentMinAgeSecs: DEFAULT_PARENT_MIN_AGE_SECS,
  parentMinPoolUsd: DEFAULT_PARENT_MIN_POOL_USD,
  maxDepth: DEFAULT_MAX_DEPTH,
});

export interface EligibilityInput {
  kind: ParentKind;
  /** Launched with Float's LaunchLab platform config (mainnet) or registered in float-router. */
  isFloatCoin: boolean;
  /** Unix seconds of graduation; 0 while on the bonding curve. */
  graduatedAt: bigint;
  /** Current unix seconds. */
  now: bigint;
  /** Paired-side value of the parent's CPMM pool, in micro-USD. */
  poolPairedUsd: bigint;
  /** True while the issuer of the parent's paired asset pauses it. */
  pairedPaused: boolean;
  /** Depth of the parent (0 for $FLOAT and coins without a parent). */
  parentDepth: number;
}

export function validateEligibilityParams(p: EligibilityParams): void {
  if (!Number.isInteger(p.maxDepth) || p.maxDepth < 0 || p.maxDepth > 255) throw new RangeError("maxDepth must be a u8");
  if (p.maxDepth === 0 || p.parentMinAgeSecs < 0n) fail("InvalidParams");
}

/** Mirror of `check_parent_eligibility`: throws the first failing rule (§3 order). */
export function checkParentEligibility(params: EligibilityParams, input: EligibilityInput): void {
  validateEligibilityParams(params);
  if (input.kind === "Flagship") return;
  if (!input.isFloatCoin) fail("ParentNotFloatCoin");
  if (input.graduatedAt <= 0n) fail("ParentNotGraduated");
  const age = input.now - input.graduatedAt;
  if (age < -(1n << 63n) || age > (1n << 63n) - 1n) fail("MathOverflow");
  if (age < params.parentMinAgeSecs) fail("ParentTooYoung");
  if (input.poolPairedUsd < params.parentMinPoolUsd) fail("ParentPoolTooThin");
  if (input.pairedPaused) fail("ParentPaused");
  childDepth(input.parentDepth, params.maxDepth);
}

/** Every rule's verdict, for explaining a result (the first failure is what `checkParentEligibility` throws). */
export function explainEligibility(params: EligibilityParams, input: EligibilityInput): { rule: string; ok: boolean; detail: string }[] {
  if (input.kind === "Flagship") return [{ rule: "flagship", ok: true, detail: "$FLOAT is always eligible" }];
  const ageSecs = input.graduatedAt > 0n ? input.now - input.graduatedAt : 0n;
  const days = (s: bigint) => (Number(s) / 86_400).toFixed(1);
  const usd = (m: bigint) => `$${(Number(m) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return [
    { rule: "float coin", ok: input.isFloatCoin, detail: input.isFloatCoin ? "on Float's LaunchLab platform config" : "not on the given Float platform config" },
    { rule: "graduated", ok: input.graduatedAt > 0n, detail: input.graduatedAt > 0n ? "graduated to CPMM" : "still on the bonding curve" },
    {
      rule: "age",
      ok: input.graduatedAt > 0n && ageSecs >= params.parentMinAgeSecs,
      detail: `${days(ageSecs)} days since graduation (min ${days(params.parentMinAgeSecs)})`,
    },
    { rule: "liquidity", ok: input.poolPairedUsd >= params.parentMinPoolUsd, detail: `${usd(input.poolPairedUsd)} paired side (min ${usd(params.parentMinPoolUsd)})` },
    { rule: "not paused", ok: !input.pairedPaused, detail: input.pairedPaused ? "paired asset or pool swaps paused" : "trading" },
    { rule: "depth", ok: input.parentDepth + 1 <= params.maxDepth, detail: `child depth ${input.parentDepth + 1} (max ${params.maxDepth})` },
  ];
}

/** Mirror of `child_depth`. */
export function childDepth(parentDepth: number, maxDepth: number): number {
  const depth = parentDepth + 1;
  if (depth > 255 || depth > maxDepth) fail("FamilyTooDeep");
  return depth;
}

/** Mirror of `validate_lineage`; `ancestors` run from the parent's parent up to the root. */
export function validateLineage(child: PublicKey, parent: PublicKey, ancestors: PublicKey[], maxDepth: number): number {
  if (ancestors.length > 255) fail("FamilyTooDeep");
  const depth = childDepth(ancestors.length, maxDepth);
  if (child.equals(parent)) fail("FamilyCycle");
  ancestors.forEach((a, i) => {
    if (a.equals(child) || a.equals(parent) || ancestors.slice(0, i).some((b) => b.equals(a))) fail("FamilyCycle");
  });
  return depth;
}

/** Mirror of `check_mode`. */
export function checkMode(mode: FamilyMode, childPairedMint: PublicKey, parent: PublicKey): void {
  const pairedWithParent = childPairedMint.equals(parent);
  if ((mode === "NativeQuote") !== pairedWithParent) fail("FamilyModeMismatch");
}

// ------------------------------------------------------------------ routes

export interface Hop {
  pool: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
}

/** Mirror of `validate_route`. */
export function validateRoute(hops: Hop[], from: PublicKey, to: PublicKey, pinned: PublicKey[]): void {
  if (hops.length === 0) fail("RouteEmpty");
  if (hops.length > MAX_ROUTE_HOPS) fail("RouteTooLong");
  let cursor = from;
  hops.forEach((h, i) => {
    if (!h.inputMint.equals(cursor) || h.outputMint.equals(h.inputMint)) fail("RouteBroken");
    if (h.outputMint.equals(from) || hops.slice(0, i).some((p) => p.outputMint.equals(h.outputMint))) fail("RouteBroken");
    cursor = h.outputMint;
  });
  if (!cursor.equals(to)) fail("RouteBroken");
  hops.forEach((h, i) => {
    if (hops.slice(0, i).some((p) => p.pool.equals(h.pool))) fail("RoutePoolReused");
  });
  if (hops.some((h) => !pinned.some((p) => p.equals(h.pool)))) fail("RoutePoolNotPinned");
}

/** Mirror of `guard::expected_out`. */
export function expectedOut(amountIn: bigint, priceQ64: bigint): bigint {
  u64(amountIn, "amountIn");
  if (priceQ64 < 0n || priceQ64 > U128_MAX) throw new RangeError("priceQ64 must fit in a u128");
  const product = amountIn * priceQ64;
  if (product > U128_MAX) fail("MathOverflow");
  const v = product >> 64n;
  if (v > U64_MAX) fail("MathOverflow");
  return v;
}

/** Mirror of `guard::min_out`. */
export function guardMinOut(expected: bigint, guardBps: number): bigint {
  u64(expected, "expected");
  if (!Number.isInteger(guardBps) || guardBps < 0 || guardBps > 0xffff) throw new RangeError("guardBps must be a u16");
  if (BigInt(guardBps) > BPS) fail("MathOverflow");
  return (expected * (BPS - BigInt(guardBps))) / BPS;
}

/** Mirror of `hop_min_out`. */
export function hopMinOut(amountIn: bigint, priceQ64: bigint, guardBps: number): bigint {
  return guardMinOut(expectedOut(amountIn, priceQ64), guardBps);
}

/**
 * Mirror of `route_min_outs`: hop i's minimum is computed from hop i-1's
 * minimum, so the values are safe as each swap's `minimum_amount_out`.
 * End-to-end tolerance is `1 − (1 − guard)^hops`. (Interpretation, see float-core.)
 */
export function routeMinOuts(amountIn: bigint, pricesQ64: bigint[], guardBps: number): bigint[] {
  if (pricesQ64.length === 0) fail("RouteEmpty");
  if (pricesQ64.length > MAX_ROUTE_HOPS) fail("RouteTooLong");
  const out: bigint[] = [];
  let m = amountIn;
  for (const p of pricesQ64) {
    m = hopMinOut(m, p, guardBps);
    out.push(m);
  }
  return out;
}

/** CPMM fee parameters of one swap direction (same fields as `float_core::cpmm::Fees`). */
export interface HopFees {
  tradeFeeRate: bigint;
  creatorFeeRate: bigint;
  protocolFeeRate: bigint;
  fundFeeRate: bigint;
  creatorFeeOnInput: boolean;
}

function swapWithinImpact(amount: bigint, inRes: bigint, outRes: bigint, fees: HopFees, maxImpactBps: bigint): boolean {
  if (amount > inRes) return false;
  const r = cpmm.swapBaseInput({ amountIn: amount, inputReserve: inRes, outputReserve: outRes, ...fees });
  if (r.newInputReserve > U64_MAX || r.outputAmount < 0n) return false; // float-core would return an error
  // Port of float_core::cpmm::within_price_impact.
  const lhs = r.newOutputReserve * inRes;
  const rhs = outRes * r.newInputReserve;
  if (lhs >= rhs) return true;
  return rhs - lhs <= (rhs / BPS) * maxImpactBps;
}

/** Mirror of `max_hop_input` (binary search over the exact CPMM math). */
export function maxHopInput(inputReserve: bigint, outputReserve: bigint, fees: HopFees, maxImpactBps: number): bigint {
  u64(inputReserve, "inputReserve");
  u64(outputReserve, "outputReserve");
  if (inputReserve === 0n || outputReserve === 0n) fail("InvalidReserves");
  const cap = BigInt(maxImpactBps);
  let lo = 0n;
  let hi = inputReserve;
  while (lo < hi) {
    const mid = lo + (hi - lo + 1n) / 2n;
    if (swapWithinImpact(mid, inputReserve, outputReserve, fees, cap)) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

// -------------------------------------------------------------- accounting

/** Mirror of `received_amount`. */
export const receivedAmount = (before: bigint, after: bigint): bigint => checkedSub(u64(after), u64(before));

/** Mirror of `parent_vault_solvent` (invariant 1). */
export function parentVaultSolvent(vaultBalance: bigint, unpaidParent: bigint[]): boolean {
  let sum = 0n;
  for (const u of unpaidParent) sum = checkedAdd(sum, u64(u));
  return sum <= u64(vaultBalance);
}

/** Mirror of `ModeBLedger`. */
export interface ModeBLedger {
  holdersUnpaidPaired: bigint;
  holdersUnpaidParent: bigint;
  totalConvertedPaired: bigint;
  totalParentBought: bigint;
  totalParentPaid: bigint;
}

export const emptyLedger = (holdersUnpaidPaired = 0n): ModeBLedger => ({
  holdersUnpaidPaired,
  holdersUnpaidParent: 0n,
  totalConvertedPaired: 0n,
  totalParentBought: 0n,
  totalParentPaid: 0n,
});

/** Mirror of `ModeBLedger::record_conversion`: credits the vault delta, never a quote. */
export function recordConversion(l: ModeBLedger, amountIn: bigint, vaultBefore: bigint, vaultAfter: bigint): { ledger: ModeBLedger; received: bigint } {
  if (u64(amountIn) === 0n) fail("InvalidParams");
  const holdersUnpaidPaired = checkedSub(l.holdersUnpaidPaired, amountIn, "ExceedsUnpaid");
  const received = receivedAmount(vaultBefore, vaultAfter);
  return {
    received,
    ledger: {
      holdersUnpaidPaired,
      holdersUnpaidParent: checkedAdd(l.holdersUnpaidParent, received),
      totalConvertedPaired: checkedAdd(l.totalConvertedPaired, amountIn),
      totalParentBought: checkedAdd(l.totalParentBought, received),
      totalParentPaid: l.totalParentPaid,
    },
  };
}

/** Mirror of `ModeBLedger::record_payout`. */
export function recordPayout(l: ModeBLedger, total: bigint): ModeBLedger {
  return {
    ...l,
    holdersUnpaidParent: checkedSub(l.holdersUnpaidParent, u64(total), "ExceedsUnpaid"),
    totalParentPaid: checkedAdd(l.totalParentPaid, total),
  };
}

/** Mirror of `daily_parent_demand`: `V · f · holders_share` in micro-USD (floored). */
export function dailyParentDemand(volumeUsdMicro: bigint, feeBps: number, holdersBps: number): bigint {
  u64(volumeUsdMicro, "volumeUsdMicro");
  if (BigInt(feeBps) > BPS || BigInt(holdersBps) > BPS || feeBps < 0 || holdersBps < 0) fail("InvalidParams");
  return (volumeUsdMicro * BigInt(feeBps) * BigInt(holdersBps)) / (BPS * BPS);
}

// ---------------------------------------------------------- route planning

/** Fee parameters and tradable reserves of a pool for one direction. */
export function poolSide(b: cpmm.CpmmPoolBundle, inputMint: PublicKey): { inputReserve: bigint; outputReserve: bigint; fees: HopFees } {
  const zeroForOne = inputMint.equals(b.pool.token_0_mint);
  if (!zeroForOne && !inputMint.equals(b.pool.token_1_mint)) throw new Error("Mint is not part of this pool");
  const { reserve0, reserve1 } = cpmm.tradableReserves(b);
  return {
    inputReserve: zeroForOne ? reserve0 : reserve1,
    outputReserve: zeroForOne ? reserve1 : reserve0,
    fees: {
      tradeFeeRate: b.config.trade_fee_rate,
      creatorFeeRate: b.pool.enable_creator_fee ? b.config.creator_fee_rate : 0n,
      protocolFeeRate: b.config.protocol_fee_rate,
      fundFeeRate: b.config.fund_fee_rate,
      creatorFeeOnInput: cpmm.isCreatorFeeOnInput(b.pool.creator_fee_on, zeroForOne),
    },
  };
}

export interface PlannedHop extends Hop {
  amountIn: bigint;
  amountOut: bigint;
  /** Relative spot-price move caused by this hop. */
  priceImpact: number;
  /** Spot price before the hop (output per input, Q64.64), used as the guard reference. */
  referencePriceQ64: bigint;
  /** Largest input this hop accepts within `maxImpactBps`. */
  maxInputWithinImpact: bigint;
  withinImpact: boolean;
}

export interface RoutePlan {
  hops: PlannedHop[];
  amountIn: bigint;
  amountOut: bigint;
  /** Per-hop `minimum_amount_out`, composed with `routeMinOuts`. */
  minOuts: bigint[];
  /** True when every hop is within the impact cap; otherwise split the amount across cycles. */
  withinImpact: boolean;
}

export interface PlanRouteOptions {
  guardBps?: number;
  maxImpactBps?: number;
  maxHops?: number;
}

/**
 * Finds the best route from `from` to `to` through the pinned pools only
 * (≤ 3 hops, no mint or pool used twice), quoting every hop with
 * `cpmm.quoteCpmmSwap` on the previous hop's output. Returns `null` if the
 * pinned pools do not connect the two mints.
 *
 * Interpretation: the guard reference of each hop is the pool's spot price
 * before the hop. The spec asks for the pool TWAP on chain (Phase 2);
 * off-chain previews use spot.
 */
export function planRoute(pinned: cpmm.CpmmPoolBundle[], from: PublicKey, to: PublicKey, amountIn: bigint, opts: PlanRouteOptions = {}): RoutePlan | null {
  const guardBps = opts.guardBps ?? DEFAULT_GUARD_BPS;
  const maxImpactBps = opts.maxImpactBps ?? DEFAULT_MAX_IMPACT_BPS;
  const maxHops = Math.min(opts.maxHops ?? MAX_ROUTE_HOPS, MAX_ROUTE_HOPS);
  u64(amountIn, "amountIn");

  const paths: cpmm.CpmmPoolBundle[][] = [];
  const walk = (mint: PublicKey, used: cpmm.CpmmPoolBundle[], seen: PublicKey[]) => {
    if (mint.equals(to) && used.length > 0) {
      paths.push(used);
      return;
    }
    if (used.length >= maxHops) return;
    for (const b of pinned) {
      if (used.includes(b)) continue;
      const other = b.pool.token_0_mint.equals(mint) ? b.pool.token_1_mint : b.pool.token_1_mint.equals(mint) ? b.pool.token_0_mint : null;
      if (!other || seen.some((s) => s.equals(other))) continue;
      walk(other, [...used, b], [...seen, other]);
    }
  };
  walk(from, [], [from]);

  let best: RoutePlan | null = null;
  for (const path of paths) {
    const hops: PlannedHop[] = [];
    let mint = from;
    let amount = amountIn;
    let ok = true;
    for (const b of path) {
      const outMint = b.pool.token_0_mint.equals(mint) ? b.pool.token_1_mint : b.pool.token_0_mint;
      const side = poolSide(b, mint);
      if (side.inputReserve <= 0n || side.outputReserve <= 0n) {
        ok = false;
        break;
      }
      const q = cpmm.quoteCpmmSwap(b, mint, amount);
      const maxIn = maxHopInput(side.inputReserve, side.outputReserve, side.fees, maxImpactBps);
      hops.push({
        pool: b.address,
        inputMint: mint,
        outputMint: outMint,
        amountIn: amount,
        amountOut: q.outputAmount,
        priceImpact: q.priceImpact,
        referencePriceQ64: (side.outputReserve << 64n) / side.inputReserve,
        maxInputWithinImpact: maxIn,
        withinImpact: amount <= maxIn,
      });
      mint = outMint;
      amount = q.outputAmount;
    }
    if (!ok) continue;
    validateRoute(hops, from, to, pinned.map((b) => b.address));
    const plan: RoutePlan = {
      hops,
      amountIn,
      amountOut: amount,
      minOuts: routeMinOuts(amountIn, hops.map((h) => h.referencePriceQ64), guardBps),
      withinImpact: hops.every((h) => h.withinImpact),
    };
    if (!best || plan.amountOut > best.amountOut || (plan.amountOut === best.amountOut && plan.hops.length < best.hops.length)) best = plan;
  }
  return best;
}

// ------------------------------------------------------ Mode A curve sizing

export interface CurveTargetOptions {
  /** Decimals of the parent (the child's quote mint). */
  parentDecimals: number;
  /** Decimals of the child. Default 6 (LaunchLab default). */
  baseDecimals?: number;
  /** Child supply in whole tokens. Default 1,000,000,000 (official). */
  supplyTokens?: bigint;
  /** Target starting market cap in USD. Default $20,000 (official). */
  startMcapUsd?: number;
  /** Target graduation market cap in USD. Default $150,000 (official). */
  graduationMcapUsd?: number;
  /** `GlobalConfig.migrate_fee` of the parent's config, in parent units. Default 0. */
  migrateFee?: bigint;
  /** Vesting-locked child amount (base units). Default 0. */
  lockedAmount?: bigint;
}

export interface CurveParamsResult {
  supply: bigint;
  totalBaseSell: bigint;
  totalQuoteFundRaising: bigint;
  virtualBase: bigint;
  virtualQuote: bigint;
  /** Market caps the integer parameters actually produce. */
  startMcapUsd: number;
  graduationMcapUsd: number;
  /** Parent raised at graduation, in USD (before the migrate fee). */
  raiseUsd: number;
}

/**
 * Mode A (§4.2): constant-product curve parameters, in parent units, that
 * reproduce the official start and graduation market caps at the parent's
 * USD price, for Float's `update_platform_curve_param`.
 *
 * With prices p0 (start) and p1 (graduation) in parent raw units per child
 * raw unit, a constant-product curve whose end price equals the CPMM
 * migration price needs `Q = B·√(p0·p1)` and
 * `B = (p1·(S − L) + mf) / (√(p0·p1) + p1)`.
 *
 * Interpretation: market cap = price × full supply, as on Float's site.
 */
export function curveParamsForTargetUsd(parentPriceUsd: number, opts: CurveTargetOptions): CurveParamsResult {
  if (!(parentPriceUsd > 0) || !Number.isFinite(parentPriceUsd)) throw new RangeError("parentPriceUsd must be > 0");
  const baseDecimals = opts.baseDecimals ?? 6;
  const supply = (opts.supplyTokens ?? OFFICIAL_SUPPLY_TOKENS) * 10n ** BigInt(baseDecimals);
  const startUsd = opts.startMcapUsd ?? OFFICIAL_START_MCAP_USD;
  const gradUsd = opts.graduationMcapUsd ?? OFFICIAL_GRADUATION_MCAP_USD;
  if (!(startUsd > 0) || !(gradUsd > startUsd)) throw new RangeError("Need 0 < startMcapUsd < graduationMcapUsd");
  const mf = opts.migrateFee ?? 0n;
  const locked = opts.lockedAmount ?? 0n;

  const pScale = 10 ** opts.parentDecimals;
  const S = Number(supply);
  // Market caps in parent raw units, then per-raw-unit prices.
  const m0 = (startUsd / parentPriceUsd) * pScale;
  const m1 = (gradUsd / parentPriceUsd) * pScale;
  const p0 = m0 / S;
  const p1 = m1 / S;
  const g = Math.sqrt(p0 * p1);
  const B = (p1 * (S - Number(locked)) + Number(mf)) / (g + p1);
  const totalBaseSell = BigInt(Math.round(B));
  const totalQuoteFundRaising = BigInt(Math.round(B * g));
  if (totalQuoteFundRaising <= mf) throw new RangeError("Raise does not cover the migrate fee at this price");

  const { virtualBase, virtualQuote } = launchLab.constantCurveVirtualReserves({ supply, totalBaseSell, totalQuoteFundRaising, migrateFee: mf, lockedAmount: locked });
  const usdPerRaw = parentPriceUsd / pScale;
  const startPrice = Number(virtualQuote) / Number(virtualBase);
  const endPrice = Number(virtualQuote + totalQuoteFundRaising) / Number(virtualBase - totalBaseSell);
  return {
    supply,
    totalBaseSell,
    totalQuoteFundRaising,
    virtualBase,
    virtualQuote,
    startMcapUsd: startPrice * S * usdPerRaw,
    graduationMcapUsd: endPrice * S * usdPerRaw,
    raiseUsd: Number(totalQuoteFundRaising) * usdPerRaw,
  };
}

// -------------------------------------------------------------- simulator

/** The parent's CPMM pool, seen from the paired side (what conversions spend). */
export interface ParentPoolState {
  parentReserve: bigint;
  pairedReserve: bigint;
  parentDecimals: number;
  pairedDecimals: number;
  /** USD price of one paired token. */
  pairedPriceUsd: number;
  /** Fees for paired → parent swaps. */
  fees: HopFees;
}

export interface FamilySimInput {
  /** "B" reward-linked (default) or "A" native quote. */
  mode?: "A" | "B";
  children: number;
  /** Daily volume per child on day 1, in USD. */
  dailyVolumeUsd: number;
  /** Days to simulate. Default 30. */
  days?: number;
  /** Multiplier applied to volume each day (1 = flat, 0.95 = −5 %/day). Default 1. */
  volumeDecay?: number;
  /** Fee rate that goes through Float's split, in bps. Default 75 (see DEFAULT_SPLIT_FEE_BPS). */
  feeBps?: number;
  /** Holders' share of the split, in bps. Default 1750 (official). */
  holdersBps?: number;
  /** Parent USD price; derived from `parentPool` when omitted. */
  parentPriceUsd?: number;
  /** Parent pool for price-impact estimates. */
  parentPool?: ParentPoolState;
  /** Per-swap impact cap used to count how many conversions a day needs. Default 100 bps. */
  maxImpactBps?: number;
  /** Mode A: net buys of children (buys − sells) as a share of volume, in bps. Default 0. */
  netInflowBps?: number;
  /** Mode A: probability that a child graduates within the period (0..1). Default 0. */
  graduationProbability?: number;
  /** Mode A: parent locked per graduation, in USD (`real_quote_at_migration − migrate_fee`). Default: official curve raise. */
  lockedPerGraduationUsd?: number;
}

export interface FamilySimDay {
  day: number;
  /** Volume of all children that day, in USD. */
  volumeUsd: number;
  /** Parent handed to child holders that day, in USD. */
  holderRewardsUsd: number;
  /** Parent bought on the market that day, in USD (Mode B: the converted holder share; Mode A: net inflow). */
  parentBuyUsd: number;
  /** Parent tokens bought that day. */
  parentBought: number;
  /** Price impact of that day's buy as a single swap on the parent pool. */
  priceImpact: number | null;
  /** Swaps needed to keep each one within the impact cap. */
  swapsWithinCap: number | null;
}

export interface FamilySimResult {
  mode: "A" | "B";
  parentPriceUsd: number;
  days: FamilySimDay[];
  totals: { volumeUsd: number; holderRewardsUsd: number; parentBuyUsd: number; parentBought: number };
  /** Mode A: expected parent locked forever in graduated children's Burn & Earn liquidity. */
  lockedParentUsd: number;
  lockedParent: number;
  disclaimer: string;
}

function parentPrice(pool: ParentPoolState): number {
  const parent = Number(pool.parentReserve) / 10 ** pool.parentDecimals;
  const paired = Number(pool.pairedReserve) / 10 ** pool.pairedDecimals;
  if (!(parent > 0)) throw new RangeError("Parent pool has no parent reserve");
  return (paired / parent) * pool.pairedPriceUsd;
}

/**
 * Economics model of §7. Mode B: parent bought per day = `V · f · holders`
 * for every child (exact integer formula of `daily_parent_demand`). Mode A:
 * parent bought = net child inflow; holder rewards are already in the parent;
 * graduations lock `N · p · locked` parent forever.
 *
 * Interpretation: each day's buy is measured against the same pool reserves
 * (arbitrage is assumed to restore the pool between days).
 */
export function simulateFamily(input: FamilySimInput): FamilySimResult {
  const mode = input.mode ?? "B";
  const days = input.days ?? 30;
  const decay = input.volumeDecay ?? 1;
  const feeBps = input.feeBps ?? DEFAULT_SPLIT_FEE_BPS;
  const holdersBps = input.holdersBps ?? OFFICIAL_HOLDERS_BPS;
  const maxImpactBps = input.maxImpactBps ?? DEFAULT_MAX_IMPACT_BPS;
  if (!Number.isInteger(input.children) || input.children < 0) throw new RangeError("children must be a non-negative integer");
  if (!Number.isInteger(days) || days < 1) throw new RangeError("days must be >= 1");
  if (!(input.dailyVolumeUsd >= 0) || !(decay > 0)) throw new RangeError("dailyVolumeUsd must be >= 0 and volumeDecay > 0");
  const price = input.parentPriceUsd ?? (input.parentPool ? parentPrice(input.parentPool) : NaN);
  if (!(price > 0)) throw new RangeError("Pass parentPriceUsd or parentPool");

  const pool = input.parentPool;
  const maxIn = pool ? maxHopInput(pool.pairedReserve, pool.parentReserve, pool.fees, maxImpactBps) : 0n;
  const out: FamilySimDay[] = [];
  for (let d = 1; d <= days; d++) {
    const perChild = input.dailyVolumeUsd * decay ** (d - 1);
    const volumeUsd = perChild * input.children;
    const perChildMicro = BigInt(Math.round(perChild * 1e6));
    const holderRewardsUsd = (Number(dailyParentDemand(perChildMicro, feeBps, holdersBps)) / 1e6) * input.children;
    const parentBuyUsd = mode === "B" ? holderRewardsUsd : (volumeUsd * (input.netInflowBps ?? 0)) / 10_000;
    let priceImpact: number | null = null;
    let swapsWithinCap: number | null = null;
    if (pool && parentBuyUsd > 0) {
      const pairedIn = BigInt(Math.round((parentBuyUsd / pool.pairedPriceUsd) * 10 ** pool.pairedDecimals));
      if (pairedIn > 0n) {
        priceImpact = cpmm.swapBaseInput({ amountIn: pairedIn, inputReserve: pool.pairedReserve, outputReserve: pool.parentReserve, ...pool.fees }).priceImpact;
        swapsWithinCap = maxIn > 0n ? Number((pairedIn + maxIn - 1n) / maxIn) : null;
      }
    }
    out.push({ day: d, volumeUsd, holderRewardsUsd, parentBuyUsd, parentBought: parentBuyUsd / price, priceImpact, swapsWithinCap });
  }

  let lockedParentUsd = 0;
  if (mode === "A") {
    const locked = input.lockedPerGraduationUsd ?? curveParamsForTargetUsd(price, { parentDecimals: pool?.parentDecimals ?? 6 }).raiseUsd;
    lockedParentUsd = input.children * (input.graduationProbability ?? 0) * locked;
  }
  const sum = (f: (x: FamilySimDay) => number) => out.reduce((a, x) => a + f(x), 0);
  return {
    mode,
    parentPriceUsd: price,
    days: out,
    totals: { volumeUsd: sum((x) => x.volumeUsd), holderRewardsUsd: sum((x) => x.holderRewardsUsd), parentBuyUsd: sum((x) => x.parentBuyUsd), parentBought: sum((x) => x.parentBought) },
    lockedParentUsd,
    lockedParent: lockedParentUsd / price,
    disclaimer: SIMULATION_DISCLAIMER,
  };
}

// ------------------------------------------------------ on-chain observation

/** CPMM `PoolState.status` bit 2 set = swaps disabled (raydium-cp-swap `PoolStatusBitIndex::Swap`). */
export const CPMM_SWAP_DISABLED_BIT = 1 << 2;

/**
 * True if a Token-2022 mint has the Pausable extension with `paused = true`.
 * Interpretation: Pausable is Token-2022 extension type 26, laid out as
 * `authority (32 bytes) + paused (1 byte)`. Issuers of tokenized assets can
 * pause in other ways too; this only detects this standard one.
 */
export function isMintPaused(data: Uint8Array, owner: PublicKey): boolean {
  if (!owner.equals(TOKEN_2022_PROGRAM_ID) || data.length <= 166) return false;
  let o = 166; // 165-byte base + 1 AccountType byte
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  while (o + 4 <= data.length) {
    const type = view.getUint16(o, true);
    const len = view.getUint16(o + 2, true);
    o += 4;
    if (type === 0) break;
    if (type === 26 && len >= 33) return data[o + 32] === 1;
    o += len;
  }
  return false;
}

export interface ParentObservation {
  input: EligibilityInput;
  /** Pool reserves and fees from the paired side, when the parent has a CPMM pool. */
  pool?: ParentPoolState;
  cpmmPool?: PublicKey;
  launchLabPool?: PublicKey;
  /** Platform config the parent was launched on. */
  platformConfig?: PublicKey;
  notes: string[];
}

export interface ObserveParentOptions {
  /** Paired mint of the parent's LaunchLab pool. Default WSOL. */
  pairedMint?: PublicKey;
  /** Float's LaunchLab platform config. Not listed in the official docs: read it from a known Float coin. */
  platformConfig?: PublicKey;
  /** USD price of one paired token. Default 1 for USDC; required for other pairs. */
  pairedPriceUsd?: number;
  /** Explicit CPMM pool (needed for $FLOAT, whose pool is not derived from a LaunchLab migration). */
  cpmmPool?: PublicKey;
  /** Unix seconds; default now. */
  now?: bigint;
}

/**
 * Reads everything §3 needs from chain data only (rule 2: no guessing at the
 * Float program).
 *
 * Interpretations:
 * - "Float coin" = its LaunchLab pool uses `platformConfig`.
 * - Graduation time = the CPMM pool's `open_time` (spec §3).
 * - Paused = parent pool swaps disabled, or the paired mint's Token-2022 Pausable flag.
 * - Depth = 0: no FamilyRecord exists on mainnet until Phase 2.
 */
export async function observeParent(conn: Connection, parent: PublicKey, opts: ObserveParentOptions = {}): Promise<ParentObservation> {
  const now = opts.now ?? BigInt(Math.floor(Date.now() / 1000));
  const notes: string[] = [];
  const isFlagship = parent.equals(FLOAT.flagshipMint);
  const pairedMint = opts.pairedMint ?? MINTS.WSOL;
  const pairedPriceUsd = opts.pairedPriceUsd ?? (pairedMint.equals(MINTS.USDC) ? 1 : undefined);

  let launchLabPool: PublicKey | undefined;
  let platformConfig: PublicKey | undefined;
  let cpmmPool = opts.cpmmPool;
  let graduated = false;
  if (isFlagship && !cpmmPool) notes.push("No CPMM pool given for $FLOAT (pass its $FLOAT/SOL pool): price impact not estimated.");
  if (!isFlagship) {
    launchLabPool = launchLab.launchLabPda.pool(parent, pairedMint);
    const b = await launchLab.fetchLaunchLabPool(conn, launchLabPool);
    platformConfig = b.pool.platform_config;
    graduated = b.pool.status === launchLab.PoolStatus.Trade;
    if (!opts.platformConfig) notes.push("No --platform-config given: cannot confirm this is a Float coin.");
    if (graduated && !cpmmPool) {
      if (b.pool.migrate_type !== 1) notes.push("Graduated to an AMM v4 pool, not CPMM: not supported.");
      else {
        const [m0, m1] = cpmm.sortMints(b.pool.base_mint, b.pool.quote_mint);
        cpmmPool = cpmm.cpmmPda.pool(b.platformConfig.cpswap_config, m0, m1);
      }
    }
  }

  let pool: ParentPoolState | undefined;
  let graduatedAt = 0n;
  let poolPaused = false;
  let poolPairedUsd = 0n;
  if (cpmmPool && (graduated || isFlagship)) {
    const cb = await cpmm.fetchCpmmPool(conn, cpmmPool);
    const parentIs0 = cb.pool.token_0_mint.equals(parent);
    if (!parentIs0 && !cb.pool.token_1_mint.equals(parent)) throw new Error("CPMM pool does not hold the parent mint");
    const pairedSide = parentIs0 ? cb.pool.token_1_mint : cb.pool.token_0_mint;
    const side = poolSide(cb, pairedSide);
    graduatedAt = cb.pool.open_time;
    poolPaused = (cb.pool.status & CPMM_SWAP_DISABLED_BIT) !== 0;
    const pairedDecimals = parentIs0 ? cb.pool.mint_1_decimals : cb.pool.mint_0_decimals;
    if (pairedPriceUsd === undefined) notes.push("No paired-token USD price given: liquidity rule not evaluated.");
    else {
      poolPairedUsd = BigInt(Math.floor((Number(side.inputReserve) / 10 ** pairedDecimals) * pairedPriceUsd * 1e6));
      pool = {
        parentReserve: side.outputReserve,
        pairedReserve: side.inputReserve,
        parentDecimals: parentIs0 ? cb.pool.mint_0_decimals : cb.pool.mint_1_decimals,
        pairedDecimals,
        pairedPriceUsd,
        fees: side.fees,
      };
    }
    const mintAcc = await conn.getAccountInfo(pairedSide);
    if (mintAcc && isMintPaused(mintAcc.data, mintAcc.owner)) poolPaused = true;
  }

  return {
    input: {
      kind: isFlagship ? "Flagship" : "Coin",
      isFloatCoin: Boolean(opts.platformConfig && platformConfig?.equals(opts.platformConfig)),
      graduatedAt: graduated ? graduatedAt : 0n,
      now,
      poolPairedUsd,
      pairedPaused: poolPaused,
      parentDepth: 0,
    },
    ...(pool ? { pool } : {}),
    ...(cpmmPool ? { cpmmPool } : {}),
    ...(launchLabPool ? { launchLabPool } : {}),
    ...(platformConfig ? { platformConfig } : {}),
    notes,
  };
}
