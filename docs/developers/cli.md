# CLI reference

```bash
npm run float -- <command> [args] [flags]
# or, after `npm link -w packages/cli`:
float <command> [args] [flags]
```

Global flags:

| Flag | Meaning |
| --- | --- |
| `--rpc <url>` | RPC endpoint; defaults to `$SOLANA_RPC_URL`, then `https://api.mainnet-beta.solana.com` |
| `--json` | Machine-readable output, where supported |
| `--csv` | CSV output (`holders`, `burns`, `payouts`, `airdrop`) |

## Read-only

### `addresses`

Every Float and Raydium address, with Solscan links.

### `split <amount> [--decimals 9] [--symbol SOL]`

How a fee amount divides across the five buckets.

### `ticker <TICKER> [--taken A,B,…] [--at <iso>] [--launched <iso> [--graduated <iso>]]`

Validates a ticker and prints its launch cost. With `--launched`, prints the
remaining refund window; with `--graduated` too, whether the reuse fee was
refunded.

### `pool <coin-mint> [--pair SOL|USDC|<mint>]`

LaunchLab pool status: stage, curve progress, price, raised and sold amounts,
fee rates, pending platform fee, and the CPMM pool address once graduated.

### `quote buy|sell <coin-mint> <amount> [--pair …]`

Quotes a bonding-curve trade: amount out, fee breakdown (protocol / platform /
creator), price impact, and whether the buy graduates the coin.

### `cycle <coin-mint> [--pair …] [--json]`

Shows the coin's pending fees and how a **Cycle fees** would split them.

### `inspect <address>`

Decodes LaunchLab (`PoolState`, `GlobalConfig`, `PlatformConfig`,
`VestingRecord`), CPMM (`PoolState`, `AmmConfig`) and SPL (mint, token
account) accounts. Anything else gets its owner, size and a hex preview.

### `holders <coin-mint> [--top 25] [--csv]`

Holder snapshot, excluding pool vaults and burn addresses, with each wallet's
share of holder rewards. Needs an RPC that allows `getProgramAccounts`.

### `burns [--limit 100] [--csv]`

$FLOAT burns through the buyback & burn vault, with a total.

### `payouts [--wallet <addr>] [--limit 200] [--summary] [--csv]`

Transfers sent by the holder payout bot. `--summary` totals them per wallet
and token.

## Offline

### `airdrop --trades <file.csv> [--round N] [--pot <usdc>] [--pairs-added <file.csv>]`

Ranks wallets for an airdrop round with the bot, wash-trade and new-pair
rules. `--pot` also allocates a USDC amount. Override the round with
`--snapshot <iso> --since <iso> --top N`.

`trades.csv` columns: `wallet,coin,pair,side,timestamp,volume_usd[,signature]`
(timestamp as ISO-8601 or unix ms). `pairs-added.csv` columns: `pair,added_at`.
Samples are in `examples/`.

### `buyback <sol-amount> (--pool <cpmm-pool> | --sol-reserve X --float-reserve Y)`

Splits a buyback into consecutive buys that each keep price impact ≤ 1%.

## Proposals

Commands for the community [proposals](../proposals/README.md). None of
them are official Float features, and none send transactions.

### `family check <parent> --platform-config <addr> [--pair SOL] [--paired-usd <price>] [--pool <cpmm-pool>]`

Checks the [Coin Families](../proposals/coin-families.md) parent rules (§3)
from on-chain data and explains each one: Float coin (LaunchLab platform
config), graduated, age since graduation (CPMM pool `open_time`), paired-side
liquidity, issuer pause, depth. `$FLOAT` is always eligible. Tune the
thresholds with `--min-age-days`, `--min-pool-usd` and `--max-depth`.

