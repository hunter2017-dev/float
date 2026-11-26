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
