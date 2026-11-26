#!/usr/bin/env node
import * as cmd from "./commands.ts";
import { family } from "./family.ts";
import { lobby } from "./lobby.ts";
import { UsageError, parseArgs } from "./util.ts";

const HELP = `float — community CLI for Float coins on Solana

Usage: float <command> [args] [--rpc <url>] [--json]

Read-only
  addresses                          List Float and Raydium addresses with Solscan links
  split <amount> [--decimals 9]      Show how a fee amount is split across the five buckets
  ticker <TICKER> [--taken A,B]      Validate a ticker and show its launch cost / refund rule
         [--launched <iso> [--graduated <iso>]]
  pool <coin-mint> [--pair SOL]      LaunchLab pool status, curve progress, fee rates
  quote buy|sell <coin-mint> <amt>   Quote a bonding-curve trade with the fee breakdown
  cycle <coin-mint> [--pair SOL]     Preview pending fees and where a "Cycle fees" would route them
  inspect <address>                  Decode any LaunchLab / CPMM / SPL account
  holders <coin-mint> [--top 25]     Snapshot holders and their share of holder rewards
  burns [--limit 100]                List $FLOAT buyback burns
  payouts [--wallet <addr>]          List holder payouts sent by the payout bot [--summary]

Offline
  airdrop --trades <file.csv>        Rank traders for an airdrop round [--round 2] [--pot <usdc>]
          [--pairs-added <file.csv>] [--snapshot <iso> --since <iso> --top N]
  buyback <sol> --pool <cpmm-pool>   Split a buyback into ≤1%-impact buys
          (or --sol-reserve X --float-reserve Y)

Proposals (community, not official Float features)
  family check <parent>              Is a coin eligible as a Coin Families parent?
         --platform-config <addr>    [--pair SOL] [--paired-usd <price>] [--pool <cpmm-pool>]
  family simulate --parent <mint>    Parent demand from N children (scenarios, not forecasts)
         --children N --volume USD   [--days 30] [--mode B|A] [--fee-bps 75] [--holders-bps 1750]
  lobby simulate --deposits <csv>    Fair Launch Lobby allocation, uniform price and refunds
         (--pool <launchlab-pool> | --virtual-base N --virtual-quote N) [--max-supply-bps 1500 --wallet-supply-bps 100]

Transactions (simulated unless --send)
  buy <coin-mint> <amount> --keypair <file>   Buy on the bonding curve
  sell <coin-mint> <amount> --keypair <file>  Sell on the bonding curve
       [--pair SOL] [--slippage-bps 100] [--priority-micro-lamports 50000] [--logs]

Environment
  SOLANA_RPC_URL   RPC endpoint (default https://api.mainnet-beta.solana.com)
`;

const COMMANDS: Record<string, (a: ReturnType<typeof parseArgs>, out: (s: string) => void) => Promise<void>> = {
  addresses: cmd.addresses,
  split: cmd.split,
  ticker: cmd.ticker,
  pool: cmd.pool,
  quote: cmd.quote,
  buy: cmd.trade,
  sell: cmd.trade,
  cycle: cmd.cycle,
  inspect: cmd.inspect,
  holders: cmd.holders,
  burns: cmd.burns,
  payouts: cmd.payouts,
  airdrop: cmd.airdrop,
  buyback: cmd.buyback,
  family,
  lobby,
};

export async function run(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  const args = parseArgs(argv);
  const name = args._[0];
  if (!name || name === "help" || args.flags.help) {
    out(HELP);
    return 0;
  }
  const fn = COMMANDS[name];
  if (!fn) {
    out(`Unknown command "${name}".\n\n${HELP}`);
    return 2;
  }
  try {
    await fn(args, out);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      out(`${err.message}\n\nRun "float help" for usage.`);
      return 2;
    }
    out(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2));
}
