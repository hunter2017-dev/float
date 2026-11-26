/**
 * `float family …`: Coin Families (docs/proposals/coin-families.md).
 * Read-only: nothing here sends a transaction.
 */
import { PublicKey, families as f } from "@float-community/sdk";
import { type Args, UsageError, bool, connection, flag, json, pct, requireArg, resolveMint, table } from "./util.ts";

type Out = (s: string) => void;

const USAGE = `Usage:
  float family check <parent> --platform-config <addr> [--pair SOL] [--paired-usd <price>]
               [--pool <cpmm-pool>] [--min-age-days 7] [--min-pool-usd 100000] [--max-depth 2]
  float family simulate --parent <mint> --children <n> --volume <usd-per-child-per-day>
               [--days 30] [--mode B|A] [--fee-bps ${f.DEFAULT_SPLIT_FEE_BPS}] [--holders-bps ${f.OFFICIAL_HOLDERS_BPS}] [--decay 1]
               [--pair SOL] [--paired-usd <price>] [--pool <cpmm-pool>] [--price-usd <parent price>]
               [--net-inflow-bps 0] [--grad-prob 0] [--locked-usd <usd>]   (Mode A)`;

export async function family(args: Args, out: Out) {
  const sub = args._[1];
  if (sub === "check") return check(args, out);
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

function int(args: Args, name: string): number | undefined {
  const n = num(args, name);
  if (n !== undefined && !Number.isInteger(n)) throw new UsageError(`--${name} must be an integer`);
  return n;
}

function observeOptions(args: Args): f.ObserveParentOptions {
  const pc = flag(args, "platform-config");
  const pool = flag(args, "pool");
  const pairedUsd = num(args, "paired-usd");
  return {
    pairedMint: resolveMint(flag(args, "pair")),
    ...(pc ? { platformConfig: new PublicKey(pc) } : {}),
    ...(pool ? { cpmmPool: new PublicKey(pool) } : {}),
    ...(pairedUsd !== undefined ? { pairedPriceUsd: pairedUsd } : {}),
  };
}

// ------------------------------------------------------------------ check

async function check(args: Args, out: Out) {
  const parent = new PublicKey(requireArg(args, 2, "parent"));
  const params: f.EligibilityParams = {
    parentMinAgeSecs: BigInt(Math.round((num(args, "min-age-days") ?? 7) * 86_400)),
    parentMinPoolUsd: BigInt(Math.round((num(args, "min-pool-usd") ?? 100_000) * 1e6)),
    maxDepth: int(args, "max-depth") ?? f.DEFAULT_MAX_DEPTH,
  };
  const obs = await f.observeParent(connection(args), parent, observeOptions(args));
  let error: f.FamilyError | undefined;
  try {
    f.checkParentEligibility(params, obs.input);
  } catch (e) {
    if (!(e instanceof f.FamilyError)) throw e;
    error = e;
  }
  const rules = f.explainEligibility(params, obs.input);
  if (bool(args, "json")) {
    out(json({ parent, eligible: !error, error: error?.code ?? null, rules, notes: obs.notes, launchLabPool: obs.launchLabPool, cpmmPool: obs.cpmmPool, platformConfig: obs.platformConfig }));
    return;
  }
  const lines = [
    `Parent candidate: ${parent.toBase58()}${obs.input.kind === "Flagship" ? " ($FLOAT)" : ""}`,
    ...(obs.platformConfig ? [`Platform config:  ${obs.platformConfig.toBase58()}`] : []),
    ...(obs.cpmmPool ? [`CPMM pool:        ${obs.cpmmPool.toBase58()}`] : []),
    "",
    table(rules.map((r) => ({ rule: r.rule, ok: r.ok ? "yes" : "NO", detail: r.detail }))),
    "",
    error ? `Not eligible as a parent: ${error.code}.` : "Eligible as a parent (Coin Families §3).",
    ...obs.notes.map((n) => `Note: ${n}`),
    "Coin Families is a community proposal, not an official Float feature.",
  ];
  out(lines.join("\n"));
}

// --------------------------------------------------------------- simulate

async function simulate(args: Args, out: Out) {
  const parentArg = flag(args, "parent");
  if (!parentArg) throw new UsageError(`Missing --parent\n\n${USAGE}`);
  const children = int(args, "children");
  const volume = num(args, "volume");
  if (children === undefined || volume === undefined) throw new UsageError(`Missing --children or --volume\n\n${USAGE}`);
  const mode = (flag(args, "mode") ?? "B").toUpperCase();
  if (mode !== "A" && mode !== "B") throw new UsageError("--mode must be A or B");

  const parent = new PublicKey(parentArg);
  const obs = await f.observeParent(connection(args), parent, observeOptions(args));
  const priceUsd = num(args, "price-usd");
  if (!obs.pool && priceUsd === undefined) {
    throw new UsageError("No parent pool price available (not graduated, or no --paired-usd for this pair): pass --price-usd or --paired-usd");
  }
  const opt = <K extends keyof f.FamilySimInput>(k: K, v: f.FamilySimInput[K] | undefined) => (v === undefined ? {} : { [k]: v });
  const sim = f.simulateFamily({
    mode,
    children,
    dailyVolumeUsd: volume,
    ...opt("days", int(args, "days")),
    ...opt("volumeDecay", num(args, "decay")),
    ...opt("feeBps", int(args, "fee-bps")),
    ...opt("holdersBps", int(args, "holders-bps")),
    ...opt("parentPriceUsd", priceUsd),
    ...opt("parentPool", obs.pool),
    ...opt("netInflowBps", int(args, "net-inflow-bps")),
    ...opt("graduationProbability", num(args, "grad-prob")),
    ...opt("lockedPerGraduationUsd", num(args, "locked-usd")),
  });

  if (bool(args, "json")) {
    out(json({ parent, ...sim }));
    return;
  }
  const usd = (x: number) => `$${x.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const tokens = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const shown = sim.days.length <= 10 ? sim.days : sim.days.filter((d) => d.day <= 7 || d.day % 7 === 0 || d.day === sim.days.length);
  const feeBps = int(args, "fee-bps") ?? f.DEFAULT_SPLIT_FEE_BPS;
  const holdersBps = int(args, "holders-bps") ?? f.OFFICIAL_HOLDERS_BPS;
  const lines = [
    `Coin Families simulation, Mode ${mode} (${mode === "B" ? "reward-linked" : "native quote"})`,
    `Parent ${parent.toBase58()} at ${usd(sim.parentPriceUsd)}; ${children} children × ${usd(volume)}/day; ${sim.days.length} days`,
    `Fee through Float's split: ${pct(feeBps / 10_000)} · holders share: ${pct(holdersBps / 10_000)}`,
    "",
    table(
      shown.map((d) => ({
        day: d.day,
        volume: usd(d.volumeUsd),
        holder_rewards: usd(d.holderRewardsUsd),
        parent_bought: usd(d.parentBuyUsd),
        parent_tokens: tokens(d.parentBought),
        impact: d.priceImpact === null ? "-" : pct(d.priceImpact),
        swaps_1pct: d.swapsWithinCap ?? "-",
      })),
    ),
    "",
    `Totals: volume ${usd(sim.totals.volumeUsd)}, parent paid to child holders ${usd(sim.totals.holderRewardsUsd)}, parent bought ${usd(sim.totals.parentBuyUsd)} (${tokens(sim.totals.parentBought)} tokens).`,
    ...(mode === "A" ? [`Expected parent locked forever at graduation: ${usd(sim.lockedParentUsd)} (${tokens(sim.lockedParent)} tokens).`] : []),
    ...obs.notes.map((n) => `Note: ${n}`),
    "",
    sim.disclaimer,
  ];
  out(lines.join("\n"));
}
