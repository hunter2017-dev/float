//! Float Index (FIDX): an index vault over the top Float coins.
//!
//! Spec: `docs/proposals/float-index.md`. Oracle-free creation by quantity
//! ratios, in-kind redemption, rewards separated from holdings.
//!
//! | Item | Spec | What it decides |
//! | --- | --- | --- |
//! | [`liquidity_cap_bps`], [`target_weights`] | §3 | Basket weights: √mcap, single and liquidity caps, iterative capping |
//! | [`creation_shares`], [`ticket_shares`] | §4 | Shares minted per epoch and per ticket |
//! | [`redeem_amounts`] | §5 | In-kind redemption |
//! | [`reward_available`] | §6 | Rewards = balance − tracked holdings |
//! | [`drift_bps`], [`rebalance_plan`] | §7 | Drift against targets and the trades to fix it (quantities only) |
//!
//! Every function writes into caller-provided slices: no allocation.

use crate::error::{CoreError, Result};
use crate::BPS;

/// Most components an index may hold in v1 (redemption fits one transaction).
pub const MAX_COMPONENTS: usize = 10;
/// Default single-coin cap (15 %).
pub const DEFAULT_CAP_BPS: u16 = 1_500;
/// Default liquidity factor: a position may not exceed 10 % of its pool's paired side.
pub const DEFAULT_LIQ_FACTOR_BPS: u16 = 1_000;
/// Default drift band (200 bps of target weight).
pub const DEFAULT_BAND_BPS: u16 = 200;
/// Default turnover cap per component per day (30 % of its holding).
pub const DEFAULT_TURNOVER_BPS: u16 = 3_000;

const FULL: u32 = BPS as u32;

/// Integer square root (floor) of a `u128`.
pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    // Newton's method from an upper bound; converges monotonically.
    let mut x = 1u128 << (128 - n.leading_zeros()).div_ceil(2);
    loop {
        let y = (x + n / x) >> 1;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// Liquidity cap (§3.4) in bps of the index: the position may not exceed
/// `liq_factor_bps` of the pool's paired-side value at the target AUM, i.e.
/// `floor(liq_factor_bps · pool_paired_usd / aum_usd)`, saturating at
/// 10 000. With `aum_usd == 0` there is no liquidity limit (10 000).
pub fn liquidity_cap_bps(pool_paired_usd: u64, aum_usd: u64, liq_factor_bps: u16) -> u16 {
    if aum_usd == 0 {
        return FULL as u16;
    }
    let v = liq_factor_bps as u128 * pool_paired_usd as u128 / aum_usd as u128;
    v.min(FULL as u128) as u16
}

/// One basket candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WeightInput {
    /// Coin mint; ties are broken by ascending mint bytes.
    pub mint: [u8; 32],
    /// Market cap (any fixed unit, e.g. micro-USD).
    pub mcap: u64,
    /// This coin's liquidity cap in bps (see [`liquidity_cap_bps`]).
    pub liq_cap_bps: u16,
}

/// Index of the candidate with the largest raw weight among `members`
/// (ties: ascending mint).
fn largest(c: &[WeightInput], raw: &[u128], members: impl Iterator<Item = usize>) -> Option<usize> {
    members.fold(None, |best, i| match best {
        None => Some(i),
        Some(b) if raw[i] > raw[b] || (raw[i] == raw[b] && c[i].mint < c[b].mint) => Some(i),
        keep => keep,
    })
}

