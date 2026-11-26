/**
 * Fair Launch Lobby (docs/proposals/fair-launch-lobby.md): deposits first,
 * then coin creation plus one same-price buy in a single transaction.
 *
 * - Math: exact mirror of `float-core::lobby` (params, phases, running
 *   totals, caps from curve reserves, allocation, unlock). Shared vectors in
 *   `crates/float-core/tests/fixtures/lobby-allocation.json`.
 * - PDAs of §7 under the float-router program id (no on-chain code yet).
 * - `simulateLobby`: allocation table, uniform price, refunds and the curve
 *   price after the lobby versus genesis.
 *
 * Not an official Float feature.
 */

import { PublicKey, findProgramAddress } from "../core/pubkey.ts";
import type { Connection } from "../core/rpc.ts";
import * as launchLab from "../raydium/launchlab.ts";
import { FEE_RATE_DENOMINATOR, cpAmountIn, preFeeAmount as sdkPreFee } from "../raydium/math.ts";
import { ROUTER_PROGRAM_ID } from "../router/index.ts";

const U64_MAX = (1n << 64n) - 1n;
const BPS = 10_000n;

export const MAX_LOBBY_SUPPLY_BPS = 2_000;
export const DEFAULT_DURATION_SECS = 600;
export const DEFAULT_LOCK_WINDOW_SECS = 60;
export const DEFAULT_FINALIZE_GRACE_SECS = 600;
export const DEFAULT_MIN_WALLETS = 10;
export const DEFAULT_MAX_SUPPLY_BPS = 1_500;
export const DEFAULT_WALLET_SUPPLY_BPS = 100;
/**
 * Today's rule the lobby replaces: "On the launch form, that first buy is
 * capped at 2% of the supply" (https://www.floatlaunch.xyz/docs, How it works).
 * Lobby caps above it need Float's agreement (spec §3).
 */
export const OFFICIAL_FIRST_BUY_CAP_BPS = 200;

// ------------------------------------------------------------------ errors

/** Same names as the matching `float_core::CoreError` variants. */
export type LobbyErrorCode = "MathOverflow" | "InvalidReserves" | "InvalidParams" | "LobbyWrongPhase" | "WalletCapExceeded" | "InsufficientDeposit";

export class LobbyError extends Error {
  readonly code: LobbyErrorCode;
  constructor(code: LobbyErrorCode, message?: string) {
    super(message ?? code);
    this.name = "LobbyError";
    this.code = code;
  }
}

const fail = (code: LobbyErrorCode, message?: string): never => {
  throw new LobbyError(code, message);
};

function u64(x: bigint, what: string): bigint {
  if (x < 0n || x > U64_MAX) throw new RangeError(`${what} must fit in a u64`);
  return x;
}
const toU64 = (x: bigint) => (x > U64_MAX ? fail("MathOverflow") : x);

// ------------------------------------------------------------------ params

export interface LobbyParams {
  durationSecs: number;
  lockWindowSecs: number;
  finalizeGraceSecs: number;
  /** Quorum in paired-token units (launcher-set). */
  minRaise: bigint;
  minWallets: number;
  maxSupplyBps: number;
  walletSupplyBps: number;
  unlockSecs: number;
}

export const lobbyParamsWithDefaults = (minRaise: bigint): LobbyParams => ({
  durationSecs: DEFAULT_DURATION_SECS,
  lockWindowSecs: DEFAULT_LOCK_WINDOW_SECS,
  finalizeGraceSecs: DEFAULT_FINALIZE_GRACE_SECS,
  minRaise,
  minWallets: DEFAULT_MIN_WALLETS,
  maxSupplyBps: DEFAULT_MAX_SUPPLY_BPS,
  walletSupplyBps: DEFAULT_WALLET_SUPPLY_BPS,
  unlockSecs: 0,
});

