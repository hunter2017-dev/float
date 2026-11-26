//! Coin Families: rules shared by the router and the off-chain tools.
//!
//! Spec: `docs/proposals/coin-families.md`. A **child** coin pays its holders
//! in a **parent** coin (or `$FLOAT`) instead of its paired token.
//!
//! | Item | Spec | What it decides |
//! | --- | --- | --- |
//! | [`check_parent_eligibility`] | §3 | Whether a coin may be a parent right now |
//! | [`child_depth`], [`validate_lineage`] | §3, §9.4 | Depth limit and no cycles |
//! | [`check_mode`] | §2, §6 | Mode A needs `paired_mint == parent`; Mode B must not |
//! | [`validate_route`] | §4.1, §9.3 | ≤ 3 contiguous hops, distinct pinned pools |
//! | [`hop_min_out`], [`route_min_outs`] | §4.1 | Per-hop `min_out` from [`crate::guard`] |
//! | [`max_hop_input`] | §4.1 | Largest hop input within the per-hop impact cap |
//! | [`ModeBLedger`] | §4.1, §9.1–2 | Credit what was received, debit payouts |
//! | [`daily_parent_demand`] | §7 | `V · f · holders_share` |
//!
//! Amounts are base units (`u64`); USD values are micro-USD (`u64`,
//! 1 USD = [`MICRO_USD`]).

use crate::buyback;
use crate::cpmm::Fees;
use crate::error::{CoreError, Result};
use crate::guard;
use crate::BPS;

/// A 32-byte account address (mint or pool).
pub type Address = [u8; 32];

/// Micro-USD per USD.
pub const MICRO_USD: u64 = 1_000_000;
/// Seconds per day.
pub const SECS_PER_DAY: i64 = 86_400;
/// Maximum hops in a conversion route (§4.1).
pub const MAX_ROUTE_HOPS: usize = 3;
/// Default `parent_min_age`: 7 days, matching the official 7-day maturity
/// rule for new pairs (<https://www.floatlaunch.xyz/docs>, Rewards → Airdrops).
pub const DEFAULT_PARENT_MIN_AGE_SECS: i64 = 7 * SECS_PER_DAY;
/// Default `parent_min_pool_usd`: $100 000 on the paired side (§3).
pub const DEFAULT_PARENT_MIN_POOL_USD: u64 = 100_000 * MICRO_USD;
/// Default `max_depth`: `$FLOAT` → child → grandchild (§3).
pub const DEFAULT_MAX_DEPTH: u8 = 2;

/// How a child relates to its parent (§2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FamilyMode {
    /// Mode B: the child trades against its usual pair; the holders' share is
    /// converted into the parent before payout.
    RewardLinked,
    /// Mode A: the child is launched with the parent as its LaunchLab quote mint.
    NativeQuote,
}

impl FamilyMode {
    /// On-chain encoding: 0 = Mode B (reward-linked), 1 = Mode A (native quote).
    pub const fn as_u8(self) -> u8 {
        match self {
            Self::RewardLinked => 0,
            Self::NativeQuote => 1,
        }
    }

    /// Inverse of [`FamilyMode::as_u8`].
    pub fn from_u8(v: u8) -> Result<Self> {
        match v {
            0 => Ok(Self::RewardLinked),
            1 => Ok(Self::NativeQuote),
            _ => Err(CoreError::InvalidParams),
        }
    }
}

/// What kind of coin the parent is (§3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParentKind {
    /// `$FLOAT`: always eligible.
    Flagship,
    /// Any other coin: must meet every rule in [`check_parent_eligibility`].
    Coin,
}

/// Tunable eligibility thresholds (§3). Defaults match the spec.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EligibilityParams {
    /// Minimum time since graduation, in seconds.
    pub parent_min_age_secs: i64,
    /// Minimum paired-side liquidity of the parent's CPMM pool, in micro-USD.
    pub parent_min_pool_usd: u64,
    /// Deepest allowed child depth (`$FLOAT` and root coins are depth 0).
    pub max_depth: u8,
}

impl Default for EligibilityParams {
    fn default() -> Self {
        Self {
            parent_min_age_secs: DEFAULT_PARENT_MIN_AGE_SECS,
            parent_min_pool_usd: DEFAULT_PARENT_MIN_POOL_USD,
            max_depth: DEFAULT_MAX_DEPTH,
        }
    }
}