/// Target weights in bps (§3.3–3.5), written to `out[..candidates.len()]`
/// in input order, summing to exactly 10 000.
///
/// `raw_i = isqrt(mcap_i)`; `w = floor(10 000 · raw_i / Σ raw)` with the
/// remainder to the largest raw; then, while some coin exceeds its cap
/// (`min(cap_bps, liq_cap_bps_i)`), pin every such coin at its cap and spread
/// the excess over the coins not yet pinned, pro rata to raw (floored), the
/// remainder to the largest of them. Ties: ascending mint.
///
/// Fails with [`CoreError::InvalidParams`] for 0 or more than
/// [`MAX_COMPONENTS`] candidates, duplicate mints, `out` too short, or a zero
/// total raw weight; with [`CoreError::InfeasibleCaps`] when the caps cannot
/// add up to 10 000.
pub fn target_weights(candidates: &[WeightInput], cap_bps: u16, out: &mut [u16]) -> Result<()> {
    let n = candidates.len();
    if n == 0 || n > MAX_COMPONENTS || out.len() < n {
        return Err(CoreError::InvalidParams);
    }
    for i in 0..n {
        if candidates[..i].iter().any(|c| c.mint == candidates[i].mint) {
            return Err(CoreError::InvalidParams);
        }
    }
    let mut raw = [0u128; MAX_COMPONENTS];
    let mut cap = [0u32; MAX_COMPONENTS];
    for (i, c) in candidates.iter().enumerate() {
        raw[i] = isqrt(c.mcap as u128);
        cap[i] = cap_bps.min(c.liq_cap_bps).min(FULL as u16) as u32;
    }
    let raw = &raw[..n];
    let total: u128 = raw.iter().sum();
    if total == 0 {
        return Err(CoreError::InvalidParams);
    }
    if cap[..n].iter().sum::<u32>() < FULL {
        return Err(CoreError::InfeasibleCaps);
    }

    let mut w = [0u32; MAX_COMPONENTS];
    let mut assigned = 0u32;
    for i in 0..n {
        w[i] = (FULL as u128 * raw[i] / total) as u32;
        assigned += w[i];
    }
    let top = largest(candidates, raw, 0..n).ok_or(CoreError::InvalidParams)?;
    w[top] += FULL - assigned;

    let mut pinned = [false; MAX_COMPONENTS];
    // Each pass pins at least one more coin, so n passes suffice.
    for _ in 0..=n {
        let mut excess = 0u32;
        for i in 0..n {
            if w[i] > cap[i] {
                excess += w[i] - cap[i];
                w[i] = cap[i];
                pinned[i] = true;
            }
        }
        if excess == 0 {
            for i in 0..n {
                out[i] = w[i] as u16;
            }
            return Ok(());
        }
        let free = || (0..n).filter(|&i| !pinned[i]);
        let free_raw: u128 = free().map(|i| raw[i]).sum();
        let Some(top) = largest(candidates, raw, free()) else {
            return Err(CoreError::InfeasibleCaps);
        };
        // Pro rata to raw (floored); when every free coin has raw 0 the whole
        // excess is the remainder and goes to the largest (lowest mint) one.
        let mut spread = 0u32;
        for i in free() {
            let add = (excess as u128 * raw[i]).checked_div(free_raw).unwrap_or(0) as u32;
            w[i] += add;
            spread += add;
        }
        w[top] += excess - spread;
    }
    Err(CoreError::InfeasibleCaps)
}

// ---------------------------------------------------------------- creation

/// Shares minted for an epoch (§4.3).
///
/// Genesis (`supply == 0`): `t_net` (1 share = 1 lamport). Otherwise
/// `min_j floor(S · q_new_j / q_old_j)`, so new holders never take value from
/// existing ones. Fails with [`CoreError::InvalidParams`] if the slices differ
/// in length, are empty while `supply > 0`, or a held quantity is 0.
pub fn creation_shares(supply: u64, q_old: &[u64], q_new: &[u64], t_net: u64) -> Result<u64> {
    if supply == 0 {
        return Ok(t_net);
    }
    if q_old.len() != q_new.len() || q_old.is_empty() {
        return Err(CoreError::InvalidParams);
    }
    let mut shares = u64::MAX as u128;
    for (o, n) in q_old.iter().zip(q_new) {
        if *o == 0 {
            return Err(CoreError::InvalidParams);
        }
        shares = shares.min(supply as u128 * *n as u128 / *o as u128);
    }
    Ok(shares as u64)
}

/// Shares a ticket claims: `floor(shares_e · ticket / T)` (§4.4).
pub fn ticket_shares(epoch_shares: u64, ticket: u64, epoch_total: u64) -> Result<u64> {
    if epoch_total == 0 || ticket > epoch_total {
        return Err(CoreError::InvalidParams);
    }
    Ok((epoch_shares as u128 * ticket as u128 / epoch_total as u128) as u64)
}

// -------------------------------------------------------------- redemption

