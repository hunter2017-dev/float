//! Fair Launch Lobby: batched, same-price launches.
//!
//! Spec: `docs/proposals/fair-launch-lobby.md`. Deposits are collected
//! before the coin exists; one instruction creates the coin and spends
//! `R = min(D, max_raise)` in a single LaunchLab `buy_exact_in`, and every
//! depositor gets a pro-rata share of the `B` tokens and a refund of the
//! unfilled part.
//!
//! | Item | Spec | What it decides |
//! | --- | --- | --- |
//! | [`LobbyParams::validate`] | §5 | Parameter bounds |
//! | [`Timing`], [`phase_at`], [`check_action`] | §4 | Lifecycle and what each phase allows |
//! | [`LobbyTotals`] | §5, §8 | Running totals kept at deposit time |
//! | [`quote_buy_exact_in`] | §6.1 | Exact LaunchLab buy quote |
//! | [`net_quote_for`], [`gross_for`], [`cap_for_supply_bps`] | §6.1 | `max_raise` / `wallet_cap` with the binding rule |
//! | [`claim_amounts`], [`fee_share`] | §6.2 | Lazy per-wallet refund and tokens |
//! | [`claimable`] | §6.3 | Linear unlock |
//!
//! Fee rates are in 1e-6 units ([`FEE_RATE_DENOMINATOR`]), as in LaunchLab.

use crate::error::{CoreError, Result};
use crate::{BPS, FEE_RATE_DENOMINATOR};

/// Hard ceiling for `max_supply_bps` (20 % of supply).
pub const MAX_LOBBY_SUPPLY_BPS: u16 = 2_000;
/// Default lobby duration (`end_at − open_at`).
pub const DEFAULT_DURATION_SECS: u32 = 600;
/// Default lock window (no withdrawals during the last minute).
pub const DEFAULT_LOCK_WINDOW_SECS: u32 = 60;
/// Default time after `end_at` to finalize before anyone can cancel.
pub const DEFAULT_FINALIZE_GRACE_SECS: u32 = 600;
/// Default quorum in distinct depositors.
pub const DEFAULT_MIN_WALLETS: u32 = 10;
/// Default aggregate cap: 15 % of supply.
pub const DEFAULT_MAX_SUPPLY_BPS: u16 = 1_500;
/// Default per-wallet cap: 1 % of supply.
pub const DEFAULT_WALLET_SUPPLY_BPS: u16 = 100;

const D: u128 = FEE_RATE_DENOMINATOR as u128;

/// Lobby parameters (§5). `min_raise` has no default: the launcher sets it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LobbyParams {
    /// `end_at − open_at`, 120 – 3 600 s.
    pub duration_secs: u32,
    /// Withdrawals are disabled for the last `lock_window_secs`, 0 – `duration_secs / 2`.
    pub lock_window_secs: u32,
    /// Time after `end_at` to finalize, 60 – 3 600 s.
    pub finalize_grace_secs: u32,
    /// Quorum in paired-token units, > 0.
    pub min_raise: u64,
    /// Quorum in distinct depositors, 1 – 1 000.
    pub min_wallets: u32,
    /// Aggregate cap as a share of supply, 1 – [`MAX_LOBBY_SUPPLY_BPS`].
    pub max_supply_bps: u16,
    /// Per-wallet cap as a share of supply, 1 – `max_supply_bps`.
    pub wallet_supply_bps: u16,
    /// Optional linear unlock after finalize, 0 – 3 600 s.
    pub unlock_secs: u32,
}

impl LobbyParams {
    /// Spec defaults with the launcher's `min_raise`.
    pub const fn with_defaults(min_raise: u64) -> Self {
        Self {
            duration_secs: DEFAULT_DURATION_SECS,
            lock_window_secs: DEFAULT_LOCK_WINDOW_SECS,
            finalize_grace_secs: DEFAULT_FINALIZE_GRACE_SECS,
            min_raise,
            min_wallets: DEFAULT_MIN_WALLETS,
            max_supply_bps: DEFAULT_MAX_SUPPLY_BPS,
            wallet_supply_bps: DEFAULT_WALLET_SUPPLY_BPS,
            unlock_secs: 0,
        }
    }

    /// Fails with [`CoreError::InvalidParams`] unless every §5 bound holds.
    ///
    /// Both supply shares must be at least 1 bps (§5).
    pub fn validate(&self) -> Result<()> {
        let ok = (120..=3_600).contains(&self.duration_secs)
            && self.lock_window_secs <= self.duration_secs / 2
            && (60..=3_600).contains(&self.finalize_grace_secs)
            && self.min_raise > 0
            && (1..=1_000).contains(&self.min_wallets)
            && (1..=MAX_LOBBY_SUPPLY_BPS).contains(&self.max_supply_bps)
            && (1..=self.max_supply_bps).contains(&self.wallet_supply_bps)
            && self.unlock_secs <= 3_600;
        if ok {
            Ok(())
        } else {
            Err(CoreError::InvalidParams)
        }
    }
}

// ----------------------------------------------------------------- lifecycle