/** Mirror of `LobbyParams::validate`; the message names the first violated bound. */
export function validateLobbyParams(p: LobbyParams): void {
  const int = (v: number, max: number) => Number.isInteger(v) && v >= 0 && v <= max;
  if (!int(p.durationSecs, 0xffff_ffff) || !int(p.lockWindowSecs, 0xffff_ffff) || !int(p.finalizeGraceSecs, 0xffff_ffff) || !int(p.unlockSecs, 0xffff_ffff) || !int(p.minWallets, 0xffff_ffff)) {
    throw new RangeError("Lobby durations and minWallets must be u32 integers");
  }
  if (!int(p.maxSupplyBps, 0xffff) || !int(p.walletSupplyBps, 0xffff)) throw new RangeError("Supply shares must be u16 integers");
  u64(p.minRaise, "minRaise");
  const checks: [boolean, string][] = [
    [p.durationSecs >= 120 && p.durationSecs <= 3_600, "durationSecs must be 120-3600"],
    [p.lockWindowSecs <= Math.floor(p.durationSecs / 2), "lockWindowSecs must be <= durationSecs / 2"],
    [p.finalizeGraceSecs >= 60 && p.finalizeGraceSecs <= 3_600, "finalizeGraceSecs must be 60-3600"],
    [p.minRaise > 0n, "minRaise must be > 0"],
    [p.minWallets >= 1 && p.minWallets <= 1_000, "minWallets must be 1-1000"],
    [p.maxSupplyBps >= 1 && p.maxSupplyBps <= MAX_LOBBY_SUPPLY_BPS, `maxSupplyBps must be 1-${MAX_LOBBY_SUPPLY_BPS}`],
    [p.walletSupplyBps >= 1 && p.walletSupplyBps <= p.maxSupplyBps, "walletSupplyBps must be 1-maxSupplyBps"],
    [p.unlockSecs <= 3_600, "unlockSecs must be 0-3600"],
  ];
  for (const [ok, msg] of checks) if (!ok) fail("InvalidParams", msg);
}

// --------------------------------------------------------------- lifecycle

export interface Timing {
  openAt: bigint;
  lockAt: bigint;
  endAt: bigint;
  finalizeDeadline: bigint;
}

const I64_MAX = (1n << 63n) - 1n;

/** Mirror of `Timing::new`. */
export function lobbyTiming(openAt: bigint, p: LobbyParams): Timing {
  validateLobbyParams(p);
  const endAt = openAt + BigInt(p.durationSecs);
  const finalizeDeadline = endAt + BigInt(p.finalizeGraceSecs);
  if (endAt > I64_MAX || finalizeDeadline > I64_MAX) fail("MathOverflow");
  return { openAt, lockAt: endAt - BigInt(p.lockWindowSecs), endAt, finalizeDeadline };
}

export type LobbyState = "Open" | "Finalized" | "Cancelled";
export type Phase = "Pending" | "Open" | "Locked" | "Finalizable" | "Expired" | "Finalized" | "Cancelled";
export type Action = "Deposit" | "Withdraw" | "Finalize" | "Cancel" | "Claim" | "Refund";

/** Mirror of `phase_at`. */
export function phaseAt(t: Timing, state: LobbyState, quorumMet: boolean, now: bigint): Phase {
  if (state !== "Open") return state;
  if (now < t.openAt) return "Pending";
  if (now < t.lockAt) return "Open";
  if (now < t.endAt) return "Locked";
  if (now <= t.finalizeDeadline && quorumMet) return "Finalizable";
  return "Expired";
}

/** Mirror of `quorum_met`. */
export const quorumMet = (totalDeposits: bigint, depositors: number, p: LobbyParams): boolean => totalDeposits >= p.minRaise && depositors >= p.minWallets;

