//! Rust ↔ TypeScript parity for the Fair Launch Lobby.
//!
//! `tests/fixtures/lobby-allocation.json` is generated from the TypeScript SDK
//! (`node scripts/dev/gen-fixtures.ts`); every case must give the same result
//! in float-core. Includes the spec's §6.2 vector (40/30/20, R = 60, B = 5 901).

mod common;

use common::{check, parse, Json};
use float_core::lobby::*;

fn vectors() -> Json {
    parse(include_str!("fixtures/lobby-allocation.json"))
}

fn params_from(p: &Json) -> LobbyParams {
    LobbyParams {
        duration_secs: p.get("durationSecs").u32(),
        lock_window_secs: p.get("lockWindowSecs").u32(),
        finalize_grace_secs: p.get("finalizeGraceSecs").u32(),
        min_raise: p.get("minRaise").u64(),
        min_wallets: p.get("minWallets").u32(),
        max_supply_bps: p.get("maxSupplyBps").u16(),
        wallet_supply_bps: p.get("walletSupplyBps").u16(),
        unlock_secs: p.get("unlockSecs").u32(),
    }
}

fn curve_from(c: &Json) -> CurveState {
    CurveState {
        virtual_base: c.get("virtualBase").u64(),
        virtual_quote: c.get("virtualQuote").u64(),
        real_base: c.get("realBase").u64(),
        real_quote: c.get("realQuote").u64(),
        total_base_sell: c.get("totalBaseSell").u64(),
    }
}

fn phase_name(p: Phase) -> String {
    format!("{p:?}")
}

fn phase_from(s: &str) -> Phase {
    match s {
        "Pending" => Phase::Pending,
        "Open" => Phase::Open,
        "Locked" => Phase::Locked,
        "Finalizable" => Phase::Finalizable,
        "Expired" => Phase::Expired,
        "Finalized" => Phase::Finalized,
        "Cancelled" => Phase::Cancelled,
        _ => panic!("unknown phase {s}"),
    }
}

#[test]
fn param_vectors() {
    let v = vectors();
    for c in v.get("params").arr() {
        check(c.get("name").str(), params_from(c.get("params")).validate(), c.get("expected"), |_, ok| assert!(ok.bool()));
    }
}

#[test]
fn timing_and_phase_vectors() {
    let v = vectors();
    let t = v.get("timing");
    let timing = Timing::new(t.get("openAt").i64(), &params_from(t.get("params"))).unwrap();
    let e = t.get("expected");
    assert_eq!(
        timing,
        Timing {
            open_at: e.get("openAt").i64(),
            lock_at: e.get("lockAt").i64(),
            end_at: e.get("endAt").i64(),
            finalize_deadline: e.get("finalizeDeadline").i64()
        }
    );
    for c in v.get("phases").arr() {
        let state = match c.get("state").str() {
            "Open" => LobbyState::Open,
            "Finalized" => LobbyState::Finalized,
            "Cancelled" => LobbyState::Cancelled,
            s => panic!("unknown state {s}"),
        };
        let got = phase_at(&timing, state, c.get("quorum").bool(), c.get("now").i64());
        assert_eq!(phase_name(got), c.get("expected").str(), "{c:?}");
    }
}

#[test]
fn action_vectors() {
    let v = vectors();
    for c in v.get("actions").arr() {
        let action = match c.get("action").str() {
            "Deposit" => Action::Deposit,
            "Withdraw" => Action::Withdraw,
            "Finalize" => Action::Finalize,
            "Cancel" => Action::Cancel,
            "Claim" => Action::Claim,
            "Refund" => Action::Refund,
            a => panic!("unknown action {a}"),
        };
        let got = check_action(phase_from(c.get("phase").str()), action, c.get("launcher").bool());
        check(&format!("{c:?}"), got, c.get("expected"), |_, ok| assert!(ok.bool()));
    }
}

