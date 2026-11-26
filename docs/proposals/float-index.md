# Proposal: Float Index

> **Status:** draft proposal · **Not an official Float feature.**
> Specifies an index vault over Float coins and a reference implementation as a
> new program, `programs/float-index`, next to `float-router`. Anything that
> depends on Float's own (closed) program or payout bot is marked
> **Assumption** and must be confirmed with the Float team.

## 1. Summary

**FIDX** is one SPL token backed by a basket of the best graduated Float coins.
The vault holds the coins, rebalances them on a fixed schedule and, because it
is a holder of every coin in the basket, **receives Float's holder rewards in
every paired asset** (NVDAx, TSLAx, gold, SOL, USDC…). Those rewards are passed
through to FIDX holders. FIDX is "the ETF of Float memes": one token, diversified
meme exposure, paid in a portfolio of real assets.

Design goals:

- **No price oracle for minting or redeeming.** Creation buys the basket in its
  current proportions and mints shares by quantity ratios; redemption is
  in-kind. Neither depends on a manipulable price.
- **Deterministic, reproducible methodology.** Anyone can recompute the target
  basket from public data with the SDK and check the operator.
- **Bounded operator.** The operator rebalances only through pinned pools, with
  price guards and turnover caps.

## 2. Why it matters for the platform

- Constant, rules-based demand for the top coins (weekly rebalances, new
  creations).
- A low-effort way into Float for people who will not pick memes one by one.
- Natural arbitrage: if FIDX also trades on a CPMM pool, create/redeem keeps
  its price near NAV, exactly like an ETF.
- An optional creation fee can feed the $FLOAT buyback.

## 3. Methodology

Recomputed at every rebalance (weekly by default) and published with its inputs.

1. **Universe.** Float coins (on mainnet: launched with Float's LaunchLab
   platform config, which is observable on chain; in the reference
   implementation: registered in `float-router`) that graduated at least 7 days
   ago; excluding coins whose paired asset is paused by its issuer
   (operator flag with a public reason), coins whose CPMM pool holds less than
   `min_pool_paired_usd` (default $50 000) on the paired side, and `$FLOAT`
   (optional fixed slot, see §10).
2. **Selection.** Rank by fees generated in the last 30 days (`FeesCycled`
   events, or `CoinRecord.total_cycled` deltas). Take the top `N` (default 10,
   maximum 10 in v1 so redemption fits one transaction). Fees cost the trader
   about 1 % per trade, which makes them harder to fake than volume.
3. **Raw weight.** `raw_i = isqrt(mcap_i)` (square root dampens concentration).
4. **Caps.** Single-coin cap `cap_bps` (default 1 500). Liquidity cap: the
   coin's position may not exceed `liq_factor` (default 10 %) of its pool's
   paired-side value at the target AUM, so a full rebalance trade stays within
   about 1 % price impact.
5. **Normalise with iterative capping** (integer bps, deterministic):

```
w = floor(10_000 * raw_i / Σ raw); give the remainder to the largest raw
repeat:
    over = { i : w_i > cap_i }
    if over is empty: stop
    excess = Σ_{i ∈ over} (w_i - cap_i); w_i = cap_i for i ∈ over
    spread excess over the uncapped coins pro rata to raw (floor),
    remainder to the largest uncapped coin
if every coin is capped and Σ w < 10_000: error InfeasibleCaps (lower N or raise caps)
```

Ties are broken by mint address (ascending). The algorithm lives in
`float-core::index::target_weights` with shared vectors.

## 4. Creation (minting): epoch batches, oracle-free

Deposits are batched to avoid per-deposit front-running.

1. During epoch `e`, a user calls `request_creation(lamports)`, which escrows
   SOL in a `CreationTicket` they can cancel until the epoch closes.
2. When the epoch closes, the operator runs `process_creations(e)`: the epoch's
   total SOL `T` (minus the creation fee) is spent buying each component **in
   proportion to current holdings**, through pinned pools, guarded.
3. Shares minted for the epoch:

```
genesis (S = 0):  shares_e = T_net                    // 1 share = 1 lamport, decimals 9
otherwise:        shares_e = min_j floor(S * q_new_j / q_old_j)   // u128 intermediates
```

Using the minimum ratio means the new holders never take value from existing
holders. Any surplus (`q_new_j` above `min_ratio * q_old_j`) stays in the vault
and accrues to everyone; tracking error is bounded by the price guard.
4. Each ticket claims `floor(shares_e * ticket_i / T)`; rounding dust stays in
   the vault.

**Shared test vector:** `q_old = [1000, 500, 200]`, `S = 100`,
`q_new = [100, 52, 19]` → per-component `floor(S * q_new / q_old) = [10, 10, 9]`
→ `shares_e = 9`, `S' = 109`. Holdings per share go from `[10, 5, 2]` to
`[10.09, 5.06, 2.009]`, so nobody is diluted. The surplus over an exactly
proportional purchase (`[90, 45, 18]`) is `[10, 7, 1]` and stays in the vault.

## 5. Redemption: instant, in kind

`redeem(x)` burns `x` shares and transfers, for every component `j`,
`floor(q_j * x / S)` from the vault to the user. Rewards that have not been
distributed yet are **not** paid out and stay for the remaining holders. This
matches Float's own holder rule: selling before a payout returns what was owed
to the remaining holders. The SDK offers a "zap": a client-side transaction set
that sells the received coins for SOL.

With `N ≤ 10`, redeem fits one v0 transaction using the index's address lookup
table (component vaults, user token accounts, mints, programs).

## 6. Rewards

The vault owns one token account per paired asset. Float's payout bot sends
holder rewards there because the vault is a holder of each component.