impl EligibilityParams {
    /// Fails with [`CoreError::InvalidParams`] unless `max_depth ≥ 1` and
    /// `parent_min_age_secs ≥ 0`.
    pub fn validate(&self) -> Result<()> {
        if self.max_depth == 0 || self.parent_min_age_secs < 0 {
            return Err(CoreError::InvalidParams);
        }
        Ok(())
    }
}

/// Observed state of a would-be parent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EligibilityInput {
    /// `$FLOAT` or another coin.
    pub kind: ParentKind,
    /// Launched with Float's LaunchLab platform config (mainnet) or
    /// registered in `float-router` (reference implementation).
    pub is_float_coin: bool,
    /// Unix time of graduation; 0 while on the bonding curve.
    pub graduated_at: i64,
    /// Current unix time.
    pub now: i64,
    /// Paired-side value of the parent's CPMM pool, in micro-USD.
    pub pool_paired_usd: u64,
    /// True while the issuer of the parent's paired asset pauses it.
    pub paired_paused: bool,
    /// Depth of the parent (0 for `$FLOAT` and for coins without a parent).
    pub parent_depth: u8,
}

/// Checks the §3 rules in order and returns the first one that fails:
/// [`CoreError::ParentNotFloatCoin`], [`CoreError::ParentNotGraduated`],
/// [`CoreError::ParentTooYoung`], [`CoreError::ParentPoolTooThin`],
/// [`CoreError::ParentPaused`], [`CoreError::FamilyTooDeep`].
/// `$FLOAT` is always eligible. Invalid params fail with
/// [`CoreError::InvalidParams`].
pub fn check_parent_eligibility(params: &EligibilityParams, input: &EligibilityInput) -> Result<()> {
    params.validate()?;
    if input.kind == ParentKind::Flagship {
        return Ok(());
    }
    if !input.is_float_coin {
        return Err(CoreError::ParentNotFloatCoin);
    }
    if input.graduated_at <= 0 {
        return Err(CoreError::ParentNotGraduated);
    }
    // A graduation time in the future counts as "too young".
    let age = input.now.checked_sub(input.graduated_at).ok_or(CoreError::MathOverflow)?;
    if age < params.parent_min_age_secs {
        return Err(CoreError::ParentTooYoung);
    }
    if input.pool_paired_usd < params.parent_min_pool_usd {
        return Err(CoreError::ParentPoolTooThin);
    }
    if input.paired_paused {
        return Err(CoreError::ParentPaused);
    }
    child_depth(input.parent_depth, params.max_depth).map(|_| ())
}

/// Depth of a child of a parent at `parent_depth`, or
/// [`CoreError::FamilyTooDeep`] if it would exceed `max_depth`.
pub fn child_depth(parent_depth: u8, max_depth: u8) -> Result<u8> {
    let depth = parent_depth.checked_add(1).ok_or(CoreError::FamilyTooDeep)?;
    if depth > max_depth {
        return Err(CoreError::FamilyTooDeep);
    }
    Ok(depth)
}

/// Validates a new child's lineage and returns its depth.
///
/// `ancestors` are the parent's ancestors, from the parent's own parent up to
/// the root (empty when the parent is `$FLOAT` or a coin without a parent), so
/// the parent's depth is `ancestors.len()`. Fails with
/// [`CoreError::FamilyTooDeep`] if the child would exceed `max_depth` (checked
/// first, which also bounds the cycle scan), and with
/// [`CoreError::FamilyCycle`] if the child is the parent or one of its
/// ancestors, or if the chain itself repeats a coin.
pub fn validate_lineage(child: &Address, parent: &Address, ancestors: &[Address], max_depth: u8) -> Result<u8> {
    let parent_depth = u8::try_from(ancestors.len()).map_err(|_| CoreError::FamilyTooDeep)?;
    let depth = child_depth(parent_depth, max_depth)?;
    if child == parent {
        return Err(CoreError::FamilyCycle);
    }
    for (i, a) in ancestors.iter().enumerate() {
        if a == child || a == parent || ancestors[..i].contains(a) {
            return Err(CoreError::FamilyCycle);
        }
    }
    Ok(depth)
}