/// Lobby timestamps (unix seconds).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timing {
    /// Deposits open.
    pub open_at: i64,
    /// Withdrawals close (`end_at − lock_window_secs`).
    pub lock_at: i64,
    /// Deposits close; finalize may run.
    pub end_at: i64,
    /// Last moment to finalize (`end_at + finalize_grace_secs`).
    pub finalize_deadline: i64,
}

impl Timing {
    /// Timestamps of a lobby opening at `open_at` with validated `params`.
    pub fn new(open_at: i64, params: &LobbyParams) -> Result<Self> {
        params.validate()?;
        let end_at = open_at.checked_add(params.duration_secs as i64).ok_or(CoreError::MathOverflow)?;
        let lock_at = end_at - params.lock_window_secs as i64;
        let finalize_deadline = end_at.checked_add(params.finalize_grace_secs as i64).ok_or(CoreError::MathOverflow)?;
        Ok(Self { open_at, lock_at, end_at, finalize_deadline })
    }
}

/// Stored lobby state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LobbyState {
    /// Not finalized or cancelled yet.
    Open,
    /// `finalize` ran.
    Finalized,
    /// `cancel` ran.
    Cancelled,
}

/// Phase at a given time (§4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Before `open_at`.
    Pending,
    /// `open_at` ≤ now < `lock_at`: deposit, withdraw, launcher cancel.
    Open,
    /// `lock_at` ≤ now < `end_at`: deposit only.
    Locked,
    /// `end_at` ≤ now ≤ `finalize_deadline` with quorum met: finalize.
    Finalizable,
    /// After `end_at` without quorum, or after the deadline: anyone may cancel.
    Expired,
    /// After `finalize`: claim.
    Finalized,
    /// After `cancel`: refund.
    Cancelled,
}

/// Phase of a lobby at `now`.
pub fn phase_at(t: &Timing, state: LobbyState, quorum_met: bool, now: i64) -> Phase {
    match state {
        LobbyState::Finalized => Phase::Finalized,
        LobbyState::Cancelled => Phase::Cancelled,
        LobbyState::Open if now < t.open_at => Phase::Pending,
        LobbyState::Open if now < t.lock_at => Phase::Open,
        LobbyState::Open if now < t.end_at => Phase::Locked,
        LobbyState::Open if now <= t.finalize_deadline && quorum_met => Phase::Finalizable,
        LobbyState::Open => Phase::Expired,
    }
}

/// Quorum (§5): `D ≥ min_raise` and `depositors ≥ min_wallets`.
pub fn quorum_met(total_deposits: u64, depositors: u32, params: &LobbyParams) -> bool {
    total_deposits >= params.min_raise && depositors >= params.min_wallets
}

/// Lobby instructions whose availability depends on the phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// `deposit`.
    Deposit,
    /// `withdraw`.
    Withdraw,
    /// `finalize`.
    Finalize,
    /// `cancel`.
    Cancel,
    /// `claim`.
    Claim,
    /// `refund`.
    Refund,
}

/// Fails with [`CoreError::LobbyWrongPhase`] unless `action` is allowed in
/// `phase` (§4, §8). Cancel is allowed to the launcher before `lock_at` and
/// to anyone once the lobby has expired.
pub fn check_action(phase: Phase, action: Action, is_launcher: bool) -> Result<()> {
    let ok = match action {
        Action::Deposit => matches!(phase, Phase::Open | Phase::Locked),
        Action::Withdraw => phase == Phase::Open,
        Action::Finalize => phase == Phase::Finalizable,
        Action::Cancel => matches!(phase, Phase::Expired) || (is_launcher && matches!(phase, Phase::Pending | Phase::Open)),
        Action::Claim => phase == Phase::Finalized,
        Action::Refund => phase == Phase::Cancelled,
    };
    if ok {
        Ok(())
    } else {
        Err(CoreError::LobbyWrongPhase)
    }
}

/// Running totals kept at deposit time (§5): the program can never sum
/// per-wallet values at finalize.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LobbyTotals {
    /// `D`: sum of all current deposits.
    pub total_deposits: u64,
    /// Wallets with a non-zero deposit.
    pub depositors: u32,
}

impl LobbyTotals {
    /// Adds `amount` to a wallet whose deposit is `wallet_deposit`; returns
    /// the wallet's new deposit. Fails with [`CoreError::InvalidParams`] for
    /// 0 and [`CoreError::WalletCapExceeded`] above `wallet_cap`.
    pub fn deposit(&mut self, wallet_deposit: u64, amount: u64, wallet_cap: u64) -> Result<u64> {
        if amount == 0 {
            return Err(CoreError::InvalidParams);
        }
        let new = wallet_deposit.checked_add(amount).ok_or(CoreError::WalletCapExceeded)?;
        if new > wallet_cap {
            return Err(CoreError::WalletCapExceeded);
        }
        let total = self.total_deposits.checked_add(amount).ok_or(CoreError::MathOverflow)?;
        let depositors = if wallet_deposit == 0 { self.depositors.checked_add(1).ok_or(CoreError::MathOverflow)? } else { self.depositors };
        self.total_deposits = total;
        self.depositors = depositors;
        Ok(new)
    }