/// In-kind redemption of `x` shares out of `supply` (§5): writes
/// `floor(q_j · x / S)` for every component into `out`. Fails with
/// [`CoreError::InvalidParams`] if `supply == 0`, `x > supply` or `out` is too short.
pub fn redeem_amounts(quantities: &[u64], x: u64, supply: u64, out: &mut [u64]) -> Result<()> {
    if supply == 0 || x > supply || out.len() < quantities.len() {
        return Err(CoreError::InvalidParams);
    }
    for (o, q) in out.iter_mut().zip(quantities) {
        *o = (*q as u128 * x as u128 / supply as u128) as u64;
    }
    Ok(())
}

// ----------------------------------------------------------------- rewards

/// Rewards in a vault token account: `balance − tracked` (§6). Fails with
/// [`CoreError::TrackedExceedsBalance`] if invariant 1 is broken.
pub fn reward_available(balance: u64, tracked: u64) -> Result<u64> {
    balance.checked_sub(tracked).ok_or(CoreError::TrackedExceedsBalance)
}

// --------------------------------------------------------------- rebalance

fn value(q: u64, price_q64: u128) -> Result<u128> {
    (q as u128).checked_mul(price_q64).map(|v| v >> 64).ok_or(CoreError::MathOverflow)
}

fn check_lengths(q: &[u64], prices: &[u128], targets: &[u16]) -> Result<()> {
    if q.is_empty() || q.len() > MAX_COMPONENTS || q.len() != prices.len() || q.len() != targets.len() {
        return Err(CoreError::InvalidParams);
    }
    if targets.iter().map(|t| *t as u32).sum::<u32>() != FULL || prices.contains(&0) {
        return Err(CoreError::InvalidParams);
    }
    Ok(())
}

/// Current weight minus target weight, in bps, per component.
/// `prices_q64` are values per unit (e.g. lamports, Q64.64), only used to
/// compare components. Fails with [`CoreError::InvalidParams`] for mismatched
/// lengths, targets not summing to 10 000, a zero price or an empty vault.
pub fn drift_bps(quantities: &[u64], prices_q64: &[u128], targets_bps: &[u16], out: &mut [i32]) -> Result<()> {
    check_lengths(quantities, prices_q64, targets_bps)?;
    if out.len() < quantities.len() {
        return Err(CoreError::InvalidParams);
    }
    let mut values = [0u128; MAX_COMPONENTS];
    let mut total = 0u128;
    for (i, (q, p)) in quantities.iter().zip(prices_q64).enumerate() {
        values[i] = value(*q, *p)?;
        total = total.checked_add(values[i]).ok_or(CoreError::MathOverflow)?;
    }
    if total == 0 {
        return Err(CoreError::InvalidParams);
    }
    for i in 0..quantities.len() {
        let current = (values[i].checked_mul(FULL as u128).ok_or(CoreError::MathOverflow)? / total) as i32;
        out[i] = current - targets_bps[i] as i32;
    }
    Ok(())
}

/// One component's rebalance trade, in its own units.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RebalanceLeg {
    /// Quantity to sell (→ WSOL).
    pub sell: u64,
    /// Quantity to buy (WSOL →).
    pub buy: u64,
}