/// Checks that the mode matches the pairing (§6 `register_family`): Mode A
/// requires the child's `paired_mint == parent`; Mode B requires them to differ
/// (a Mode B child already paired with its parent would have nothing to convert).
pub fn check_mode(mode: FamilyMode, child_paired_mint: &Address, parent: &Address) -> Result<()> {
    let paired_with_parent = child_paired_mint == parent;
    match (mode, paired_with_parent) {
        (FamilyMode::NativeQuote, true) | (FamilyMode::RewardLinked, false) => Ok(()),
        _ => Err(CoreError::FamilyModeMismatch),
    }
}

/// One swap of a conversion route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hop {
    /// CPMM pool the hop trades through.
    pub pool: Address,
    /// Mint sent into the pool.
    pub input_mint: Address,
    /// Mint received from the pool.
    pub output_mint: Address,
}

/// Validates a conversion route from `from` to `to` (§4.1, §9.3):
///
/// * 1 to [`MAX_ROUTE_HOPS`] hops ([`CoreError::RouteEmpty`], [`CoreError::RouteTooLong`]);
/// * starts at `from`, ends at `to`, each hop's output is the next hop's input,
///   and no mint is visited twice ([`CoreError::RouteBroken`]);
/// * no pool is used twice ([`CoreError::RoutePoolReused`]);
/// * every pool is in `pinned` ([`CoreError::RoutePoolNotPinned`]).
pub fn validate_route(hops: &[Hop], from: &Address, to: &Address, pinned: &[Address]) -> Result<()> {
    if hops.is_empty() {
        return Err(CoreError::RouteEmpty);
    }
    if hops.len() > MAX_ROUTE_HOPS {
        return Err(CoreError::RouteTooLong);
    }
    let mut cursor = from;
    for (i, h) in hops.iter().enumerate() {
        if h.input_mint != *cursor || h.output_mint == h.input_mint {
            return Err(CoreError::RouteBroken);
        }
        // `from` and every earlier output are the mints already visited.
        if h.output_mint == *from || hops[..i].iter().any(|p| p.output_mint == h.output_mint) {
            return Err(CoreError::RouteBroken);
        }
        cursor = &h.output_mint;
    }
    if cursor != to {
        return Err(CoreError::RouteBroken);
    }
    for (i, h) in hops.iter().enumerate() {
        if hops[..i].iter().any(|p| p.pool == h.pool) {
            return Err(CoreError::RoutePoolReused);
        }
    }
    if hops.iter().any(|h| !pinned.contains(&h.pool)) {
        return Err(CoreError::RoutePoolNotPinned);
    }
    Ok(())
}

/// `min_out` of one hop: the reference output for `amount_in` at
/// `price_q64` (output per input, Q64.64) less `guard_bps`
/// ([`guard::expected_out`] then [`guard::min_out`]).
pub fn hop_min_out(amount_in: u64, price_q64: u128, guard_bps: u16) -> Result<u64> {
    guard::min_out(guard::expected_out(amount_in, price_q64)?, guard_bps)
}

/// Per-hop minimum outputs for a whole route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouteMinOuts {
    /// Number of hops.
    pub len: usize,
    /// `min_out` of each hop; entries past `len` are 0.
    pub min_outs: [u64; MAX_ROUTE_HOPS],
}

impl RouteMinOuts {
    /// The meaningful entries.
    pub fn as_slice(&self) -> &[u64] {
        &self.min_outs[..self.len]
    }

    /// Minimum output of the last hop: the least the route can deliver.
    pub fn last(&self) -> u64 {
        if self.len == 0 {
            0
        } else {
            self.min_outs[self.len - 1]
        }
    }
}

/// Composes per-hop guards for a route that sends `amount_in` through hops
/// with reference prices `prices_q64` (one per hop).
///
/// Interpretation: the spec asks for "per-hop guard composition" without
/// fixing it. Hop `i`'s minimum is computed from hop `i-1`'s **minimum**, not
/// its expected output: `m_0 = amount_in`, `m_i = hop_min_out(m_{i-1}, p_i)`.
/// Because outputs are monotonic in inputs, any execution in which every hop
/// respects its own guard (checked on chain against the hop's actual input
/// with [`guard::check`]) also meets every `m_i`, so these values are safe to
/// pass as the swaps' `minimum_amount_out`. The end-to-end tolerance is
/// therefore `1 − (1 − guard)^hops`.
pub fn route_min_outs(amount_in: u64, prices_q64: &[u128], guard_bps: u16) -> Result<RouteMinOuts> {
    if prices_q64.is_empty() {
        return Err(CoreError::RouteEmpty);
    }
    if prices_q64.len() > MAX_ROUTE_HOPS {
        return Err(CoreError::RouteTooLong);
    }
    let mut out = RouteMinOuts { len: prices_q64.len(), min_outs: [0; MAX_ROUTE_HOPS] };
    let mut m = amount_in;
    for (i, p) in prices_q64.iter().enumerate() {
        m = hop_min_out(m, *p, guard_bps)?;
        out.min_outs[i] = m;
    }
    Ok(out)
}