Float's LaunchLab platform config is not listed in the official docs: read
it from any coin on [floatlaunch.xyz/tokens](https://www.floatlaunch.xyz/tokens)
with `float pool <mint>`. `--paired-usd` is the USD price of the paired token
(defaults to 1 for USDC).

### `family simulate --parent <mint> --children N --volume <usd> [--days 30] [--mode B|A]`

Daily parent demand from `N` children trading `--volume` USD each per day
(§7). Mode B buys the holders' share of each child's fees in the parent;
Mode A adds `--net-inflow-bps` of volume as parent buys and
`--grad-prob × --locked-usd` of parent locked at graduation. Price impact
uses the parent's CPMM pool. The output is a scenario, not a forecast.

| Flag | Default |
| --- | --- |
| `--fee-bps` | `75`: the 1% fee minus Raydium's 0.25% on the curve (official docs) |
| `--holders-bps` | `1750`: holders share of standard coins (official docs) |
| `--decay` | `1` (flat volume); `0.95` = −5% per day |
| `--price-usd` | parent price when it has no pool (e.g. `$FLOAT` without `--pool`) |

### `lobby simulate --deposits <file.csv> (--pool <launchlab-pool> | --virtual-base N --virtual-quote N)`

Simulates a [Fair Launch Lobby](../proposals/fair-launch-lobby.md): derives
`max_raise` and `wallet_cap` from the genesis curve (§6.1), caps each wallet,
checks the quorum, quotes the single lobby buy and prints every wallet's
spent amount, refund and tokens, the uniform price, and the curve price after
the lobby versus genesis. `--pool` reads the genesis reserves, supply, curve
size and fee rates from an existing LaunchLab pool on the same curve.

CSV columns: `wallet,amount`, amounts in paired-token units. See
[`examples/lobby-deposits.sample.csv`](../../examples/lobby-deposits.sample.csv).

| Flag | Default |
| --- | --- |
| `--max-supply-bps` | `1500` (15% of supply, at most 2000) |
| `--wallet-supply-bps` | `100` (1% of supply) |
| `--min-raise` / `--min-wallets` | smallest unit / `10` |
| `--fee-rate` (offline) | `10000` (the official 1% fee, in 1e-6 units) |
| `--supply` (offline) | 1,000,000,000 coins (official) at `--base-decimals 6` |

### `index weights --stats <stats.json> [--platform-config <addr>] [--discover] [--n 10] [--cap-bps 1500]`

Computes the [Float Index](../proposals/float-index.md) basket (§3) and says
why each coin is in or out: Float coin, graduated at least 7 days ago, not
paused (operator flag or pool swaps disabled), paired side of its CPMM pool
at least `--min-pool-usd` (default $50,000), ranked by 30-day fees, then
weighted by √market cap with the single-coin cap and, with `--aum-usd`, the
liquidity cap (`--liq-factor-bps`, default 10%). `--discover` also lists
every graduated pool on the platform config (`getProgramAccounts`).

30-day fees are not on chain in a queryable form yet, so they come from a
`stats.json` (see [`examples/index-stats.sample.json`](../../examples/index-stats.sample.json)):

| Field | Meaning |
| --- | --- |
| `platformConfig` | Float's LaunchLab platform config (or pass `--platform-config`) |
| `prices` | USD per whole paired token, keyed by `SOL`, `USDC` or mint (`USDC` defaults to 1) |
| `coins[].mint` / `pair` | Coin mint and its pair (`SOL`, `USDC` or the paired mint; default `SOL`) |
| `coins[].fees30dUsd` | USD value of the coin's fees that went through Float's split in the window |
| `coins[].paused` / `pausedReason` | Operator exclusion flag with its public reason |
| `windowDays`, `asOf` | Window length (default 30) and snapshot time |

### `index simulate --deposit <sol> --days <n> --stats <stats.json> [--sol-usd <price>]`

Simulates a genesis-epoch creation (50 bps proposed creation fee, basket
bought through each coin's pool), the holder rewards the deposit would pass
through (`fees30dUsd / windowDays × 17.5% × share of the coin's holder
base`) and an in-kind redemption sold back through the same pools. It
assumes Float's payout bot pays program-owned holders, which is unconfirmed
(spec §6). The output is a scenario, not a forecast.

## Transactions

### `buy <coin-mint> <amount> --keypair <file>` / `sell <coin-mint> <amount> --keypair <file>`

Builds a bonding-curve trade, signs it with a Solana CLI keypair file and
**simulates** it. Add `--send` to broadcast.

| Flag | Default |
| --- | --- |
| `--pair` | `SOL` |
| `--slippage-bps` | `100` (1%) |
| `--priority-micro-lamports` | `50000` |
| `--logs` | print simulation logs |
| `--send` | broadcast and confirm |

For SOL pairs the transaction wraps exactly the SOL needed and closes the
temporary wSOL account at the end.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Runtime error (RPC, decoding, simulation) |
| 2 | Usage error |