    /// Removes `amount` from a wallet's deposit; returns the new deposit.
    /// Fails with [`CoreError::InvalidParams`] for 0 and
    /// [`CoreError::InsufficientDeposit`] above the wallet's deposit.
    ///
    /// A wallet that withdraws everything stops counting as a depositor (§8),
    /// so depositing and withdrawing cannot inflate the `min_wallets` quorum.
    pub fn withdraw(&mut self, wallet_deposit: u64, amount: u64) -> Result<u64> {
        if amount == 0 {
            return Err(CoreError::InvalidParams);
        }
        let new = wallet_deposit.checked_sub(amount).ok_or(CoreError::InsufficientDeposit)?;
        let total = self.total_deposits.checked_sub(amount).ok_or(CoreError::MathOverflow)?;
        let depositors = if new == 0 { self.depositors.checked_sub(1).ok_or(CoreError::MathOverflow)? } else { self.depositors };
        self.total_deposits = total;
        self.depositors = depositors;
        Ok(new)
    }
}

// --------------------------------------------------------------- curve math

/// LaunchLab constant-product curve state (`PoolState` fields).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CurveState {
    /// `virtual_base`.
    pub virtual_base: u64,
    /// `virtual_quote`.
    pub virtual_quote: u64,
    /// `real_base`: coins sold so far.
    pub real_base: u64,
    /// `real_quote`: quote raised so far.
    pub real_quote: u64,
    /// `total_base_sell`: coins the curve sells before graduating.
    pub total_base_sell: u64,
}

impl CurveState {
    /// A fresh pool: no real reserves yet.
    pub const fn genesis(virtual_base: u64, virtual_quote: u64, total_base_sell: u64) -> Self {
        Self { virtual_base, virtual_quote, real_base: 0, real_quote: 0, total_base_sell }
    }

    /// Reserves the curve trades against: `(vb − real_base, vq + real_quote)`.
    pub fn reserves(&self) -> Result<(u64, u64)> {
        let base = self.virtual_base.checked_sub(self.real_base).ok_or(CoreError::InvalidReserves)?;
        let quote = self.virtual_quote.checked_add(self.real_quote).ok_or(CoreError::MathOverflow)?;
        if base == 0 || quote == 0 {
            return Err(CoreError::InvalidReserves);
        }
        Ok((base, quote))
    }

    /// Coins left on the curve.
    pub fn remaining(&self) -> Result<u64> {
        self.total_base_sell.checked_sub(self.real_base).ok_or(CoreError::InvalidReserves)
    }
}

/// Result of a `buy_exact_in` quote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuyQuote {
    /// Quote actually spent (less than the input when the buy completes the curve).
    pub amount_in: u64,
    /// Coins received.
    pub amount_out: u64,
    /// Total LaunchLab fee.
    pub fee: u64,
    /// True if the buy was capped by the coins left on the curve.
    pub capped: bool,
}

fn to_u64(v: u128) -> Result<u64> {
    u64::try_from(v).map_err(|_| CoreError::MathOverflow)
}

fn check_fee_rate(fee_rate: u64) -> Result<()> {
    if fee_rate >= FEE_RATE_DENOMINATOR {
        return Err(CoreError::InvalidParams);
    }
    Ok(())
}

/// Smallest gross amount whose fee-deducted value is ≥ `net`
/// (port of the SDK's `preFeeAmount`).
pub fn pre_fee_amount(net: u64, fee_rate: u64) -> Result<u64> {
    check_fee_rate(fee_rate)?;
    if fee_rate == 0 {
        return Ok(net);
    }
    let den = D - fee_rate as u128;
    to_u64((net as u128 * D).div_ceil(den))
}

/// Port of the SDK's `launchLab.quoteBuyExactIn` for a constant-product
/// curve: the fee `ceil(amount_in · fee_rate / 1e6)` comes off the input,
/// the rest buys `floor(net · base / (quote + net))` coins, capped at the
/// coins left on the curve (then the input is reduced to what that costs).
///
/// Interpretation: LaunchLab's program source is not public; this mirrors
/// the SDK model of it (one combined fee rate, rounded up).
pub fn quote_buy_exact_in(state: &CurveState, amount_in: u64, fee_rate: u64) -> Result<BuyQuote> {
    check_fee_rate(fee_rate)?;
    let (base, quote) = state.reserves()?;
    let fee = to_u64((amount_in as u128 * fee_rate as u128).div_ceil(D))?;
    let net = (amount_in - fee) as u128; // fee <= amount_in because fee_rate < 1e6
    let mut out = if net == 0 { 0 } else { to_u64(net * base as u128 / (quote as u128 + net))? };
    let remaining = state.remaining()?;
    if out <= remaining {
        return Ok(BuyQuote { amount_in, amount_out: out, fee, capped: false });
    }
    out = remaining;
    let net_in = cp_amount_in(out, quote, base)?;
    let real_in = pre_fee_amount(net_in, fee_rate)?;
    Ok(BuyQuote { amount_in: real_in, amount_out: out, fee: real_in - net_in, capped: true })
}

