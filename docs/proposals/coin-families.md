# Proposal: Coin Families

> **Status:** draft proposal · **Not an official Float feature.**
> Lets a new Float coin (the **child**) use an existing graduated Float coin or
> `$FLOAT` (the **parent**) as its economic base. Reference implementation in
> `float-router`, `float-core` and the SDK. Anything that depends on Float's own
> (closed) program, payout bot or Raydium's admin actions is marked
> **Assumption** or **Dependency**.

## 1. Summary

Today every Float coin is paired with an outside asset (stocks, pre-IPO names,
privacy coins, SOL, USDC, Hylo tokens) and pays its holders in that asset.
Families add **Float itself** to that list: a child coin can be paired with a
successful Float coin, or with `$FLOAT`, and pays its holders **in the parent**.
Every child then creates structural demand for its parent, the same effect
tokenized stocks get from being the quote asset of popular memecoins. With
`$FLOAT` as the parent, every new child feeds the platform token.

## 2. Two modes

| | **Mode B: reward-linked** (ship first) | **Mode A: native quote** |
| --- | --- | --- |
| Child trades against | its usual pair (SOL, USDC, NVDAx…) | the parent coin itself |
| Holder rewards paid in | parent (holders' share swapped paired → parent before payout) | parent (no swap needed) |
| Parent demand | `holders_share × child fees` | the whole net child inflow, **plus** parent tokens locked forever in the child's Burn & Earn liquidity at graduation, plus holder rewards |
| External dependencies | none (router or payout-pipeline change) | Raydium must create a LaunchLab `GlobalConfig` for each parent mint (admin-only `create_config`, plus `create_platform_global_access` if the config requires platform auth); Float must set platform curve params for it (`update_platform_curve_param`) |
| Best first parent | any eligible coin, or `$FLOAT` | `$FLOAT` (one Raydium request unlocks it) |

Recommendation: ship **Mode B** for every eligible parent, and request **Mode A
for `$FLOAT`** from Raydium in parallel.

## 3. Parent eligibility

A parent must be either:

- `$FLOAT` (always eligible), or
- a Float coin that meets all of the conditions below. On mainnet, a Float coin
  is one launched with Float's LaunchLab platform config, which is observable
  on chain. In the reference implementation it is a coin registered in
  `float-router`.
  - graduated at least `parent_min_age` ago (default 7 days, matching the
    official 7-day maturity rule for new pairs). On mainnet the graduation
    time is the `open_time` of the coin's CPMM pool, which LaunchLab's
    migration creates; the reference implementation uses
    `CoinRecord.graduated_at`;
  - its CPMM pool holds at least `parent_min_pool_usd` on the paired side
    (default $100 000), so conversions stay within the impact cap;
  - its paired asset is not paused by its issuer;
  - its family depth is below `max_depth` (default 2: `$FLOAT` → child →
    grandchild is the deepest allowed).

Eligibility is checked at child registration and re-checked before each
conversion. If a parent becomes ineligible later (for example its paired stock
is paused), conversions pause and the holders' share waits in the vault. This
mirrors the official behaviour for Hylo tokens that have no route: their shares
stay in vaults until a pool exists.

## 4. Mechanics

### 4.1 Mode B: reward-linked

1. The child launches normally (any supported pair) and registers with
   `parent = P`.
2. On every cycle, the holders' share (17.5 % for standard coins per the
   current official split) lands in the holders vault for the child's paired
   mint, as today.