/// Trades that bring drifted components back to target (§7), in quantities.
///
/// Components within `band_bps` of their target are left alone. Others move
/// to `target_q = V · target / 10 000 / price`. Sells are limited to
/// `turnover_bps` of the holding.
///
/// Buys are funded only by the sells (§7): when the band or the turnover
/// cap limits the sells, every buy is scaled down by `sell value / buy value`
/// (floored). The turnover cap applies to sells only.
pub fn rebalance_plan(
    quantities: &[u64],
    prices_q64: &[u128],
    targets_bps: &[u16],
    band_bps: u16,
    turnover_bps: u16,
    out: &mut [RebalanceLeg],
) -> Result<()> {
    let n = quantities.len();
    if out.len() < n || turnover_bps as u32 > FULL {
        return Err(CoreError::InvalidParams);
    }
    let mut drift = [0i32; MAX_COMPONENTS];
    drift_bps(quantities, prices_q64, targets_bps, &mut drift)?;
    let mut total = 0u128;
    for (q, p) in quantities.iter().zip(prices_q64) {
        total += value(*q, *p)?; // cannot overflow: drift_bps summed the same values
    }

    let (mut sell_value, mut buy_value) = (0u128, 0u128);
    for i in 0..n {
        out[i] = RebalanceLeg::default();
        if drift[i].unsigned_abs() <= band_bps as u32 {
            continue;
        }
        let target_value = total * targets_bps[i] as u128 / FULL as u128;
        let scaled = target_value.checked_mul(1u128 << 64).ok_or(CoreError::MathOverflow)?;
        let target_q = u64::try_from(scaled / prices_q64[i]).map_err(|_| CoreError::MathOverflow)?;
        let q = quantities[i];
        if target_q < q {
            let max_sell = (q as u128 * turnover_bps as u128 / FULL as u128) as u64;
            out[i].sell = (q - target_q).min(max_sell);
            sell_value += value(out[i].sell, prices_q64[i])?;
        } else {
            out[i].buy = target_q - q;
            buy_value = buy_value.checked_add(value(out[i].buy, prices_q64[i])?).ok_or(CoreError::MathOverflow)?;
        }
    }
    if buy_value > sell_value {
        for leg in out.iter_mut().take(n) {
            leg.buy = ((leg.buy as u128).checked_mul(sell_value).ok_or(CoreError::MathOverflow)? / buy_value) as u64;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guard::Q64;

    fn cand(b: u8, mcap: u64) -> WeightInput {
        WeightInput { mint: [b; 32], mcap, liq_cap_bps: 10_000 }
    }

    fn weights(c: &[WeightInput], cap: u16) -> Result<Vec<u16>> {
        let mut out = [0u16; MAX_COMPONENTS];
        target_weights(c, cap, &mut out).map(|_| out[..c.len()].to_vec())
    }

    // ------------------------------------------------------------- isqrt

    #[test]
    fn isqrt_is_floor_sqrt() {
        for n in [0u128, 1, 2, 3, 4, 15, 16, 17, 99, 100, 101, 1 << 40, (1 << 40) + 1, u64::MAX as u128, u128::MAX] {
            let r = isqrt(n);
            assert!(r * r <= n, "{n}");
            assert!((r + 1).checked_mul(r + 1).is_none_or(|s| s > n), "{n}");
        }
    }

    // ------------------------------------------------------------ weights

    #[test]
    fn equal_coins_split_evenly_with_remainder_to_lowest_mint() {
        let c = [cand(3, 100), cand(1, 100), cand(2, 100)];
        // 10 000 / 3 = 3 333 each; the remainder 1 goes to mint [1;32] (index 1).
        assert_eq!(weights(&c, 10_000).unwrap(), [3_333, 3_334, 3_333]);
    }

    #[test]
    fn sqrt_dampens_concentration() {
        // mcaps 1e12 and 1e10 → raw 1e6 and 1e5 → 90.9 % / 9.1 %.
        let c = [cand(1, 1_000_000_000_000), cand(2, 10_000_000_000)];
        assert_eq!(weights(&c, 10_000).unwrap(), [9_091, 909]);
    }

    #[test]
    fn iterative_capping_redistributes_pro_rata() {
        // raw 400, 300, 200, 100 → 4 000 / 3 000 / 2 000 / 1 000; cap 3 500 pins the
        // first (excess 500), spread 500 · 3/6, 2/6, 1/6 = 250, 166, 83 (+1 to the largest).
        let c = [cand(1, 160_000), cand(2, 90_000), cand(3, 40_000), cand(4, 10_000)];
        assert_eq!(weights(&c, 3_500).unwrap(), [3_500, 3_251, 2_166, 1_083]);
    }

    #[test]
    fn capping_cascades() {
        // Ten coins, one huge: cap 1 500 pins it, then the next ones as they grow.
        let mut c = [cand(0, 0); 10];
        for (i, x) in c.iter_mut().enumerate() {
            *x = cand(i as u8 + 1, if i == 0 { 10_000_000_000_000 } else { 1_000_000 * (11 - i as u64) });
        }
        let w = weights(&c, 1_500).unwrap();
        assert_eq!(w.iter().map(|x| *x as u32).sum::<u32>(), 10_000);
        assert!(w.iter().all(|x| *x <= 1_500));
        assert_eq!(w[0], 1_500);
    }

    #[test]
    fn liquidity_caps_bind_per_coin() {
        let mut c = [cand(1, 100), cand(2, 100), cand(3, 100), cand(4, 100)];
        c[0].liq_cap_bps = 1_000;
        let w = weights(&c, 10_000).unwrap();
        assert_eq!(w[0], 1_000);
        assert_eq!(w.iter().map(|x| *x as u32).sum::<u32>(), 10_000);
        assert_eq!(&w[1..], &[3_000, 3_000, 3_000]);
    }

    #[test]
    fn infeasible_and_invalid_inputs() {
        // Six coins at 15 % cannot reach 100 %.
        let six: Vec<_> = (1..=6).map(|b| cand(b, 100)).collect();
        assert_eq!(weights(&six, 1_500), Err(CoreError::InfeasibleCaps));
        // Seven can: 7 × 1 500 = 10 500.
        let seven: Vec<_> = (1..=7).map(|b| cand(b, 100)).collect();
        assert_eq!(weights(&seven, 1_500).unwrap().iter().map(|x| *x as u32).sum::<u32>(), 10_000);
        assert_eq!(weights(&[], 1_500), Err(CoreError::InvalidParams));
        let eleven: Vec<_> = (1..=11).map(|b| cand(b, 100)).collect();
        assert_eq!(weights(&eleven, 1_500), Err(CoreError::InvalidParams));
        assert_eq!(weights(&[cand(1, 100), cand(1, 50)], 10_000), Err(CoreError::InvalidParams));
        assert_eq!(weights(&[cand(1, 0), cand(2, 0)], 10_000), Err(CoreError::InvalidParams));
        let mut short = [0u16; 1];
        assert_eq!(target_weights(&[cand(1, 1), cand(2, 1)], 10_000, &mut short), Err(CoreError::InvalidParams));
    }

    #[test]
    fn zero_raw_coins_take_the_spill_only_through_the_remainder() {
        // A zero-mcap coin gets 0 unless it is the only uncapped one left.
        let c = [cand(1, 10_000), cand(2, 0)];
        assert_eq!(weights(&c, 10_000).unwrap(), [10_000, 0]);
        assert_eq!(weights(&c, 6_000).unwrap(), [6_000, 4_000]);
    }

    #[test]
    fn liquidity_cap_formula() {
        // 10 % of a $500k pool at $1M AUM = 5 % of the index.
        assert_eq!(liquidity_cap_bps(500_000, 1_000_000, 1_000), 500);
        assert_eq!(liquidity_cap_bps(500_000, 0, 1_000), 10_000);
        assert_eq!(liquidity_cap_bps(u64::MAX, 1, 10_000), 10_000);
    }

    // ----------------------------------------------------------- creation

    #[test]
    fn spec_creation_vector() {
        // §4: q_old = [1000, 500, 200], S = 100, q_new = [100, 52, 19] → 9 shares.
        assert_eq!(creation_shares(100, &[1_000, 500, 200], &[100, 52, 19], 0), Ok(9));
        // Nobody is diluted: q_old/S ≤ (q_old+q_new)/S' for every component.
        for (o, n) in [(1_000u64, 100u64), (500, 52), (200, 19)] {
            assert!(o * 109 <= (o + n) * 100);
        }
    }

    #[test]
    fn creation_edges() {
        assert_eq!(creation_shares(0, &[], &[], 5_000_000_000), Ok(5_000_000_000));
        assert_eq!(creation_shares(100, &[1, 2], &[1], 0), Err(CoreError::InvalidParams));
        assert_eq!(creation_shares(100, &[], &[], 0), Err(CoreError::InvalidParams));
        assert_eq!(creation_shares(100, &[0, 1], &[1, 1], 0), Err(CoreError::InvalidParams));
        assert_eq!(creation_shares(u64::MAX, &[1], &[1], 0), Ok(u64::MAX));
        assert_eq!(creation_shares(100, &[1_000], &[0], 0), Ok(0));
        assert_eq!(ticket_shares(9, 1, 3), Ok(3));
        assert_eq!(ticket_shares(10, 1, 3), Ok(3));
        assert_eq!(ticket_shares(10, 4, 3), Err(CoreError::InvalidParams));
        assert_eq!(ticket_shares(10, 0, 0), Err(CoreError::InvalidParams));
    }

    // ---------------------------------------------------------- redemption

    #[test]
    fn redeem_floors_per_component() {
        let mut out = [0u64; 3];
        redeem_amounts(&[1_100, 552, 219], 10, 109, &mut out).unwrap();
        assert_eq!(out, [100, 50, 20]);
        redeem_amounts(&[1_100, 552, 219], 109, 109, &mut out).unwrap();
        assert_eq!(out, [1_100, 552, 219]);
        assert_eq!(redeem_amounts(&[1], 2, 1, &mut out), Err(CoreError::InvalidParams));
        assert_eq!(redeem_amounts(&[1], 0, 0, &mut out), Err(CoreError::InvalidParams));
        assert_eq!(redeem_amounts(&[1, 2, 3, 4], 1, 1, &mut out), Err(CoreError::InvalidParams));
    }

    #[test]
    fn rewards_are_balance_minus_tracked() {
        assert_eq!(reward_available(150, 100), Ok(50));
        assert_eq!(reward_available(100, 100), Ok(0));
        assert_eq!(reward_available(99, 100), Err(CoreError::TrackedExceedsBalance));
    }

    // ----------------------------------------------------------- rebalance

    #[test]
    fn drift_against_targets() {
        let mut d = [0i32; 3];
        // Equal prices; holdings 50/30/20 % vs targets 40/40/20 %.
        drift_bps(&[500, 300, 200], &[Q64; 3], &[4_000, 4_000, 2_000], &mut d).unwrap();
        assert_eq!(d, [1_000, -1_000, 0]);
        assert_eq!(drift_bps(&[1, 1], &[Q64, Q64], &[5_000, 4_999], &mut d), Err(CoreError::InvalidParams));
        assert_eq!(drift_bps(&[1, 1], &[Q64, 0], &[5_000, 5_000], &mut d), Err(CoreError::InvalidParams));
        assert_eq!(drift_bps(&[0, 0], &[Q64, Q64], &[5_000, 5_000], &mut d), Err(CoreError::InvalidParams));
    }

    #[test]
    fn rebalance_sells_overweight_buys_underweight() {
        let mut legs = [RebalanceLeg::default(); 3];
        rebalance_plan(&[500, 300, 200], &[Q64; 3], &[4_000, 4_000, 2_000], 200, 10_000, &mut legs).unwrap();
        assert_eq!(legs, [RebalanceLeg { sell: 100, buy: 0 }, RebalanceLeg { sell: 0, buy: 100 }, RebalanceLeg::default()]);
    }

    #[test]
    fn rebalance_band_and_turnover() {
        let mut legs = [RebalanceLeg::default(); 3];
        // Drift of 150 bps stays inside a 200 bps band.
        rebalance_plan(&[4_150, 3_850, 2_000], &[Q64; 3], &[4_000, 4_000, 2_000], 200, 3_000, &mut legs).unwrap();
        assert_eq!(legs, [RebalanceLeg::default(); 3]);
        // Turnover 10 % caps the sell at 50; the buy is scaled to the 50 sold.
        rebalance_plan(&[500, 300, 200], &[Q64; 3], &[4_000, 4_000, 2_000], 200, 1_000, &mut legs).unwrap();
        assert_eq!(legs[0], RebalanceLeg { sell: 50, buy: 0 });
        assert_eq!(legs[1], RebalanceLeg { sell: 0, buy: 50 });
    }

    #[test]
    fn rebalance_prices_convert_values_to_quantities() {
        // Component 0 is worth 2 per unit: 300 units = 600 of 1 000 total value.
        let mut legs = [RebalanceLeg::default(); 2];
        rebalance_plan(&[300, 400], &[2 * Q64, Q64], &[5_000, 5_000], 0, 10_000, &mut legs).unwrap();
        assert_eq!(legs, [RebalanceLeg { sell: 50, buy: 0 }, RebalanceLeg { sell: 0, buy: 100 }]);
        assert_eq!(rebalance_plan(&[1], &[Q64], &[10_000], 0, 10_001, &mut legs), Err(CoreError::InvalidParams));
    }

    // -------------------------------------------------- invariants §11.1–3

    struct XorShift(u64);
    impl XorShift {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }
    }

    #[test]
    fn invariants_vault_lifecycle() {
        let mut rng = XorShift(0xD1B5_4A32_D192_ED03);
        for round in 0..200 {
            let n = 1 + rng.below(MAX_COMPONENTS as u64) as usize;
            let mut q = [0u64; MAX_COMPONENTS]; // tracked quantities
            let mut bal = [0u64; MAX_COMPONENTS]; // token account balances
            let mut supply = 0u64;
            for step in 0..40 {
                match rng.below(4) {
                    // creation: buy some of every component, mint shares
                    0 => {
                        // Genesis buys up to 1e9 of each; later epochs add at most 25 %
                        // so supply stays far below u64::MAX over 40 steps.
                        let mut add = [0u64; MAX_COMPONENTS];
                        for j in 0..n {
                            add[j] = if supply == 0 { 1 + rng.below(1_000_000_000) } else { 1 + rng.below((q[j] / 4).max(1)) };
                        }
                        if supply > 0 && q[..n].contains(&0) {
                            continue;
                        }
                        let t_net = 1 + rng.below(10_000_000_000);
                        let s = creation_shares(supply, &q[..n], &add[..n], t_net).unwrap();
                        let new_supply = supply + s;
                        // §11.2: value per share never falls for existing holders.
                        for j in 0..n {
                            if supply > 0 {
                                assert!(
                                    q[j] as u128 * new_supply as u128 <= (q[j] + add[j]) as u128 * supply as u128,
                                    "round {round} step {step}"
                                );
                            }
                            q[j] += add[j];
                            bal[j] += add[j];
                        }
                        supply = new_supply;
                    }
                    // redemption: §11.3 exact floor amounts, holders left behind not diluted
                    1 if supply > 0 => {
                        let x = 1 + rng.below(supply);
                        let mut out = [0u64; MAX_COMPONENTS];
                        redeem_amounts(&q[..n], x, supply, &mut out).unwrap();
                        for j in 0..n {
                            assert_eq!(out[j] as u128, q[j] as u128 * x as u128 / supply as u128);
                            let left = supply - x;
                            assert!((q[j] - out[j]) as u128 * supply as u128 >= q[j] as u128 * left as u128);
                            q[j] -= out[j];
                            bal[j] -= out[j];
                        }
                        supply -= x;
                    }
                    // reward inflow lands in the token account only
                    2 => {
                        let j = rng.below(n as u64) as usize;
                        bal[j] += rng.below(1_000_000);
                    }
                    // distribution never exceeds what is available
                    _ => {
                        let j = rng.below(n as u64) as usize;
                        let avail = reward_available(bal[j], q[j]).unwrap();
                        bal[j] -= if avail == 0 { 0 } else { rng.below(avail + 1) };
                    }
                }
                // §11.1
                for j in 0..n {
                    assert!(bal[j] >= q[j], "round {round} step {step}");
                }
            }
        }
    }

    #[test]
    fn invariants_target_weights() {
        let mut rng = XorShift(0x2545_F491_4F6C_DD1D);
        for _ in 0..500 {
            let n = 1 + rng.below(MAX_COMPONENTS as u64) as usize;
            let mut c = [cand(0, 0); MAX_COMPONENTS];
            for (i, x) in c.iter_mut().take(n).enumerate() {
                *x = WeightInput { mint: [i as u8 + 1; 32], mcap: rng.below(1 << 50), liq_cap_bps: (500 + rng.below(9_501)) as u16 };
            }
            let cap = (500 + rng.below(9_501)) as u16;
            let mut out = [0u16; MAX_COMPONENTS];
            match target_weights(&c[..n], cap, &mut out) {
                Ok(()) => {
                    assert_eq!(out[..n].iter().map(|x| *x as u32).sum::<u32>(), 10_000);
                    for i in 0..n {
                        assert!(out[i] <= cap.min(c[i].liq_cap_bps));
                    }
                }
                Err(CoreError::InfeasibleCaps) => {
                    assert!(c[..n].iter().map(|x| cap.min(x.liq_cap_bps) as u32).sum::<u32>() < 10_000);
                }
                Err(CoreError::InvalidParams) => assert!(c[..n].iter().all(|x| isqrt(x.mcap as u128) == 0)),
                Err(e) => panic!("{e:?}"),
            }
        }
    }
}