/** Mirror of `check_action`. */
export function checkAction(phase: Phase, action: Action, isLauncher: boolean): void {
  const ok = {
    Deposit: phase === "Open" || phase === "Locked",
    Withdraw: phase === "Open",
    Finalize: phase === "Finalizable",
    Cancel: phase === "Expired" || (isLauncher && (phase === "Pending" || phase === "Open")),
    Claim: phase === "Finalized",
    Refund: phase === "Cancelled",
  }[action];
  if (!ok) fail("LobbyWrongPhase");
}

export interface LobbyTotals {
  totalDeposits: bigint;
  depositors: number;
}

/** Mirror of `LobbyTotals::deposit`: returns the new totals and the wallet's new deposit. */
export function applyDeposit(t: LobbyTotals, walletDeposit: bigint, amount: bigint, walletCap: bigint): { totals: LobbyTotals; deposit: bigint } {
  if (u64(amount, "amount") === 0n) fail("InvalidParams");
  const deposit = u64(walletDeposit, "walletDeposit") + amount;
  if (deposit > U64_MAX || deposit > walletCap) fail("WalletCapExceeded");
  const total = toU64(t.totalDeposits + amount);
  return { deposit, totals: { totalDeposits: total, depositors: walletDeposit === 0n ? t.depositors + 1 : t.depositors } };
}

/** Mirror of `LobbyTotals::withdraw` (a full withdrawal stops counting the wallet). */
export function applyWithdraw(t: LobbyTotals, walletDeposit: bigint, amount: bigint): { totals: LobbyTotals; deposit: bigint } {
  if (u64(amount, "amount") === 0n) fail("InvalidParams");
  if (amount > walletDeposit) fail("InsufficientDeposit");
  if (amount > t.totalDeposits || (walletDeposit === amount && t.depositors === 0)) fail("MathOverflow");
  const deposit = walletDeposit - amount;
  return { deposit, totals: { totalDeposits: t.totalDeposits - amount, depositors: deposit === 0n ? t.depositors - 1 : t.depositors } };
}

// -------------------------------------------------------------- curve math

export interface CurveState {
  virtualBase: bigint;
  virtualQuote: bigint;
  realBase: bigint;
  realQuote: bigint;
  totalBaseSell: bigint;
}

export const genesisCurve = (virtualBase: bigint, virtualQuote: bigint, totalBaseSell: bigint): CurveState => ({ virtualBase, virtualQuote, realBase: 0n, realQuote: 0n, totalBaseSell });

function reserves(s: CurveState): { base: bigint; quote: bigint } {
  if (s.realBase > s.virtualBase) fail("InvalidReserves");
  const base = s.virtualBase - s.realBase;
  const quote = toU64(s.virtualQuote + s.realQuote);
  if (base === 0n || quote === 0n) fail("InvalidReserves");
  return { base, quote };
}

function remaining(s: CurveState): bigint {
  return s.totalBaseSell < s.realBase ? fail("InvalidReserves") : s.totalBaseSell - s.realBase;
}

function checkFeeRate(feeRate: bigint) {
  if (feeRate < 0n || feeRate >= FEE_RATE_DENOMINATOR) fail("InvalidParams");
}

/** Mirror of `pre_fee_amount` (the SDK's `preFeeAmount`, with float-core's checks). */
export function preFeeAmount(net: bigint, feeRate: bigint): bigint {
  checkFeeRate(feeRate);
  return toU64(sdkPreFee(u64(net, "net"), feeRate));
}

export interface BuyQuote {
  amountIn: bigint;
  amountOut: bigint;
  fee: bigint;
  capped: boolean;
}

/**
 * Mirror of `quote_buy_exact_in`, delegating to `launchLab.quoteBuyExactIn`
 * (the model float-core ports). Interpretation: one combined LaunchLab fee
 * rate, rounded up, as in the SDK.
 */