/// `ceil(reserve_in · out / (reserve_out − out))`, the SDK's `cpAmountIn`.
fn cp_amount_in(out: u64, reserve_in: u64, reserve_out: u64) -> Result<u64> {
    if out == 0 {
        return Ok(0);
    }
    if out >= reserve_out {
        return Err(CoreError::InvalidReserves);
    }
    let num = reserve_in as u128 * out as u128;
    to_u64(num.div_ceil((reserve_out - out) as u128))
}

/// `net(s) = ceil(vq · s / (vb − s))`: net quote needed to receive `s` coins (§6.1).
pub fn net_quote_for(state: &CurveState, coins: u64) -> Result<u64> {
    let (base, quote) = state.reserves()?;
    cp_amount_in(coins, quote, base)
}

/// `gross(s) = preFeeAmount(net(s), fee_rate)`: the closed form of §6.1.
pub fn gross_for(state: &CurveState, coins: u64, fee_rate: u64) -> Result<u64> {
    pre_fee_amount(net_quote_for(state, coins)?, fee_rate)
}

/// Coins equal to `bps` of `supply` (floored).
pub fn supply_share(supply: u64, bps: u16) -> u64 {
    // Saturates for bps > 10 000, which validated params never reach.
    (supply as u128 * bps as u128 / BPS as u128).min(u64::MAX as u128) as u64
}

/// `max_raise` / `wallet_cap` (§6.1): the **largest** gross amount whose
/// exact buy quote returns at most `bps` of `supply`.
///
/// Starts from the closed form (the cap lies in
/// `[gross(target) − 1, gross(target + 1) − 1]`) and binary-searches that
/// range with [`quote_buy_exact_in`], so fee rounding can never push the
/// bought amount above the share. Fails with [`CoreError::InvalidParams`] if
/// the share is not below the coins left on the curve (the cap would not bind).
pub fn cap_for_supply_bps(state: &CurveState, supply: u64, bps: u16, fee_rate: u64) -> Result<u64> {
    check_fee_rate(fee_rate)?;
    let target = supply_share(supply, bps);
    if target >= state.remaining()? {
        return Err(CoreError::InvalidParams);
    }
    let out = |g: u64| quote_buy_exact_in(state, g, fee_rate).map(|q| q.amount_out);
    // gross(t) is the smallest input that buys >= t coins, so gross(target+1) - 1
    // buys <= target and gross(target) - 1 buys < target.
    let mut lo = gross_for(state, target, fee_rate)?.saturating_sub(1);
    let mut hi = gross_for(state, target + 1, fee_rate)?.checked_sub(1).ok_or(CoreError::MathOverflow)?;
    if out(lo)? > target {
        return Err(CoreError::MathOverflow); // unreachable if the closed form holds
    }
    while lo < hi {
        let mid = lo + (hi - lo).div_ceil(2);
        if out(mid)? <= target {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    Ok(lo)
}

/// `max_raise` and `wallet_cap` of a lobby (§6.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caps {
    /// Aggregate cap on the quote the lobby spends.
    pub max_raise: u64,
    /// Per-wallet deposit cap.
    pub wallet_cap: u64,
}

/// Both caps from `max_supply_bps` and `wallet_supply_bps`.
pub fn caps(state: &CurveState, supply: u64, params: &LobbyParams, fee_rate: u64) -> Result<Caps> {
    params.validate()?;
    Ok(Caps {
        max_raise: cap_for_supply_bps(state, supply, params.max_supply_bps, fee_rate)?,
        wallet_cap: cap_for_supply_bps(state, supply, params.wallet_supply_bps, fee_rate)?,
    })
}

// --------------------------------------------------------------- allocation

/// `R = min(D, max_raise)`: what the lobby spends.
pub fn raise_spent(total_deposits: u64, max_raise: u64) -> u64 {
    total_deposits.min(max_raise)
}

/// One wallet's settlement (§6.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Allocation {
    /// `floor(d · (D − R) / D)`: unfilled part returned.
    pub refund: u64,
    /// `d − refund`.
    pub spent: u64,
    /// `floor(B · d / D)`.
    pub tokens: u64,
}

/// Per-wallet refund and tokens from the wallet's deposit `d` and the stored
/// totals `D`, `R`, `B` (§6.2). Flooring keeps `Σ refund ≤ D − R` and
/// `Σ tokens ≤ B`. Fails with [`CoreError::InvalidParams`] unless
/// `0 < D`, `d ≤ D` and `R ≤ D`.
pub fn claim_amounts(deposit: u64, total_deposits: u64, raise_spent: u64, tokens_bought: u64) -> Result<Allocation> {
    if total_deposits == 0 || deposit > total_deposits || raise_spent > total_deposits {
        return Err(CoreError::InvalidParams);
    }
    let d = deposit as u128;
    let total = total_deposits as u128;
    let refund = (d * (total - raise_spent as u128) / total) as u64; // <= d
    let tokens = (tokens_bought as u128 * d / total) as u64; // <= B
    Ok(Allocation { refund, spent: deposit - refund, tokens })
}