/// Largest input for one hop whose price impact stays within
/// `max_impact_bps` (exact CPMM math, fees included). Larger amounts must be
/// split across cycles (§4.1, §8). Same search as
/// [`buyback::max_input_within_impact`].
pub fn max_hop_input(input_reserve: u64, output_reserve: u64, fees: &Fees, max_impact_bps: u64) -> Result<u64> {
    buyback::max_input_within_impact(input_reserve, output_reserve, fees, max_impact_bps)
}

/// Balance increase of a vault between two reads (§9.2: credit what was
/// received). Fails with [`CoreError::MathOverflow`] if the balance fell.
pub fn received_amount(before: u64, after: u64) -> Result<u64> {
    after.checked_sub(before).ok_or(CoreError::MathOverflow)
}

/// Invariant 1 (§9.1): the parent-mint holders vault covers the
/// `holders_unpaid_parent` of every child with that parent.
pub fn parent_vault_solvent(vault_balance: u64, unpaid_parent: &[u64]) -> Result<bool> {
    let mut sum: u64 = 0;
    for u in unpaid_parent {
        sum = sum.checked_add(*u).ok_or(CoreError::MathOverflow)?;
    }
    Ok(sum <= vault_balance)
}

/// Mode B accounting for one child (§4.1, §5): the paired-mint side lives in
/// the child's `CoinRecord.holders_unpaid`, the parent-mint side and the
/// lifetime totals in its `FamilyRecord`.
///
/// Every method checks first and mutates only on success.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ModeBLedger {
    /// Child's unpaid holder rewards still in its paired mint (`CoinRecord.holders_unpaid`).
    pub holders_unpaid_paired: u64,
    /// Child's unpaid holder rewards already converted into the parent.
    pub holders_unpaid_parent: u64,
    /// Lifetime paired-mint amount sent into conversions.
    pub total_converted_paired: u64,
    /// Lifetime parent amount received from conversions.
    pub total_parent_bought: u64,
    /// Lifetime parent amount paid to holders.
    pub total_parent_paid: u64,
}

impl ModeBLedger {
    /// Records a conversion of `amount_in` paired units that moved the
    /// parent-mint holders vault from `vault_before` to `vault_after`.
    /// Credits the **received** amount (the vault delta), never a quote, so
    /// Token-2022 transfer fees cannot make the shared vault insolvent.
    /// Returns the amount received.
    ///
    /// Fails with [`CoreError::InvalidParams`] if `amount_in == 0`, with
    /// [`CoreError::ExceedsUnpaid`] if `amount_in > holders_unpaid_paired`, and
    /// with [`CoreError::MathOverflow`] if the vault balance fell.
    pub fn record_conversion(&mut self, amount_in: u64, vault_before: u64, vault_after: u64) -> Result<u64> {
        if amount_in == 0 {
            return Err(CoreError::InvalidParams);
        }
        let unpaid_paired = self.holders_unpaid_paired.checked_sub(amount_in).ok_or(CoreError::ExceedsUnpaid)?;
        let received = received_amount(vault_before, vault_after)?;
        let unpaid_parent = self.holders_unpaid_parent.checked_add(received).ok_or(CoreError::MathOverflow)?;
        let converted = self.total_converted_paired.checked_add(amount_in).ok_or(CoreError::MathOverflow)?;
        let bought = self.total_parent_bought.checked_add(received).ok_or(CoreError::MathOverflow)?;
        self.holders_unpaid_paired = unpaid_paired;
        self.holders_unpaid_parent = unpaid_parent;
        self.total_converted_paired = converted;
        self.total_parent_bought = bought;
        Ok(received)
    }

