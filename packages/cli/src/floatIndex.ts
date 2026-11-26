/**
 * `float index …`: Float Index (docs/proposals/float-index.md).
 * Read-only: nothing here sends a transaction.
 */
import { readFileSync } from "node:fs";
import { PublicKey, floatIndex as x } from "@float-community/sdk";
import { type Args, UsageError, bool, connection, flag, json, pct, table } from "./util.ts";

type Out = (s: string) => void;

const USAGE = `Usage:
  float index weights --stats <stats.json> [--platform-config <addr>] [--discover]
              [--n ${x.DEFAULT_N}] [--cap-bps ${x.DEFAULT_CAP_BPS}] [--liq-factor-bps ${x.DEFAULT_LIQ_FACTOR_BPS}] [--aum-usd <usd>]
              [--min-pool-usd ${x.DEFAULT_MIN_POOL_PAIRED_USD}] [--min-age-days 7]
  float index simulate --deposit <sol> --days <n> --stats <stats.json> [--sol-usd <price>] [same methodology flags]
  stats.json format: see docs/developers/cli.md or examples/index-stats.sample.json`;

export async function floatIndex(args: Args, out: Out) {
  const sub = args._[1];
  if (sub === "weights") return weights(args, out);
  if (sub === "simulate") return simulate(args, out);
  throw new UsageError(USAGE);
}

function num(args: Args, name: string): number | undefined {
  const v = flag(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number`);
  return n;
}

async function methodology(args: Args) {
  const file = flag(args, "stats");
  if (!file) throw new UsageError(`Missing --stats\n\n${USAGE}`);
  const stats = x.parseIndexStats(JSON.parse(readFileSync(file, "utf8")));
  const pcFlag = flag(args, "platform-config") ?? stats.platformConfig;
  const platformConfig = pcFlag ? new PublicKey(pcFlag) : undefined;
  const conn = connection(args);
  const extra = bool(args, "discover") && platformConfig ? await x.discoverFloatCoins(conn, platformConfig) : [];
  const coins = await x.observeIndexCoins(conn, stats, { ...(platformConfig ? { platformConfig } : {}), extra });
  const opt = <K extends keyof x.MethodologyParams>(k: K, v: x.MethodologyParams[K] | undefined) => (v === undefined ? {} : { [k]: v });
  const minAgeDays = num(args, "min-age-days");
  const m = x.computeMethodology(coins, {
    ...opt("n", num(args, "n")),
    ...opt("capBps", num(args, "cap-bps")),
    ...opt("liqFactorBps", num(args, "liq-factor-bps")),
    ...opt("aumUsd", num(args, "aum-usd")),
    ...opt("minPoolPairedUsd", num(args, "min-pool-usd")),
    ...opt("minAgeSecs", minAgeDays === undefined ? undefined : Math.round(minAgeDays * 86_400)),
  });
  return { stats, coins, m, platformConfig };
}

const usd = (v?: number) => (v === undefined ? "-" : `$${Math.round(v).toLocaleString("en-US")}`);
const cents = (v: number) => `$${v !== 0 && Math.abs(v) < 1 ? v.toPrecision(3) : v.toFixed(2)}`;
const short = (k: PublicKey) => `${k.toBase58().slice(0, 4)}…${k.toBase58().slice(-4)}`;

// ---------------------------------------------------------------- weights

async function weights(args: Args, out: Out) {
  const { m, stats, platformConfig } = await methodology(args);
  if (bool(args, "json")) {
    out(json({ asOf: stats.asOf ?? null, platformConfig: platformConfig ?? null, basket: m.basket, rows: m.rows, error: m.error ?? null }));
    return;
  }
  const rows = [...m.rows].sort((a, b) => b.weightBps - a.weightBps || (a.rank ?? 99) - (b.rank ?? 99));
  const lines = [
    `Float Index methodology${stats.asOf ? ` (stats as of ${stats.asOf})` : ""}`,
    platformConfig ? `Float platform config: ${platformConfig.toBase58()}` : "No platform config given (--platform-config or stats.platformConfig): no coin can be confirmed as a Float coin.",
    "",
    table(
      rows.map((r) => ({
        coin: short(r.mint),
        in: r.included ? "IN" : "out",
        weight: r.included ? pct(r.weightBps / 10_000) : "",
        rank: r.rank ?? "",
        fees_30d: usd(r.fees30dUsd),
        mcap: usd(r.mcapUsd),
        pool_paired: usd(r.poolPairedUsd),
        why: r.reason,
      })),
    ),
    "",
    m.error ? `No basket: ${m.error}` : `Basket: ${m.basket.length} coins, weights sum to ${pct(m.basket.reduce((a, b) => a + b.weightBps, 0) / 10_000)}.`,
    "Float Index is a community proposal, not an official Float feature.",
  ];
  out(lines.join("\n"));
}

// --------------------------------------------------------------- simulate

async function simulate(args: Args, out: Out) {
  const deposit = num(args, "deposit");
  const days = num(args, "days");
  if (deposit === undefined || days === undefined) throw new UsageError(`Missing --deposit or --days\n\n${USAGE}`);
  const { m, coins, stats } = await methodology(args);
  if (m.basket.length === 0) throw new Error(`No basket to simulate: ${m.error ?? "no eligible coins"}`);
  const solUsd = num(args, "sol-usd") ?? stats.prices?.SOL ?? stats.prices?.WSOL;
  if (solUsd === undefined) throw new UsageError("Pass --sol-usd or set prices.SOL in stats.json");
  const byMint = new Map(coins.map((c) => [c.mint.toBase58(), c]));
  const sim = x.simulateIndex({
    depositSol: deposit,
    days,
    solUsd,
    windowDays: stats.windowDays ?? 30,
    basket: m.basket.map((b) => ({ ...b, coin: byMint.get(b.mint.toBase58())! })),
  });
  if (bool(args, "json")) {
    out(json(sim));
    return;
  }
  const lines = [
    `Float Index simulation: deposit ${deposit} SOL ($${(deposit * solUsd).toLocaleString("en-US")}), ${days} days`,
    `Creation fee ${x.DEFAULT_CREATION_FEE_BPS} bps: ${sim.feeSol.toFixed(6)} SOL → $FLOAT buyback (proposal). Net ${sim.netSol.toFixed(6)} SOL buys the basket.`,
    "",
    table(
      sim.rows.map((r) => ({
        coin: short(r.mint),
        weight: pct(r.weightBps / 10_000),
        spend: usd(r.spendUsd),
        coins: r.coinsBought.toLocaleString("en-US", { maximumFractionDigits: 2 }),
        buy_impact: r.buyImpact === null ? "-" : pct(r.buyImpact),
        rewards_day: cents(r.rewardsUsdPerDay),
        redeem: usd(r.redeemUsd),
      })),
    ),
    "",
    `Shares (genesis epoch, 1 share = 1 lamport): ${sim.genesisShares.toLocaleString("en-US")}`,
    `Holder rewards passed through: ${cents(sim.rewardsUsdPerDay)}/day → ${cents(sim.rewardsUsdTotal)} over ${days} days`,
    `Redeem in kind and sell back through the same pools: ${usd(sim.redeemUsd)}`,
    "",
    sim.disclaimer,
  ];
  out(lines.join("\n"));
}
