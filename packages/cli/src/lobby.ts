/**
 * `float lobby simulate`: Fair Launch Lobby (docs/proposals/fair-launch-lobby.md).
 * Read-only: nothing here sends a transaction.
 */
import { PublicKey, formatUnits, lobby as l, parseUnits } from "@float-community/sdk";
import { type Args, UsageError, bool, connection, flag, json, pct, readCsv, table } from "./util.ts";

type Out = (s: string) => void;

const USAGE = `Usage:
  float lobby simulate --deposits <file.csv> (--pool <launchlab-pool> | --virtual-base N --virtual-quote N)
              [--max-supply-bps ${l.DEFAULT_MAX_SUPPLY_BPS}] [--wallet-supply-bps ${l.DEFAULT_WALLET_SUPPLY_BPS}]
              [--min-raise <paired amount>] [--min-wallets ${l.DEFAULT_MIN_WALLETS}]
  Offline curve flags: [--total-base-sell <raw>] [--supply <raw>] [--fee-rate 10000] [--base-decimals 6] [--quote-decimals 9]
  CSV columns: wallet,amount (amount in paired-token units, e.g. 0.25 for 0.25 SOL)`;

export async function lobby(args: Args, out: Out) {
  if (args._[1] !== "simulate") throw new UsageError(USAGE);
  const file = flag(args, "deposits");
  if (!file) throw new UsageError(`Missing --deposits\n\n${USAGE}`);
  const curve = await loadCurve(args);
  const intFlag = (name: string, fallback: number) => {
    const v = flag(args, name);
    if (v === undefined) return fallback;
    if (!/^\d+$/.test(v)) throw new UsageError(`--${name} must be a non-negative integer`);
    return Number(v);
  };
  const minRaiseFlag = flag(args, "min-raise");
  const params: l.LobbyParams = {
    ...l.lobbyParamsWithDefaults(minRaiseFlag ? parseUnits(minRaiseFlag, curve.quoteDecimals) : 1n),
    maxSupplyBps: intFlag("max-supply-bps", l.DEFAULT_MAX_SUPPLY_BPS),
    walletSupplyBps: intFlag("wallet-supply-bps", l.DEFAULT_WALLET_SUPPLY_BPS),
    minWallets: intFlag("min-wallets", l.DEFAULT_MIN_WALLETS),
  };
  const deposits = readCsv(file).map((r, i) => {
    if (!r.wallet || !r.amount) throw new Error(`Row ${i + 2}: need wallet and amount`);
    return { wallet: r.wallet, amount: parseUnits(r.amount, curve.quoteDecimals) };
  });

  const sim = l.simulateLobby(deposits, params, curve);
  if (bool(args, "json")) {
    out(json({ curve, params, ...sim }));
    return;
  }

  const q = (x: bigint) => formatUnits(x, curve.quoteDecimals);
  const coins = (x: bigint) => formatUnits(x, curve.baseDecimals);
  const toUi = 10 ** (curve.baseDecimals - curve.quoteDecimals);
  const price = (raw: number) => (raw * toUi).toPrecision(6);
  const capped = sim.rows.filter((r) => r.deposit < r.requested).length;
  const lines = [
    `Fair Launch Lobby simulation (curve from ${curve.source})`,
    `Caps: max raise ${q(sim.caps.maxRaise)} (${pct(params.maxSupplyBps / 10_000)} of supply), wallet cap ${q(sim.caps.walletCap)} (${pct(params.walletSupplyBps / 10_000)})`,
    `Deposits: ${q(sim.totalDeposits)} from ${sim.depositors} wallets${capped ? ` (${capped} capped at the wallet cap)` : ""}; quorum ${sim.quorumMet ? "met" : "MISSED"}`,
    "",
  ];
  if (sim.outcome === "cancelled") {
    lines.push("Outcome: cancelled. Every depositor gets the full deposit back; no coin is created.");
  } else {
    lines.push(
      table(
        sim.rows.map((r) => ({
          wallet: r.wallet,
          deposit: q(r.deposit),
          spent: q(r.spent),
          refund: q(r.refund),
          tokens: coins(r.tokens),
          supply: pct(Number(r.tokens) / Number(curve.supply), 3),
        })),
      ),
      "",
      `Lobby buy: ${q(sim.raiseSpent)} → ${coins(sim.tokensBought)} coins (${pct(sim.supplyBought)} of supply), LaunchLab fee ${q(sim.fee)}`,
      `Uniform price: ${price(sim.uniformPriceRaw)} per coin for everyone (fees included)`,
      `Curve price: genesis ${price(sim.genesisPriceRaw)} → after the lobby ${price(sim.postLobbyPriceRaw)} (${pct(sim.postLobbyPriceRaw / sim.genesisPriceRaw - 1)})`,
      `Dust: ${q(sim.quoteDust)} paired to the treasury, ${coins(sim.tokenDust)} coins burned at close`,
    );
  }
  lines.push("", "Fair Launch Lobby is a community proposal, not an official Float feature. Lobby caps above Float's 2% first-buy cap need Float's agreement.");
  out(lines.join("\n"));
}

async function loadCurve(args: Args): Promise<l.GenesisCurve> {
  const pool = flag(args, "pool");
  if (pool) return l.genesisFromPool(connection(args), new PublicKey(pool));
  const vb = flag(args, "virtual-base");
  const vq = flag(args, "virtual-quote");
  if (!vb || !vq) throw new UsageError(`Pass --pool <launchlab-pool> or both --virtual-base and --virtual-quote\n\n${USAGE}`);
  const raw = (name: string, v: string) => {
    if (!/^\d+$/.test(v)) throw new UsageError(`--${name} must be an integer in raw units`);
    return BigInt(v);
  };
  const baseDecimals = Number(flag(args, "base-decimals") ?? 6);
  // Official docs: fixed supply of 1,000,000,000 and a 1% trading fee.
  const supply = raw("supply", flag(args, "supply") ?? (1_000_000_000n * 10n ** BigInt(baseDecimals)).toString());
  return {
    virtualBase: raw("virtual-base", vb),
    virtualQuote: raw("virtual-quote", vq),
    // Only matters if a cap is not below the coins sold on the curve.
    totalBaseSell: raw("total-base-sell", flag(args, "total-base-sell") ?? supply.toString()),
    supply,
    baseDecimals,
    quoteDecimals: Number(flag(args, "quote-decimals") ?? 9),
    feeRate: raw("fee-rate", flag(args, "fee-rate") ?? "10000"),
    source: "--virtual-base / --virtual-quote",
  };
}