/// A wallet's pro-rata share of the LaunchLab fee paid by the lobby buy,
/// `floor(fee · d / D)`, for `LobbyClaimed.fee_share` (§10).
///
/// Weighted by deposit like `tokens` (§10), so shares sum to at most the fee.
pub fn fee_share(fee_total: u64, deposit: u64, total_deposits: u64) -> Result<u64> {
    if total_deposits == 0 || deposit > total_deposits {
        return Err(CoreError::InvalidParams);
    }
    Ok((fee_total as u128 * deposit as u128 / total_deposits as u128) as u64)
}

/// Tokens claimable at `now` (§6.3):
/// `floor(tokens · min(now − finalized_at, u) / u) − already_claimed`, or
/// everything not yet claimed when `unlock_secs == 0`. Before `finalized_at`
/// nothing is unlocked. Fails with [`CoreError::MathOverflow`] if
/// `already_claimed` exceeds what is unlocked.
pub fn claimable(tokens: u64, finalized_at: i64, now: i64, unlock_secs: u32, already_claimed: u64) -> Result<u64> {
    let unlocked = if unlock_secs == 0 {
        tokens
    } else {
        let elapsed = now.saturating_sub(finalized_at).clamp(0, unlock_secs as i64) as u128;
        (tokens as u128 * elapsed / unlock_secs as u128) as u64
    };
    unlocked.checked_sub(already_claimed).ok_or(CoreError::MathOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real LaunchLab default curve (same pool as the SDK and CLI tests).
    const VB: u64 = 1_073_025_605_596_382;
    const VQ: u64 = 30_000_852_951;
    const SELL: u64 = 793_100_000_000_000;
    const SUPPLY: u64 = 1_000_000_000_000_000;
    const FEE_1PCT: u64 = 10_000;

    fn genesis() -> CurveState {
        CurveState::genesis(VB, VQ, SELL)
    }

    // ----------------------------------------------------------- params

    #[test]
    fn defaults_are_valid_and_match_spec() {
        let p = LobbyParams::with_defaults(1);
        assert_eq!((p.duration_secs, p.lock_window_secs, p.finalize_grace_secs), (600, 60, 600));
        assert_eq!((p.min_wallets, p.max_supply_bps, p.wallet_supply_bps, p.unlock_secs), (10, 1_500, 100, 0));
        assert_eq!(p.validate(), Ok(()));
    }

    #[test]
    fn every_bound_is_enforced() {
        let ok = LobbyParams::with_defaults(1);
        let bad = [
            LobbyParams { duration_secs: 119, ..ok },
            LobbyParams { duration_secs: 3_601, ..ok },
            LobbyParams { lock_window_secs: 301, ..ok },
            LobbyParams { finalize_grace_secs: 59, ..ok },
            LobbyParams { finalize_grace_secs: 3_601, ..ok },
            LobbyParams { min_raise: 0, ..ok },
            LobbyParams { min_wallets: 0, ..ok },
            LobbyParams { min_wallets: 1_001, ..ok },
            LobbyParams { max_supply_bps: 0, ..ok },
            LobbyParams { max_supply_bps: 2_001, ..ok },
            LobbyParams { wallet_supply_bps: 0, ..ok },
            LobbyParams { max_supply_bps: 100, wallet_supply_bps: 101, ..ok },
            LobbyParams { unlock_secs: 3_601, ..ok },
        ];
        for p in bad {
            assert_eq!(p.validate(), Err(CoreError::InvalidParams), "{p:?}");
        }
        let edges = [
            LobbyParams { duration_secs: 120, lock_window_secs: 60, ..ok },
            LobbyParams { duration_secs: 3_600, lock_window_secs: 0, ..ok },
            LobbyParams { finalize_grace_secs: 60, ..ok },
            LobbyParams { finalize_grace_secs: 3_600, ..ok },
            LobbyParams { min_wallets: 1, ..ok },
            LobbyParams { min_wallets: 1_000, ..ok },
            LobbyParams { max_supply_bps: 2_000, wallet_supply_bps: 2_000, ..ok },
            LobbyParams { unlock_secs: 3_600, ..ok },
        ];
        for p in edges {
            assert_eq!(p.validate(), Ok(()), "{p:?}");
        }
    }

    // -------------------------------------------------------- lifecycle

    #[test]
    fn phases_follow_the_lifecycle() {
        let t = Timing::new(1_000, &LobbyParams::with_defaults(1)).unwrap();
        assert_eq!(t, Timing { open_at: 1_000, lock_at: 1_540, end_at: 1_600, finalize_deadline: 2_200 });
        let p = |now, q| phase_at(&t, LobbyState::Open, q, now);
        assert_eq!(p(999, true), Phase::Pending);
        assert_eq!(p(1_000, false), Phase::Open);
        assert_eq!(p(1_539, false), Phase::Open);
        assert_eq!(p(1_540, false), Phase::Locked);
        assert_eq!(p(1_599, false), Phase::Locked);
        assert_eq!(p(1_600, true), Phase::Finalizable);
        assert_eq!(p(2_200, true), Phase::Finalizable);
        assert_eq!(p(2_201, true), Phase::Expired);
        assert_eq!(p(1_600, false), Phase::Expired);
        assert_eq!(phase_at(&t, LobbyState::Finalized, false, 0), Phase::Finalized);
        assert_eq!(phase_at(&t, LobbyState::Cancelled, true, 1_700), Phase::Cancelled);
    }

    #[test]
    fn zero_lock_window_skips_locked() {
        let t = Timing::new(0, &LobbyParams { lock_window_secs: 0, ..LobbyParams::with_defaults(1) }).unwrap();
        assert_eq!(phase_at(&t, LobbyState::Open, false, 599), Phase::Open);
        assert_eq!(phase_at(&t, LobbyState::Open, true, 600), Phase::Finalizable);
    }

    #[test]
    fn timing_overflow_and_invalid_params() {
        assert_eq!(Timing::new(i64::MAX - 10, &LobbyParams::with_defaults(1)), Err(CoreError::MathOverflow));
        assert_eq!(Timing::new(0, &LobbyParams::with_defaults(0)), Err(CoreError::InvalidParams));
    }

    #[test]
    fn actions_per_phase() {
        use Action::*;
        let allowed = |ph: Phase, a: Action, l: bool| check_action(ph, a, l).is_ok();
        assert!(allowed(Phase::Open, Deposit, false) && allowed(Phase::Locked, Deposit, false));
        assert!(!allowed(Phase::Pending, Deposit, false) && !allowed(Phase::Finalizable, Deposit, false));
        assert!(allowed(Phase::Open, Withdraw, false) && !allowed(Phase::Locked, Withdraw, false));
        assert!(allowed(Phase::Finalizable, Finalize, false) && !allowed(Phase::Expired, Finalize, false));
        assert!(allowed(Phase::Open, Cancel, true) && allowed(Phase::Pending, Cancel, true));
        assert!(!allowed(Phase::Open, Cancel, false) && !allowed(Phase::Locked, Cancel, true));
        assert!(allowed(Phase::Expired, Cancel, false) && !allowed(Phase::Finalizable, Cancel, true));
        assert!(allowed(Phase::Finalized, Claim, false) && !allowed(Phase::Cancelled, Claim, false));
        assert!(allowed(Phase::Cancelled, Refund, false) && !allowed(Phase::Finalized, Refund, false));
        assert_eq!(check_action(Phase::Locked, Withdraw, true), Err(CoreError::LobbyWrongPhase));
    }

    #[test]
    fn quorum() {
        let p = LobbyParams { min_wallets: 3, ..LobbyParams::with_defaults(100) };
        assert!(quorum_met(100, 3, &p));
        assert!(!quorum_met(99, 3, &p));
        assert!(!quorum_met(100, 2, &p));
    }

    #[test]
    fn running_totals() {
        let mut t = LobbyTotals::default();
        assert_eq!(t.deposit(0, 30, 40), Ok(30));
        assert_eq!(t.deposit(30, 10, 40), Ok(40));
        assert_eq!(t.deposit(40, 1, 40), Err(CoreError::WalletCapExceeded));
        assert_eq!(t.deposit(0, 20, 40), Ok(20));
        assert_eq!(t, LobbyTotals { total_deposits: 60, depositors: 2 });
        assert_eq!(t.withdraw(20, 21), Err(CoreError::InsufficientDeposit));
        assert_eq!(t.withdraw(20, 20), Ok(0));
        assert_eq!(t, LobbyTotals { total_deposits: 40, depositors: 1 });
        assert_eq!(t.deposit(0, 0, 40), Err(CoreError::InvalidParams));
        assert_eq!(t.withdraw(40, 0), Err(CoreError::InvalidParams));
        assert_eq!(t.deposit(u64::MAX, 1, u64::MAX), Err(CoreError::WalletCapExceeded));
        assert_eq!(t, LobbyTotals { total_deposits: 40, depositors: 1 });
    }

    // ------------------------------------------------------- curve & caps

    #[test]
    fn quote_matches_sdk_vector() {
        // Same numbers as packages/cli/test/cli.test.ts "quote buy": 1 SOL, 1 % fee.
        let q = quote_buy_exact_in(&genesis(), 1_000_000_000, FEE_1PCT).unwrap();
        assert_eq!(q.fee, 10_000_000);
        let net = 990_000_000u128;
        assert_eq!(q.amount_out as u128, net * VB as u128 / (VQ as u128 + net));
        assert!(!q.capped);
    }

    #[test]
    fn quote_caps_at_remaining_curve() {
        let s = CurveState { real_base: SELL - 1_000, ..genesis() };
        let q = quote_buy_exact_in(&s, u64::MAX / 4, FEE_1PCT).unwrap();
        assert!(q.capped);
        assert_eq!(q.amount_out, 1_000);
        // The reduced input buys exactly the remainder.
        assert_eq!(quote_buy_exact_in(&s, q.amount_in, FEE_1PCT).unwrap().amount_out, 1_000);
        assert!(quote_buy_exact_in(&s, q.amount_in - 1, FEE_1PCT).unwrap().amount_out <= 1_000);
    }

    #[test]
    fn quote_errors() {
        assert_eq!(quote_buy_exact_in(&genesis(), 1, FEE_RATE_DENOMINATOR), Err(CoreError::InvalidParams));
        assert_eq!(quote_buy_exact_in(&CurveState::genesis(0, 1, 0), 1, 0), Err(CoreError::InvalidReserves));
        assert_eq!(quote_buy_exact_in(&genesis(), 0, FEE_1PCT).unwrap().amount_out, 0);
        assert_eq!(net_quote_for(&genesis(), VB), Err(CoreError::InvalidReserves));
        assert_eq!(pre_fee_amount(u64::MAX, 500_000), Err(CoreError::MathOverflow));
    }

    #[test]
    fn pre_fee_is_the_smallest_gross() {
        for (net, rate) in [(990_000_000u64, 10_000u64), (1, 10_000), (12_345, 2_500), (7, 999_999), (5, 0)] {
            let g = pre_fee_amount(net, rate).unwrap();
            let after = |x: u64| x - (x as u128 * rate as u128).div_ceil(D) as u64;
            assert!(after(g) >= net);
            if g > 0 {
                assert!(after(g - 1) < net);
            }
        }
    }

    #[test]
    fn caps_are_tight_with_default_curve() {
        let p = LobbyParams::with_defaults(1);
        let c = caps(&genesis(), SUPPLY, &p, FEE_1PCT).unwrap();
        for (cap, bps) in [(c.max_raise, 1_500u16), (c.wallet_cap, 100)] {
            let target = supply_share(SUPPLY, bps);
            assert!(quote_buy_exact_in(&genesis(), cap, FEE_1PCT).unwrap().amount_out <= target);
            assert!(quote_buy_exact_in(&genesis(), cap + 1, FEE_1PCT).unwrap().amount_out > target);
        }
        // ≈ 4.92 SOL buys 15 % of this curve and ≈ 0.285 SOL buys 1 % (1 % fee included).
        assert!(c.max_raise > 4_900_000_000 && c.max_raise < 4_950_000_000, "{}", c.max_raise);
        assert!(c.wallet_cap > 284_000_000 && c.wallet_cap < 286_000_000, "{}", c.wallet_cap);
    }

    #[test]
    fn cap_binding_rule_when_one_coin_costs_many_quote_units() {
        // Tiny base reserve: each coin costs ~1 000 quote units, so many inputs
        // buy the same amount; the cap is the largest of them.
        let s = CurveState::genesis(10_000, 10_000_000, 5_000);
        let g = cap_for_supply_bps(&s, 10_000, 1_000, FEE_1PCT).unwrap();
        assert_eq!(quote_buy_exact_in(&s, g, FEE_1PCT).unwrap().amount_out, 1_000);
        assert_eq!(quote_buy_exact_in(&s, g + 1, FEE_1PCT).unwrap().amount_out, 1_001);
        assert!(g > gross_for(&s, 1_000, FEE_1PCT).unwrap());
    }

    #[test]
    fn cap_errors() {
        // 80 % of supply is more than the curve sells.
        assert_eq!(cap_for_supply_bps(&genesis(), SUPPLY, 8_000, FEE_1PCT), Err(CoreError::InvalidParams));
        assert_eq!(cap_for_supply_bps(&genesis(), SUPPLY, 100, FEE_RATE_DENOMINATOR), Err(CoreError::InvalidParams));
        assert_eq!(caps(&genesis(), SUPPLY, &LobbyParams::with_defaults(0), FEE_1PCT), Err(CoreError::InvalidParams));
    }

    // -------------------------------------------------------- allocation

    #[test]
    fn spec_vector_40_30_20() {
        // §6.2 shared vector: D = 90, R = 60, B = 5 901.
        let (d, r, b) = (90, 60, 5_901);
        let a = [40u64, 30, 20].map(|x| claim_amounts(x, d, r, b).unwrap());
        assert_eq!(a.map(|x| x.refund), [13, 10, 6]);
        assert_eq!(a.map(|x| x.spent), [27, 20, 14]);
        assert_eq!(a.map(|x| x.tokens), [2_622, 1_967, 1_311]);
        let refunds: u64 = a.iter().map(|x| x.refund).sum();
        let tokens: u64 = a.iter().map(|x| x.tokens).sum();
        assert_eq!((d - r) - refunds, 1, "quote dust");
        assert_eq!(b - tokens, 1, "token dust");
    }

    #[test]
    fn allocation_edges() {
        assert_eq!(claim_amounts(10, 10, 10, 77), Ok(Allocation { refund: 0, spent: 10, tokens: 77 }));
        assert_eq!(claim_amounts(10, 10, 0, 0), Ok(Allocation { refund: 10, spent: 0, tokens: 0 }));
        assert_eq!(claim_amounts(u64::MAX, u64::MAX, u64::MAX / 2, u64::MAX).unwrap().tokens, u64::MAX);
        assert_eq!(claim_amounts(1, 0, 0, 0), Err(CoreError::InvalidParams));
        assert_eq!(claim_amounts(11, 10, 5, 5), Err(CoreError::InvalidParams));
        assert_eq!(claim_amounts(1, 10, 11, 5), Err(CoreError::InvalidParams));
        assert_eq!(raise_spent(90, 60), 60);
        assert_eq!(raise_spent(50, 60), 50);
        assert_eq!(fee_share(100, 1, 3), Ok(33));
        assert_eq!(fee_share(100, 4, 3), Err(CoreError::InvalidParams));
    }

    #[test]
    fn unlock_is_linear() {
        assert_eq!(claimable(1_000, 100, 50, 0, 0), Ok(1_000));
        assert_eq!(claimable(1_000, 100, 100, 600, 0), Ok(0));
        assert_eq!(claimable(1_000, 100, 50, 600, 0), Ok(0));
        assert_eq!(claimable(1_000, 100, 400, 600, 0), Ok(500));
        assert_eq!(claimable(1_000, 100, 400, 600, 200), Ok(300));
        assert_eq!(claimable(1_000, 100, 101, 600, 0), Ok(1)); // floor(1000/600)
        assert_eq!(claimable(1_000, 100, 10_000, 600, 999), Ok(1));
        assert_eq!(claimable(1_000, 100, 400, 600, 501), Err(CoreError::MathOverflow));
        assert_eq!(claimable(u64::MAX, i64::MIN, i64::MAX, 3_600, 0), Ok(u64::MAX));
    }

    // -------------------------------------------- invariants §9.3 – §9.5

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
    fn invariants_solvency_uniform_price_and_caps() {
        let mut rng = XorShift(0x9E37_79B9_7F4A_7C15);
        for round in 0..300 {
            // A curve shaped like LaunchLab's, scaled randomly.
            let scale = 1 + rng.below(1_000);
            let supply = 1_000_000_000u64 * 1_000 * scale;
            let vb = supply + supply / 14;
            let vq = 1_000_000 + rng.below(100_000_000_000);
            let sell = supply / 100 * 79;
            let state = CurveState::genesis(vb, vq, sell);
            let fee_rate = rng.below(30_000);
            let max_bps = 1 + rng.below(MAX_LOBBY_SUPPLY_BPS as u64) as u16;
            let wallet_bps = 1 + rng.below(max_bps as u64) as u16;
            let params = LobbyParams { max_supply_bps: max_bps, wallet_supply_bps: wallet_bps, ..LobbyParams::with_defaults(1) };
            let c = caps(&state, supply, &params, fee_rate).unwrap();

            // §9.5: caps bind exactly.
            for (cap, bps) in [(c.max_raise, max_bps), (c.wallet_cap, wallet_bps)] {
                let target = supply_share(supply, bps);
                assert!(quote_buy_exact_in(&state, cap, fee_rate).unwrap().amount_out <= target, "round {round}");
                assert!(quote_buy_exact_in(&state, cap + 1, fee_rate).unwrap().amount_out > target, "round {round}");
            }

            // Random deposits under the wallet cap.
            let n = 1 + rng.below(60) as usize;
            let mut totals = LobbyTotals::default();
            let mut deposits = Vec::with_capacity(n);
            for _ in 0..n {
                let d = 1 + rng.below(c.wallet_cap.max(1));
                totals.deposit(0, d, c.wallet_cap).unwrap();
                deposits.push(d);
            }
            let total = totals.total_deposits;
            let r = raise_spent(total, c.max_raise);
            let q = quote_buy_exact_in(&state, r, fee_rate).unwrap();
            let b = q.amount_out;

            // §9.5: aggregate share.
            assert!(b <= supply_share(supply, max_bps), "round {round}");

            // §9.3 solvency and §9.4 uniform price.
            let (mut refunds, mut tokens) = (0u64, 0u64);
            for &d in &deposits {
                let a = claim_amounts(d, total, r, b).unwrap();
                refunds += a.refund;
                tokens += a.tokens;
                let (d, tot) = (d as u128, total as u128);
                // spent = ceil(d·R/D) and tokens = floor(d·B/D): each within one raw
                // unit of the exact uniform-price share.
                assert!(a.spent as u128 * tot >= d * r as u128);
                assert!(a.spent == 0 || (a.spent as u128 - 1) * tot < d * r as u128);
                assert!(a.tokens as u128 * tot <= d * b as u128 && (a.tokens as u128 + 1) * tot > d * b as u128);
            }
            assert!(refunds <= total - r, "round {round}");
            assert!(tokens <= b, "round {round}");
            // Dust is below one unit per depositor.
            assert!((total - r) - refunds < n as u64 && b - tokens < n as u64);
        }
    }
}