    /// Records a payout batch of `total` parent units. Fails with
    /// [`CoreError::ExceedsUnpaid`] if it exceeds `holders_unpaid_parent`.
    pub fn record_payout(&mut self, total: u64) -> Result<()> {
        let unpaid = self.holders_unpaid_parent.checked_sub(total).ok_or(CoreError::ExceedsUnpaid)?;
        let paid = self.total_parent_paid.checked_add(total).ok_or(CoreError::MathOverflow)?;
        self.holders_unpaid_parent = unpaid;
        self.total_parent_paid = paid;
        Ok(())
    }
}

/// Mode B parent demand per day (§7): `V · f · holders_share`, with the daily
/// volume `V` in micro-USD and both rates in bps. Floors to the micro-USD.
///
/// `fee_bps` is the part of the trading fee that goes through Float's split.
/// `holders_bps` is the holders' share of it (17.5 % for standard coins per
/// <https://www.floatlaunch.xyz/docs>, Fees); it is a parameter, not a constant.
pub fn daily_parent_demand(volume_usd: u64, fee_bps: u16, holders_bps: u16) -> Result<u64> {
    if fee_bps as u64 > BPS || holders_bps as u64 > BPS {
        return Err(CoreError::InvalidParams);
    }
    let v = (volume_usd as u128) * (fee_bps as u128) * (holders_bps as u128) / (BPS as u128 * BPS as u128);
    // v <= volume_usd because both rates are <= 1.
    Ok(v as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guard::Q64;

    const NOW: i64 = 1_800_000_000;

    fn addr(b: u8) -> Address {
        [b; 32]
    }

    fn coin_input() -> EligibilityInput {
        EligibilityInput {
            kind: ParentKind::Coin,
            is_float_coin: true,
            graduated_at: NOW - DEFAULT_PARENT_MIN_AGE_SECS,
            now: NOW,
            pool_paired_usd: DEFAULT_PARENT_MIN_POOL_USD,
            paired_paused: false,
            parent_depth: 0,
        }
    }

    // ------------------------------------------------------------ eligibility

    #[test]
    fn defaults_match_spec() {
        let p = EligibilityParams::default();
        assert_eq!(p.parent_min_age_secs, 604_800);
        assert_eq!(p.parent_min_pool_usd, 100_000_000_000);
        assert_eq!(p.max_depth, 2);
        assert!(p.validate().is_ok());
    }

    #[test]
    fn eligible_coin_at_exact_bounds() {
        assert_eq!(check_parent_eligibility(&EligibilityParams::default(), &coin_input()), Ok(()));
    }

    #[test]
    fn flagship_is_always_eligible() {
        let i = EligibilityInput {
            kind: ParentKind::Flagship,
            is_float_coin: false,
            graduated_at: 0,
            now: NOW,
            pool_paired_usd: 0,
            paired_paused: true,
            parent_depth: 0,
        };
        assert_eq!(check_parent_eligibility(&EligibilityParams::default(), &i), Ok(()));
    }

    #[test]
    fn each_rule_has_its_own_error() {
        let p = EligibilityParams::default();
        let cases: [(EligibilityInput, CoreError); 7] = [
            (EligibilityInput { is_float_coin: false, ..coin_input() }, CoreError::ParentNotFloatCoin),
            (EligibilityInput { graduated_at: 0, ..coin_input() }, CoreError::ParentNotGraduated),
            (EligibilityInput { graduated_at: NOW - DEFAULT_PARENT_MIN_AGE_SECS + 1, ..coin_input() }, CoreError::ParentTooYoung),
            (EligibilityInput { graduated_at: NOW + 10, ..coin_input() }, CoreError::ParentTooYoung),
            (EligibilityInput { pool_paired_usd: DEFAULT_PARENT_MIN_POOL_USD - 1, ..coin_input() }, CoreError::ParentPoolTooThin),
            (EligibilityInput { paired_paused: true, ..coin_input() }, CoreError::ParentPaused),
            (EligibilityInput { parent_depth: 2, ..coin_input() }, CoreError::FamilyTooDeep),
        ];
        for (input, err) in cases {
            assert_eq!(check_parent_eligibility(&p, &input), Err(err), "{input:?}");
        }
    }

    #[test]
    fn rules_are_checked_in_spec_order() {
        // Fails several rules at once: the first one wins.
        let i = EligibilityInput { graduated_at: 0, pool_paired_usd: 0, paired_paused: true, parent_depth: 9, ..coin_input() };
        assert_eq!(check_parent_eligibility(&EligibilityParams::default(), &i), Err(CoreError::ParentNotGraduated));
    }

    #[test]
    fn depth_one_parent_is_allowed_depth_two_is_not() {
        let p = EligibilityParams::default();
        assert!(check_parent_eligibility(&p, &EligibilityInput { parent_depth: 1, ..coin_input() }).is_ok());
        assert_eq!(check_parent_eligibility(&p, &EligibilityInput { parent_depth: 2, ..coin_input() }), Err(CoreError::FamilyTooDeep));
    }

    #[test]
    fn invalid_params_rejected() {
        let i = coin_input();
        let zero_depth = EligibilityParams { max_depth: 0, ..Default::default() };
        let neg_age = EligibilityParams { parent_min_age_secs: -1, ..Default::default() };
        assert_eq!(check_parent_eligibility(&zero_depth, &i), Err(CoreError::InvalidParams));
        assert_eq!(check_parent_eligibility(&neg_age, &i), Err(CoreError::InvalidParams));
    }

    #[test]
    fn age_overflow_is_an_error_not_a_panic() {
        let i = EligibilityInput { graduated_at: 1, now: i64::MIN, ..coin_input() };
        assert_eq!(check_parent_eligibility(&EligibilityParams::default(), &i), Err(CoreError::MathOverflow));
    }

    #[test]
    fn mode_round_trip() {
        for m in [FamilyMode::RewardLinked, FamilyMode::NativeQuote] {
            assert_eq!(FamilyMode::from_u8(m.as_u8()), Ok(m));
        }
        assert_eq!(FamilyMode::from_u8(2), Err(CoreError::InvalidParams));
    }

    // ----------------------------------------------------------- depth & lineage

    #[test]
    fn child_depth_bounds() {
        assert_eq!(child_depth(0, 2), Ok(1));
        assert_eq!(child_depth(1, 2), Ok(2));
        assert_eq!(child_depth(2, 2), Err(CoreError::FamilyTooDeep));
        assert_eq!(child_depth(u8::MAX, u8::MAX), Err(CoreError::FamilyTooDeep));
    }

    #[test]
    fn lineage_depths() {
        let (flt, a, b, c) = (addr(1), addr(2), addr(3), addr(4));
        assert_eq!(validate_lineage(&a, &flt, &[], 2), Ok(1));
        assert_eq!(validate_lineage(&b, &a, &[flt], 2), Ok(2));
        assert_eq!(validate_lineage(&c, &b, &[a, flt], 2), Err(CoreError::FamilyTooDeep));
        assert_eq!(validate_lineage(&c, &b, &[a, flt], 3), Ok(3));
    }

    #[test]
    fn lineage_cycles() {
        let (a, b, c) = (addr(2), addr(3), addr(4));
        assert_eq!(validate_lineage(&a, &a, &[], 2), Err(CoreError::FamilyCycle));
        assert_eq!(validate_lineage(&a, &b, &[a], 2), Err(CoreError::FamilyCycle));
        assert_eq!(validate_lineage(&c, &b, &[b], 3), Err(CoreError::FamilyCycle));
        assert_eq!(validate_lineage(&c, &b, &[a, a], 3), Err(CoreError::FamilyCycle));
    }

    #[test]
    fn lineage_longer_than_u8_is_too_deep() {
        let chain = [addr(9); 300];
        assert_eq!(validate_lineage(&addr(1), &addr(2), &chain, u8::MAX), Err(CoreError::FamilyTooDeep));
    }

    #[test]
    fn mode_matches_pairing() {
        let (p, other) = (addr(1), addr(2));
        assert_eq!(check_mode(FamilyMode::NativeQuote, &p, &p), Ok(()));
        assert_eq!(check_mode(FamilyMode::NativeQuote, &other, &p), Err(CoreError::FamilyModeMismatch));
        assert_eq!(check_mode(FamilyMode::RewardLinked, &other, &p), Ok(()));
        assert_eq!(check_mode(FamilyMode::RewardLinked, &p, &p), Err(CoreError::FamilyModeMismatch));
    }

    // ------------------------------------------------------------------ routes

    fn hop(pool: u8, i: u8, o: u8) -> Hop {
        Hop { pool: addr(pool), input_mint: addr(i), output_mint: addr(o) }
    }

    #[test]
    fn valid_routes_of_one_to_three_hops() {
        let pinned = [addr(100), addr(101), addr(102)];
        assert_eq!(validate_route(&[hop(100, 1, 2)], &addr(1), &addr(2), &pinned), Ok(()));
        assert_eq!(validate_route(&[hop(100, 1, 2), hop(101, 2, 3)], &addr(1), &addr(3), &pinned), Ok(()));
        assert_eq!(validate_route(&[hop(100, 1, 2), hop(101, 2, 3), hop(102, 3, 4)], &addr(1), &addr(4), &pinned), Ok(()));
    }

    #[test]
    fn route_errors() {
        let pinned = [addr(100), addr(101), addr(102), addr(103)];
        let (a, d) = (addr(1), addr(4));
        assert_eq!(validate_route(&[], &a, &d, &pinned), Err(CoreError::RouteEmpty));
        let four = [hop(100, 1, 2), hop(101, 2, 3), hop(102, 3, 5), hop(103, 5, 4)];
        assert_eq!(validate_route(&four, &a, &d, &pinned), Err(CoreError::RouteTooLong));
        // wrong start, gap between hops, wrong end, self-hop, revisited mint
        assert_eq!(validate_route(&[hop(100, 2, 4)], &a, &d, &pinned), Err(CoreError::RouteBroken));
        assert_eq!(validate_route(&[hop(100, 1, 2), hop(101, 3, 4)], &a, &d, &pinned), Err(CoreError::RouteBroken));
        assert_eq!(validate_route(&[hop(100, 1, 2)], &a, &d, &pinned), Err(CoreError::RouteBroken));
        assert_eq!(validate_route(&[hop(100, 1, 1)], &a, &a, &pinned), Err(CoreError::RouteBroken));
        assert_eq!(validate_route(&[hop(100, 1, 2), hop(101, 2, 1), hop(102, 1, 4)], &a, &d, &pinned), Err(CoreError::RouteBroken));
        assert_eq!(validate_route(&[hop(100, 1, 2), hop(101, 2, 3), hop(102, 3, 2)], &a, &addr(2), &pinned), Err(CoreError::RouteBroken));
        // same pool twice
        assert_eq!(validate_route(&[hop(100, 1, 2), hop(100, 2, 4)], &a, &d, &pinned), Err(CoreError::RoutePoolReused));
        // unpinned pool
        assert_eq!(validate_route(&[hop(100, 1, 2), hop(200, 2, 4)], &a, &d, &pinned), Err(CoreError::RoutePoolNotPinned));
    }

    #[test]
    fn hop_min_out_reuses_guard() {
        assert_eq!(hop_min_out(1_000, Q64 / 2, 200), Ok(490));
        assert_eq!(hop_min_out(1_000, Q64, 0), Ok(1_000));
        assert_eq!(hop_min_out(1_000, Q64, 10_001), Err(CoreError::MathOverflow));
        assert_eq!(hop_min_out(u64::MAX, Q64 * 2, 0), Err(CoreError::MathOverflow));
    }

    #[test]
    fn route_min_outs_compose_from_previous_minimum() {
        // 1 000 000 → ×2 → ×0.5 → ×3 with a 2 % guard per hop.
        let r = route_min_outs(1_000_000, &[2 * Q64, Q64 / 2, 3 * Q64], 200).unwrap();
        assert_eq!(r.as_slice(), &[1_960_000, 960_400, 2_823_576]);
        assert_eq!(r.last(), 2_823_576);
        // End-to-end tolerance is 1 - 0.98^3.
        assert_eq!(r.last(), (3_000_000u128 * 98 * 98 * 98 / 1_000_000) as u64);
    }

    #[test]
    fn route_min_outs_rounding_and_bounds() {
        // Floors at every hop: 3 at ×(1/3) → 0.
        let third = Q64 / 3;
        assert_eq!(route_min_outs(3, &[third], 0).unwrap().as_slice(), &[0]);
        assert_eq!(route_min_outs(1, &[], 200), Err(CoreError::RouteEmpty));
        assert_eq!(route_min_outs(1, &[Q64; 4], 200), Err(CoreError::RouteTooLong));
        assert_eq!(route_min_outs(u64::MAX, &[Q64 * 2], 0), Err(CoreError::MathOverflow));
        assert_eq!(RouteMinOuts { len: 0, min_outs: [0; 3] }.last(), 0);
    }

    #[test]
    fn max_hop_input_respects_impact() {
        let f = Fees { trade_fee_rate: 2_500, ..Default::default() };
        let (x, y) = (1_000_000_000u64, 5_000_000_000u64);
        let cap = max_hop_input(x, y, &f, 100).unwrap();
        let ok = crate::cpmm::swap_base_input(cap, x, y, &f).unwrap();
        assert!(crate::cpmm::within_price_impact(x, y, &ok, 100));
        let over = crate::cpmm::swap_base_input(cap + 1, x, y, &f).unwrap();
        assert!(!crate::cpmm::within_price_impact(x, y, &over, 100));
        assert_eq!(max_hop_input(0, y, &f, 100), Err(CoreError::InvalidReserves));
    }

    // ------------------------------------------------------------- accounting

    #[test]
    fn conversion_credits_received_not_quoted() {
        let mut l = ModeBLedger { holders_unpaid_paired: 1_000, ..Default::default() };
        // Quote said 500; a 1 % transfer fee delivered 495.
        assert_eq!(l.record_conversion(600, 10_000, 10_495), Ok(495));
        assert_eq!(
            l,
            ModeBLedger {
                holders_unpaid_paired: 400,
                holders_unpaid_parent: 495,
                total_converted_paired: 600,
                total_parent_bought: 495,
                total_parent_paid: 0
            }
        );
        assert_eq!(l.record_payout(400), Ok(()));
        assert_eq!(l.holders_unpaid_parent, 95);
        assert_eq!(l.total_parent_paid, 400);
    }

    #[test]
    fn conversion_and_payout_errors_leave_ledger_untouched() {
        let start = ModeBLedger { holders_unpaid_paired: 100, holders_unpaid_parent: 50, ..Default::default() };
        let mut l = start;
        assert_eq!(l.record_conversion(0, 0, 0), Err(CoreError::InvalidParams));
        assert_eq!(l.record_conversion(101, 0, 10), Err(CoreError::ExceedsUnpaid));
        assert_eq!(l.record_conversion(10, 10, 9), Err(CoreError::MathOverflow));
        assert_eq!(l.record_payout(51), Err(CoreError::ExceedsUnpaid));
        let mut full = ModeBLedger { holders_unpaid_paired: 1, holders_unpaid_parent: u64::MAX, ..Default::default() };
        assert_eq!(full.record_conversion(1, 0, 1), Err(CoreError::MathOverflow));
        assert_eq!(l, start);
    }

    #[test]
    fn exact_payout_empties_unpaid() {
        let mut l = ModeBLedger { holders_unpaid_parent: 7, ..Default::default() };
        assert_eq!(l.record_payout(7), Ok(()));
        assert_eq!(l.holders_unpaid_parent, 0);
        assert_eq!(l.record_payout(0), Ok(()));
    }

    #[test]
    fn solvency_check() {
        assert_eq!(parent_vault_solvent(100, &[40, 60]), Ok(true));
        assert_eq!(parent_vault_solvent(99, &[40, 60]), Ok(false));
        assert_eq!(parent_vault_solvent(0, &[]), Ok(true));
        assert_eq!(parent_vault_solvent(u64::MAX, &[u64::MAX, 1]), Err(CoreError::MathOverflow));
    }

    #[test]
    fn received_amount_bounds() {
        assert_eq!(received_amount(5, 5), Ok(0));
        assert_eq!(received_amount(0, u64::MAX), Ok(u64::MAX));
        assert_eq!(received_amount(6, 5), Err(CoreError::MathOverflow));
    }

    // -------------------------------------------------------------- economics

    #[test]
    fn spec_examples_daily_demand() {
        // §7: $200 000 × 0.75 % × 17.5 % = $262.50/day, and $350/day at 1 %.
        assert_eq!(daily_parent_demand(200_000 * MICRO_USD, 75, 1_750), Ok(262_500_000));
        assert_eq!(daily_parent_demand(200_000 * MICRO_USD, 100, 1_750), Ok(350 * MICRO_USD));
    }

    #[test]
    fn daily_demand_rounding_and_bounds() {
        assert_eq!(daily_parent_demand(1, 100, 1_750), Ok(0));
        assert_eq!(daily_parent_demand(u64::MAX, 10_000, 10_000), Ok(u64::MAX));
        assert_eq!(daily_parent_demand(1, 10_001, 0), Err(CoreError::InvalidParams));
        assert_eq!(daily_parent_demand(1, 0, 10_001), Err(CoreError::InvalidParams));
    }
}