- **Accounting:** the program tracks component quantities `q_j` itself. For any
  mint, `reward_available(mint) = token_account.amount - tracked(mint)`. This
  separates rewards from holdings even when a reward asset is also a component
  (for example a Families child that pays in a parent coin that is in the
  basket).
- **Distribution (default):** the operator calls
  `distribute_rewards(mint, [(token_account, amount)])` with
  `Σ amount ≤ reward_available(mint)`. Off-chain, recipients are a pro-rata
  snapshot of FIDX holders using the existing `computePayoutRound` model ($2
  token-account threshold, rollovers, seller forfeit). Index-owned accounts and
  FIDX pools are excluded.
- **Alternative (per-index flag):** auto-compound by swapping rewards into the
  components on the next rebalance.

**Assumption (critical):** Float's payout bot pays holders whose owner is a
program address (off-curve) and creates their token accounts the same way as
for wallets. If it does not, the index receives no rewards. Confirm this with
the Float team **before Phase 2**.

## 7. Rebalancing

- Weekly window (default Monday 17:00 UTC, after the methodology is published
  with a 24 h notice). Emergency removals (issuer pause, liquidity collapse)
  are allowed at any time with an event and a reason code.
- Trades only when drift exceeds a band (default 200 bps of target weight).
- Route: sell overweight → WSOL → buy underweight, only through pinned pools:
  each coin's CPMM pool derived from its `CoinRecord` and the platform
  `cpswap_config` and, for coins not paired with SOL, one pinned pool between
  the paired asset and WSOL (at most 3 hops per leg, validated like Coin
  Families routes).
- Buys are funded by the sells of the same rebalance. When the band or the
  turnover cap limits the sells, every buy is scaled down pro rata to the
  WSOL raised.
- Every swap is guarded: `min_out` from the pool's TWAP (CPMM
  `ObservationState`) minus `guard_bps`, plus a per-swap impact cap (generalise
  `maxBuyWithinImpact`). Large trades are split across slots.
- Turnover cap per component per day (default 30 % of its holding) on sells.
  Buys are bounded by the funding rule above; a cap relative to the holding
  would block any new component, which starts at zero.

## 8. Accounts (`programs/float-index`)

| Account | Seeds | Fields |
| --- | --- | --- |
| `IndexConfig` | `["index", index_id]` | admin, operator, share_mint, fee params, `n_max`, caps, band, epoch length, current epoch, `paused`, component count, bumps |
| `Component` | `["component", index, mint]` | mint, coin_record (router), pool, target_bps, tracked qty, status |
| `CreationTicket` | `["ticket", index, epoch, wallet]` | wallet, lamports, claimed |
| `Epoch` | `["epoch", index, epoch_le]` | total lamports, shares minted, processed flag |
| `RewardLedger` | `["reward", index, mint]` | distributed total, last distribution |
| vault authority | `["vault", index]` | owns every component and reward token account |

Eligibility reads `float-router` `CoinRecord`s (owner check = router program ID).

## 9. Instructions

`init_index`, `set_methodology(targets[])` (24 h timelock; validates registered
and graduated coins, `Σ = 10 000`, caps), `request_creation`,
`cancel_creation`, `process_creations` (operator), `claim_shares`, `redeem`,
`rebalance_swap` (operator, pinned pools, guarded, turnover-capped),
`distribute_rewards` (operator, bounded), `set_paused`, admin handover.

## 10. Parameters and fees

| Parameter | Default |
| --- | --- |
| `N` | 10 (max 10 in v1) |
| `cap_bps` | 1 500 |
| `liq_factor` | 10 % |
| `min_pool_paired_usd` | $50 000 |
| drift band | 200 bps |
| epoch length | 1 h |
| creation fee | 50 bps, to the $FLOAT buyback vault (WSOL); a proposal |
| redemption fee | 0 |
| `$FLOAT` slot | optional fixed weight, decided by Float |

## 11. Invariants (must be tested)

1. For every component, `token_account.amount ≥ tracked(mint)`.
2. Minting never reduces value per share for existing holders: per component,
   `q_old_j / S_old ≤ q_new_total_j / S_new`.
3. Redemption pays exactly `floor(q_j * x / S)` per component and burns `x`.
4. `Σ distributed(mint) ≤ cumulative reward inflow(mint)`.
5. Swaps only through pinned pools (the coin's pool, plus a paired ↔ WSOL
   pool for coins not paired with SOL), within guard and turnover caps.
6. Methodology changes cannot take effect before their timelock.

## 12. Off-chain deliverables (Phase 1)

- `float-core::index`: `target_weights`, `creation_shares`, `redeem_amounts`,
  `reward_available`, `drift` / `rebalance_plan` (quantities only). Unit tests
  and shared vectors.
- `packages/sdk/src/float/floatIndex.ts`: methodology from on-chain data (universe,
  30-day fees, market caps, pool depth), NAV estimate (display only), rebalance
  plan with impact estimates, a creation/redemption simulator, and FIDX
  holder-payout planning that reuses `computePayoutRound`.
- CLI: `float index weights [--n 10 --cap-bps 1500]` (prints the basket and
  why each coin is in or out), `float index simulate --deposit 10 --days 30`.

## 13. Risks

- Rebalances are public and can be front-run → bands, splitting, TWAP guards,
  pinned pools.
- Thin pools → liquidity cap and pool-depth floor.
- Issuer pauses of paired stocks stop a component's pool → emergency removal,
  while in-kind redemption keeps working because the coin itself still
  transfers.
- Dependence on Float paying rewards to program-owned holders (§6).

## 14. Open questions for the Float team

1. Does the payout bot pay off-curve owners? Would the index vault be excluded
   as a "pool"?
2. Should `$FLOAT` hold a fixed slot?
3. Should the creation fee go to the $FLOAT buyback or the treasury?
4. Would Float list FIDX on its site and Analytics?