#[test]
fn totals_vectors() {
    let v = vectors();
    let mut t = LobbyTotals::default();
    for c in v.get("totals").arr() {
        let before = t;
        let got = match c.get("op").str() {
            "deposit" => t.deposit(c.get("wallet").u64(), c.get("amount").u64(), c.get("cap").u64()),
            "withdraw" => t.withdraw(c.get("wallet").u64(), c.get("amount").u64()),
            o => panic!("unknown op {o}"),
        };
        let expected = c.get("expected");
        check(&format!("{c:?}"), got, expected, |d, ok| assert_eq!(*d, ok.get("deposit").u64()));
        match expected.opt("ok") {
            Some(ok) => {
                let tt = ok.get("totals");
                assert_eq!(t, LobbyTotals { total_deposits: tt.get("totalDeposits").u64(), depositors: tt.get("depositors").u32() });
            }
            None => assert_eq!(t, before, "failed op must not change totals"),
        }
    }
}

#[test]
fn quote_vectors() {
    let v = vectors();
    for c in v.get("quotes").arr() {
        let got = quote_buy_exact_in(&curve_from(c.get("curve")), c.get("amountIn").u64(), c.get("feeRate").u64());
        check(c.get("name").str(), got, c.get("expected"), |q, ok| {
            assert_eq!(
                *q,
                BuyQuote {
                    amount_in: ok.get("amountIn").u64(),
                    amount_out: ok.get("amountOut").u64(),
                    fee: ok.get("fee").u64(),
                    capped: ok.get("capped").bool()
                }
            )
        });
    }
}

#[test]
fn cap_vectors() {
    let v = vectors();
    for c in v.get("caps").arr() {
        let state = curve_from(c.get("curve"));
        let got = cap_for_supply_bps(&state, c.get("supply").u64(), c.get("bps").u16(), c.get("feeRate").u64());
        check(c.get("name").str(), got, c.get("expected"), |g, ok| assert_eq!(*g, ok.u64()));
    }
    let d = v.get("defaultCaps");
    let got = caps(&curve_from(d.get("curve")), d.get("supply").u64(), &params_from(d.get("params")), d.get("feeRate").u64());
    check("default caps", got, d.get("expected"), |c, ok| {
        assert_eq!(*c, Caps { max_raise: ok.get("maxRaise").u64(), wallet_cap: ok.get("walletCap").u64() })
    });
}

#[test]
fn allocation_vectors_include_spec_example() {
    let v = vectors();
    let cases = v.get("allocation").arr();
    let spec = &cases[0];
    assert_eq!(spec.get("deposits").arr().iter().map(Json::u64).collect::<Vec<_>>(), [40, 30, 20]);
    assert_eq!((spec.get("raiseSpent").u64(), spec.get("tokensBought").u64()), (60, 5_901));
    for c in cases {
        let (total, r, b) = (c.get("totalDeposits").u64(), c.get("raiseSpent").u64(), c.get("tokensBought").u64());
        for (d, expected) in c.get("deposits").arr().iter().zip(c.get("expected").arr()) {
            check(c.get("name").str(), claim_amounts(d.u64(), total, r, b), expected, |a, ok| {
                assert_eq!(*a, Allocation { refund: ok.get("refund").u64(), spent: ok.get("spent").u64(), tokens: ok.get("tokens").u64() })
            });
        }
    }
}

#[test]
fn fee_share_and_claimable_vectors() {
    let v = vectors();
    for c in v.get("feeShares").arr() {
        let got = fee_share(c.get("fee").u64(), c.get("deposit").u64(), c.get("totalDeposits").u64());
        check(&format!("{c:?}"), got, c.get("expected"), |x, ok| assert_eq!(*x, ok.u64()));
    }
    for c in v.get("claimable").arr() {
        let got = claimable(
            c.get("tokens").u64(),
            c.get("finalizedAt").i64(),
            c.get("now").i64(),
            c.get("unlockSecs").u32(),
            c.get("alreadyClaimed").u64(),
        );
        check(&format!("{c:?}"), got, c.get("expected"), |x, ok| assert_eq!(*x, ok.u64()));
    }
}