export function quoteBuyExactIn(s: CurveState, amountIn: bigint, feeRate: bigint): BuyQuote {
  checkFeeRate(feeRate);
  u64(amountIn, "amountIn");
  reserves(s);
  remaining(s);
  const pool = { virtual_base: s.virtualBase, virtual_quote: s.virtualQuote, real_base: s.realBase, real_quote: s.realQuote, total_base_sell: s.totalBaseSell } as launchLab.LaunchLabPool;
  const q = launchLab.quoteBuyExactIn(pool, amountIn, { protocol: feeRate, platform: 0n, creator: 0n, share: 0n });
  return { amountIn: toU64(q.amountIn), amountOut: toU64(q.amountOut), fee: q.fees.total, capped: q.capped };
}

/** Mirror of `net_quote_for`: `ceil(vq · s / (vb − s))`. */
export function netQuoteFor(s: CurveState, coins: bigint): bigint {
  const r = reserves(s);
  if (u64(coins, "coins") >= r.base) fail("InvalidReserves");
  return toU64(cpAmountIn(coins, r.quote, r.base));
}

/** Mirror of `gross_for`: the closed form of §6.1. */
export const grossFor = (s: CurveState, coins: bigint, feeRate: bigint): bigint => preFeeAmount(netQuoteFor(s, coins), feeRate);

/** Mirror of `supply_share`. */
export function supplyShare(supply: bigint, bps: number): bigint {
  const v = (u64(supply, "supply") * BigInt(bps)) / BPS;
  return v > U64_MAX ? U64_MAX : v;
}