3. Before payout, a guarded conversion swaps the child's `holders_unpaid` from
   the paired mint into `P`:
   - **Route:** paired → (P's paired mint) → P, at most 3 hops, each through a
     pinned pool: the paired/target CPMM pool and P's own CPMM pool from its
     `CoinRecord`.
   - **Guard:** each hop's `min_out` comes from the pool's TWAP minus
     `guard_bps`, plus a per-hop impact cap; large amounts are split.
4. Holders are paid in `P` with the existing payout model ($2 token-account
   threshold, rollovers, seller forfeit), using P's USD price.

Per-coin accounting must move from "unpaid in paired mint" to "unpaid in parent
mint" once converted, so the shared per-mint holders vaults stay solvent. Track
`holders_unpaid_parent` in a `FamilyRecord` instead of changing `CoinRecord`.

### 4.2 Mode A: native quote

1. **Dependency:** a LaunchLab `GlobalConfig` exists for `quote_mint = P`, and
   Float's platform config has curve params for it.
2. The child is launched on that config, so every buy of the child spends `P`
   and every sell returns `P`. Aggregators route SOL → P → child, so buying a
   child means buying the parent first.
3. **Fee routing in parent units:**
   - holders' share: already in `P`, paid as is;
   - flagship share: if `P == $FLOAT`, **burn it directly** (no swap at all);
     otherwise convert P → WSOL through P's pool and send it to the buyback
     vault;
   - traders' share: P → … → USDC (multi-hop, guarded);
   - treasury share: P, or converted per Float's preference.
4. **Graduation:** LaunchLab migrates the raised `P` into the child's CPMM pool,
   whose liquidity is locked forever through Burn & Earn. **Every graduated
   child permanently locks parent tokens.** With `$FLOAT` as the parent, each
   graduation works like a partial burn.
5. **Curve sizing:** `total_quote_fund_raising` is in `P` units. To keep the
   official targets (start around $20 000, graduation around $150 000), Float
   updates the platform curve param for P's config from P's price. The SDK
   provides `curveParamsForTargetUsd(pPriceUsd, …)` to compute it.

## 5. Accounts (reference implementation)

| Account | Seeds | Fields |
| --- | --- | --- |
| `FamilyRecord` | `["family", child_mint]` | child, parent, mode (`A`/`B`), depth, `holders_unpaid_parent`, `total_converted_paired`, `total_parent_bought`, `total_parent_paid`, bump |
| `ParentStats` | `["parent", parent_mint]` | parent, `children`, `graduated_children`, `total_parent_bought`, `total_parent_locked` (Mode A graduations), `total_parent_paid`, bump |

`CoinRecord` stays unchanged, keeping its layout and the IDL freshness check
stable.

## 6. Instructions

| Instruction | Signer | Effect |
| --- | --- | --- |
| `register_family(parent, mode)` | launcher (same transaction as `register_coin`) | Checks eligibility (§3), creates `FamilyRecord`, bumps `ParentStats.children`. Mode A also requires the coin's `paired_mint == parent`. |
| `convert_holders_to_parent(amount, route, min_outs)` | operator | Mode B. Moves `amount` of the child's `holders_unpaid` (paired) through the pinned route; credits `holders_unpaid_parent` with the **actual** parent received (vault balance delta); bounded by the guard on every hop. |
| `payout_family_holders(round, recipients)` | operator | Like `payout_holders`, paid from the parent-mint holders vault; `Σ ≤ holders_unpaid_parent`. |
| `convert_vault_route(kind, route, amount, min_outs)` | operator | Multi-hop generalisation of `convert_vault` (up to 3 pinned hops) for the flagship and traders shares in Mode A. |
| `burn_flagship_parent(amount)` | operator | Mode A with `P == $FLOAT`: burn the flagship share directly and update `total_burned`. |
| `record_child_graduation()` | anyone | Mode A: after migration, read the child's CPMM pool and add the locked `P` to `ParentStats.total_parent_locked`. |

## 7. Economics model (for the simulator)

For a child with daily volume `V` (USD) and fee rate `f`, where `f` is the
part of the trading fee that goes through Float's split. New standard coins
pay 1 % per trade and Raydium keeps 0.25 % while a coin is on its curve
(official docs), so `f` = 0.75 % on the curve:

- Mode B parent buy per day ≈ `V · f · holders_share`. Example: $200 000 ×
  0.75 % × 17.5 % ≈ **$262.50/day** of parent bought and handed to child
  holders. If the whole 1 % went through the split, the same volume would
  give $350/day.
- Mode A adds the child's **net** inflow (buys − sells, in P) and, at
  graduation, `locked_P = real_quote_at_migration − migrate_fee`, removed from
  circulation forever.
- Price impact on P uses P's CPMM reserves (`cpmm` math in `float-core` and
  SDK).

The simulator takes a family (parent pool reserves, N children, per-child
volume curves, graduation probabilities) and prints daily parent demand, locked
supply and impact. These are scenarios, not forecasts, and the CLI output must
say so.

## 8. Risks

- **Reflexivity:** a parent drop lowers the USD value of everything quoted in
  it (Mode A) and of rewards (both modes). Depth limit and parent liquidity
  floor contain contagion.
- **Thin parent pools:** conversions are impact-capped; anything above the cap
  waits for the next cycle.
- **Issuer pauses** of the parent's paired stock stop its pool → conversions
  pause (§3).
- **Mode A curve drift:** if P's price moves a lot after the curve is set, the
  USD graduation target drifts → Float refreshes the curve param.

## 9. Invariants (must be tested)

1. `Σ holders_unpaid_parent` of children with parent P is ≤ the parent-mint
   holders vault balance.
2. `holders_unpaid_parent` is credited with what was actually received, never
   the quoted amount (Token-2022 transfer fees included).
3. Every hop uses a pinned pool and respects its guard.
4. `depth ≤ max_depth`; no cycles (a coin cannot be its own ancestor).
5. Mode A `$FLOAT` flagship burns update `total_burned`, and nothing is swapped.

## 10. Off-chain deliverables (Phase 1)

- `float-core::family`: eligibility rules, depth and cycle checks, route
  validation (≤ 3 hops, contiguous mints), per-hop guard composition, Mode B
  accounting helpers. Unit tests and shared vectors.
- `packages/sdk/src/float/families.ts`: eligibility from on-chain data, route
  planning and multi-hop quotes over CPMM, `curveParamsForTargetUsd`, family
  tree reader (once the router IDL includes `FamilyRecord`/`ParentStats`), and
  the economics simulator.
- CLI: `float family check <parent>`, `float family simulate --parent <mint> --children 5 --volume 200000`,
  and `float family tree <parent>` (Phase 2, needs on-chain data).

## 11. Product notes

- A "Launch a child" button on every eligible coin page creates a viral loop:
  parent communities promote children because children buy their coin.
- Show lineage on coin cards ("$PEPE ← $FLOAT") and a family page with
  `ParentStats`.
- **Airdrops:** child trades count normally. Per the official 7-day rule,
  children on a new parent pair should only count 7 days after that pair is
  enabled. **Assumption:** Float treats each new parent as a new pair.

## 12. Open questions for the Float team

1. Would Float request `$FLOAT` (and later top coins) as LaunchLab quote mints
   from Raydium for Mode A?
2. Should Mode B conversions run in Float's payout bot (off-chain) or on chain
   in the router?
3. Is `max_depth = 2` acceptable?
4. Should a share of child fees go to parent holders directly (a "family
   royalty")? Out of scope for v1.
