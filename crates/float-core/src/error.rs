//! Error type shared by every module.

/// Errors returned by `float-core`. The on-chain program maps each variant
/// onto its Anchor error codes; variants of features that have no on-chain
/// instructions yet (Phase 1 proposals) get their own codes in Phase 2.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreError {
    /// Arithmetic overflowed or underflowed.
    MathOverflow,
    /// Split shares do not sum to 10 000 bps.
    InvalidSplit,
    /// Ticker is empty, longer than 10 characters or not alphanumeric.
    InvalidTicker,
    /// A swap's output is below the price-guard minimum.
    PriceGuard,
    /// A buyback is not allowed yet (below threshold and interval not elapsed).
    BuybackNotDue,
    /// A buyback would move the price by more than the allowed impact.
    PriceImpactTooHigh,
    /// The pool reserves are empty or inconsistent.
    InvalidReserves,
    /// A merkle proof does not verify against the root.
    InvalidProof,
    /// Account data is too short or carries the wrong discriminator.
    InvalidAccountData,
    /// Parameters are outside their allowed range.
    InvalidParams,
    /// Family parent is not a Float coin (not launched on Float's platform config / not registered).
    ParentNotFloatCoin,
    /// Family parent has not graduated from its bonding curve.
    ParentNotGraduated,
    /// Family parent graduated less than `parent_min_age` ago.
    ParentTooYoung,
    /// Family parent's CPMM pool holds less than `parent_min_pool_usd` on the paired side.
    ParentPoolTooThin,
    /// Family parent's paired asset is paused by its issuer.
    ParentPaused,
    /// The child would be deeper than `max_depth`.
    FamilyTooDeep,
    /// The lineage contains a cycle (a coin would be its own ancestor).
    FamilyCycle,
    /// Family mode does not match the pairing (Mode A needs `paired_mint == parent`, Mode B the opposite).
    FamilyModeMismatch,
    /// A conversion route has no hops.
    RouteEmpty,
    /// A conversion route has more than `MAX_ROUTE_HOPS` hops.
    RouteTooLong,
    /// Route mints are not contiguous, do not start/end at the expected mints, or revisit a mint.
    RouteBroken,
    /// A pool appears in more than one hop of a route.
    RoutePoolReused,
    /// A route hop uses a pool that is not pinned.
    RoutePoolNotPinned,
    /// Amount exceeds the unpaid holder rewards it is drawn from.
    ExceedsUnpaid,
}

impl core::fmt::Display for CoreError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let s = match self {
            Self::MathOverflow => "math overflow",
            Self::InvalidSplit => "split must sum to 10000 bps",
            Self::InvalidTicker => "ticker must be 1-10 ASCII letters or digits",
            Self::PriceGuard => "output below price-guard minimum",
            Self::BuybackNotDue => "buyback not due yet",
            Self::PriceImpactTooHigh => "price impact above limit",
            Self::InvalidReserves => "invalid pool reserves",
            Self::InvalidProof => "invalid merkle proof",
            Self::InvalidAccountData => "invalid account data",
            Self::InvalidParams => "parameters out of range",
            Self::ParentNotFloatCoin => "parent is not a Float coin",
            Self::ParentNotGraduated => "parent has not graduated",
            Self::ParentTooYoung => "parent graduated too recently",
            Self::ParentPoolTooThin => "parent pool liquidity below minimum",
            Self::ParentPaused => "parent paired asset is paused",
            Self::FamilyTooDeep => "family depth above maximum",
            Self::FamilyCycle => "family lineage contains a cycle",
            Self::FamilyModeMismatch => "family mode does not match the pairing",
            Self::RouteEmpty => "route has no hops",
            Self::RouteTooLong => "route has too many hops",
            Self::RouteBroken => "route mints are not contiguous",
            Self::RoutePoolReused => "route reuses a pool",
            Self::RoutePoolNotPinned => "route uses a pool that is not pinned",
            Self::ExceedsUnpaid => "amount exceeds unpaid holder rewards",
        };
        f.write_str(s)
    }
}

/// Result alias.
pub type Result<T> = core::result::Result<T, CoreError>;