/** Mirror of `cap_for_supply_bps`: the largest gross whose exact quote buys at most `bps` of supply. */
export function capForSupplyBps(s: CurveState, supply: bigint, bps: number, feeRate: bigint): bigint {
  checkFeeRate(feeRate);
  const target = supplyShare(supply, bps);
  if (target >= remaining(s)) fail("InvalidParams", "The supply share is not below the coins left on the curve");
  const out = (g: bigint) => quoteBuyExactIn(s, g, feeRate).amountOut;
  let lo = grossFor(s, target, feeRate);
  lo = lo > 0n ? lo - 1n : 0n;
  let hi = grossFor(s, target + 1n, feeRate) - 1n;
  if (hi < 0n || out(lo) > target) fail("MathOverflow");
  while (lo < hi) {
    const mid = lo + (hi - lo + 1n) / 2n;
    if (out(mid) <= target) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

export interface Caps {
  maxRaise: bigint;
  walletCap: bigint;
}

/** Mirror of `caps`. */
export function lobbyCaps(s: CurveState, supply: bigint, p: LobbyParams, feeRate: bigint): Caps {
  validateLobbyParams(p);
  return { maxRaise: capForSupplyBps(s, supply, p.maxSupplyBps, feeRate), walletCap: capForSupplyBps(s, supply, p.walletSupplyBps, feeRate) };
}

// -------------------------------------------------------------- allocation

export const raiseSpent = (totalDeposits: bigint, maxRaise: bigint): bigint => (totalDeposits < maxRaise ? totalDeposits : maxRaise);

export interface Allocation {
  refund: bigint;
  spent: bigint;
  tokens: bigint;
}

/** Mirror of `claim_amounts` (§6.2). */
export function claimAmounts(deposit: bigint, totalDeposits: bigint, raise: bigint, tokensBought: bigint): Allocation {
  for (const [v, n] of [[deposit, "deposit"], [totalDeposits, "totalDeposits"], [raise, "raiseSpent"], [tokensBought, "tokensBought"]] as const) u64(v, n);
  if (totalDeposits === 0n || deposit > totalDeposits || raise > totalDeposits) fail("InvalidParams");
  const refund = (deposit * (totalDeposits - raise)) / totalDeposits;
  return { refund, spent: deposit - refund, tokens: (tokensBought * deposit) / totalDeposits };
}

/** Mirror of `fee_share` (weighted by deposit, §10). */
export function feeShare(feeTotal: bigint, deposit: bigint, totalDeposits: bigint): bigint {
  if (totalDeposits === 0n || deposit > totalDeposits) fail("InvalidParams");
  return (u64(feeTotal, "feeTotal") * deposit) / totalDeposits;
}

/** Mirror of `claimable` (§6.3). */
export function claimable(tokens: bigint, finalizedAt: bigint, now: bigint, unlockSecs: number, alreadyClaimed: bigint): bigint {
  let unlocked = u64(tokens, "tokens");
  if (unlockSecs > 0) {
    let elapsed = now - finalizedAt;
    if (elapsed < 0n) elapsed = 0n;
    if (elapsed > BigInt(unlockSecs)) elapsed = BigInt(unlockSecs);
    unlocked = (tokens * elapsed) / BigInt(unlockSecs);
  }
  return alreadyClaimed > unlocked ? fail("MathOverflow") : unlocked - alreadyClaimed;
}

// -------------------------------------------------------------------- PDAs

const enc = (s: string) => new TextEncoder().encode(s);
const u64le = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};

/** PDAs of spec §7 (reference implementation inside float-router). */
export function lobbyPda(programId: PublicKey = ROUTER_PROGRAM_ID) {
  const f = (seeds: (Uint8Array | PublicKey)[]) => findProgramAddress(seeds, programId).address;
  return {
    lobby: (launcher: PublicKey, nonce: bigint) => f([enc("lobby"), launcher, u64le(nonce)]),
    deposit: (lobby: PublicKey, wallet: PublicKey) => f([enc("lobby_dep"), lobby, wallet]),
    quoteEscrow: (lobby: PublicKey) => f([enc("lobby_quote"), lobby]),
    baseVault: (lobby: PublicKey) => f([enc("lobby_base"), lobby]),
    solPayer: (lobby: PublicKey) => f([enc("lobby_sol"), lobby]),
    mint: (lobby: PublicKey) => f([enc("lobby_mint"), lobby]),
    tickerReservation: (ticker: string) => f([enc("ticker_res"), enc(ticker)]),
  };
}

// ---------------------------------------------------------------- reserves

export interface GenesisCurve {
  virtualBase: bigint;
  virtualQuote: bigint;
  totalBaseSell: bigint;
  supply: bigint;
  baseDecimals: number;
  quoteDecimals: number;
  /** Total LaunchLab fee rate (protocol + platform + creator), 1e-6 units. */
  feeRate: bigint;
  /** Where the numbers came from. */
  source: string;
}

/**
 * Genesis curve of a new lobby coin, read from an existing LaunchLab pool.
 *
 * Interpretation (spec §6.1 Assumption): every coin launched on the same
 * platform curve (same global config, Float platform config and quote mint)
 * starts from the same virtual reserves, so an existing pool's
 * `virtual_base` / `virtual_quote` (which trading never changes) are the
 * new coin's genesis reserves.
 */
export async function genesisFromPool(conn: Connection, pool: PublicKey): Promise<GenesisCurve> {
  const b = await launchLab.fetchLaunchLabPool(conn, pool);
  return {
    virtualBase: b.pool.virtual_base,
    virtualQuote: b.pool.virtual_quote,
    totalBaseSell: b.pool.total_base_sell,
    supply: b.pool.supply,
    baseDecimals: b.pool.base_decimals,
    quoteDecimals: b.pool.quote_decimals,
    feeRate: launchLab.totalFeeRate(launchLab.feeRatesOf(b)),
    source: `LaunchLab pool ${pool.toBase58()}`,
  };
}

// --------------------------------------------------------------- simulator

export interface LobbyDeposit {
  wallet: string;
  amount: bigint;
}

export interface LobbySimRow {
  wallet: string;
  /** Requested total (all rows of the wallet). */
  requested: bigint;
  /** Accepted deposit `d_i` (requested capped at `walletCap`). */
  deposit: bigint;
  refund: bigint;
  spent: bigint;
  tokens: bigint;
  feeShare: bigint;
}

export interface LobbySimResult {
  caps: Caps;
  totalDeposits: bigint;
  depositors: number;
  quorumMet: boolean;
  /** "finalized" if quorum was met, otherwise "cancelled" (every deposit refunded). */
  outcome: "finalized" | "cancelled";
  raiseSpent: bigint;
  tokensBought: bigint;
  /** LaunchLab fee paid by the lobby buy. */
  fee: bigint;
  rows: LobbySimRow[];
  quoteDust: bigint;
  tokenDust: bigint;
  /** Uniform price `R / B`, paired raw units per coin raw unit (fees included). */
  uniformPriceRaw: number;
  /** Curve spot price at genesis and right after the lobby buy (paired raw per coin raw). */
  genesisPriceRaw: number;
  postLobbyPriceRaw: number;
  /** Share of supply the lobby bought. */
  supplyBought: number;
}

/**
 * Simulates a lobby: per-wallet deposits are summed and capped at
 * `walletCap` (on chain the excess deposit would fail; a UI caps the input),
 * then caps, quorum, the single buy and every claim are computed with the
 * mirrored float-core math.
 */
export function simulateLobby(deposits: LobbyDeposit[], params: LobbyParams, curve: GenesisCurve): LobbySimResult {
  const state = genesisCurve(curve.virtualBase, curve.virtualQuote, curve.totalBaseSell);
  const caps = lobbyCaps(state, curve.supply, params, curve.feeRate);

  const requested = new Map<string, bigint>();
  for (const d of deposits) requested.set(d.wallet, (requested.get(d.wallet) ?? 0n) + u64(d.amount, `deposit of ${d.wallet}`));
  let totals: LobbyTotals = { totalDeposits: 0n, depositors: 0 };
  const accepted = new Map<string, bigint>();
  for (const [wallet, amount] of requested) {
    const d = amount > caps.walletCap ? caps.walletCap : amount;
    if (d === 0n) continue;
    totals = applyDeposit(totals, 0n, d, caps.walletCap).totals;
    accepted.set(wallet, d);
  }

  const met = quorumMet(totals.totalDeposits, totals.depositors, params);
  const D = totals.totalDeposits;
  const R = met ? raiseSpent(D, caps.maxRaise) : 0n;
  const q = met && R > 0n ? quoteBuyExactIn(state, R, curve.feeRate) : { amountIn: 0n, amountOut: 0n, fee: 0n, capped: false };
  const B = q.amountOut;
  const rows: LobbySimRow[] = [...requested].map(([wallet, req]) => {
    const d = accepted.get(wallet) ?? 0n;
    const a = D > 0n && d > 0n ? claimAmounts(d, D, R, B) : { refund: d, spent: 0n, tokens: 0n };
    return { wallet, requested: req, deposit: d, ...a, feeShare: D > 0n && d > 0n ? feeShare(q.fee, d, D) : 0n };
  });
  const sum = (f: (r: LobbySimRow) => bigint) => rows.reduce((a, r) => a + f(r), 0n);

  const genesis = Number(curve.virtualQuote) / Number(curve.virtualBase);
  const net = q.amountIn - q.fee;
  const post = B > 0n ? Number(curve.virtualQuote + net) / Number(curve.virtualBase - B) : genesis;
  return {
    caps,
    totalDeposits: D,
    depositors: totals.depositors,
    quorumMet: met,
    outcome: met ? "finalized" : "cancelled",
    raiseSpent: R,
    tokensBought: B,
    fee: q.fee,
    rows,
    quoteDust: D - R - sum((r) => r.refund),
    tokenDust: B - sum((r) => r.tokens),
    uniformPriceRaw: B > 0n ? Number(R) / Number(B) : 0,
    genesisPriceRaw: genesis,
    postLobbyPriceRaw: post,
    supplyBought: Number(B) / Number(curve.supply),
  };
}
