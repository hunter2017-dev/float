//! Rust ↔ TypeScript parity for Coin Families.
//!
//! `tests/fixtures/family-vectors.json` is generated from the TypeScript SDK
//! (`node scripts/dev/gen-fixtures.ts`); every case must give the same result
//! in float-core. Includes the spec's worked examples (§7).

mod common;

use common::{check, parse, Json};
use float_core::cpmm::Fees;
use float_core::family::*;

fn vectors() -> Json {
    parse(include_str!("fixtures/family-vectors.json"))
}

#[test]
fn eligibility_vectors() {
    let v = vectors();
    for c in v.get("eligibility").arr() {
        let (p, i) = (c.get("params"), c.get("input"));
        let params = EligibilityParams {
            parent_min_age_secs: p.get("parentMinAgeSecs").i64(),
            parent_min_pool_usd: p.get("parentMinPoolUsd").u64(),
            max_depth: p.get("maxDepth").u8(),
        };
        let input = EligibilityInput {
            kind: match i.get("kind").str() {
                "Flagship" => ParentKind::Flagship,
                "Coin" => ParentKind::Coin,
                k => panic!("unknown kind {k}"),
            },
            is_float_coin: i.get("isFloatCoin").bool(),
            graduated_at: i.get("graduatedAt").i64(),
            now: i.get("now").i64(),
            pool_paired_usd: i.get("poolPairedUsd").u64(),
            paired_paused: i.get("pairedPaused").bool(),
            parent_depth: i.get("parentDepth").u8(),
        };
        check(c.get("name").str(), check_parent_eligibility(&params, &input), c.get("expected"), |_, ok| assert!(ok.bool()));
    }
}

#[test]
fn lineage_vectors() {
    let v = vectors();
    for c in v.get("lineage").arr() {
        let ancestors: Vec<Address> = c.get("ancestors").arr().iter().map(Json::addr).collect();
        let got = validate_lineage(&c.get("child").addr(), &c.get("parent").addr(), &ancestors, c.get("maxDepth").u8());
        check(&format!("{c:?}"), got, c.get("expected"), |d, ok| assert_eq!(*d, ok.u8()));
    }
}

#[test]
fn mode_vectors() {
    let v = vectors();
    for c in v.get("mode").arr() {
        let mode = match c.get("mode").str() {
            "NativeQuote" => FamilyMode::NativeQuote,
            "RewardLinked" => FamilyMode::RewardLinked,
            m => panic!("unknown mode {m}"),
        };
        check(&format!("{c:?}"), check_mode(mode, &c.get("paired").addr(), &c.get("parent").addr()), c.get("expected"), |_, ok| {
            assert!(ok.bool())
        });
    }
}

#[test]
fn route_vectors() {
    let v = vectors();
    for c in v.get("routes").arr() {
        let hops: Vec<Hop> = c
            .get("hops")
            .arr()
            .iter()
            .map(|h| {
                let h = h.arr();
                Hop { pool: h[0].addr(), input_mint: h[1].addr(), output_mint: h[2].addr() }
            })
            .collect();
        let pinned: Vec<Address> = c.get("pinned").arr().iter().map(Json::addr).collect();
        let got = validate_route(&hops, &c.get("from").addr(), &c.get("to").addr(), &pinned);
        check(c.get("name").str(), got, c.get("expected"), |_, ok| assert!(ok.bool()));
    }
}

#[test]
fn min_out_vectors() {
    let v = vectors();
    for c in v.get("minOuts").arr() {
        let prices: Vec<u128> = c.get("prices").arr().iter().map(Json::u128).collect();
        let got = route_min_outs(c.get("amountIn").u64(), &prices, c.get("guardBps").u16());
        check(&format!("{c:?}"), got, c.get("expected"), |r, ok| {
            let want: Vec<u64> = ok.arr().iter().map(Json::u64).collect();
            assert_eq!(r.as_slice(), want.as_slice());
        });
    }
}

#[test]
fn max_hop_input_vectors() {
    let v = vectors();
    for c in v.get("maxHopInput").arr() {
        let f = c.get("fees");
        let fees = Fees {
            trade_fee_rate: f.get("tradeFeeRate").u64(),
            creator_fee_rate: f.get("creatorFeeRate").u64(),
            protocol_fee_rate: f.get("protocolFeeRate").u64(),
            fund_fee_rate: f.get("fundFeeRate").u64(),
            creator_fee_on_input: f.get("creatorFeeOnInput").bool(),
        };
        let got = max_hop_input(c.get("inputReserve").u64(), c.get("outputReserve").u64(), &fees, c.get("maxImpactBps").u64());
        check(&format!("{c:?}"), got, c.get("expected"), |x, ok| assert_eq!(*x, ok.u64()));
    }
}

fn ledger_from(j: &Json) -> ModeBLedger {
    ModeBLedger {
        holders_unpaid_paired: j.get("holdersUnpaidPaired").u64(),
        holders_unpaid_parent: j.get("holdersUnpaidParent").u64(),
        total_converted_paired: j.get("totalConvertedPaired").u64(),
        total_parent_bought: j.get("totalParentBought").u64(),
        total_parent_paid: j.get("totalParentPaid").u64(),
    }
}

#[test]
fn ledger_vectors() {
    let v = vectors();
    for c in v.get("ledger").arr() {
        let name = c.get("name").str();
        let mut l = ledger_from(c.get("start"));
        for (op, expected) in c.get("ops").arr().iter().zip(c.get("expected").arr()) {
            let before = l;
            match op.get("op").str() {
                "conversion" => {
                    let got = l.record_conversion(op.get("amountIn").u64(), op.get("before").u64(), op.get("after").u64());
                    check(name, got, expected, |received, ok| assert_eq!(*received, ok.get("received").u64()));
                }
                "payout" => check(name, l.record_payout(op.get("total").u64()), expected, |_, _| {}),
                o => panic!("unknown op {o}"),
            }
            match expected.opt("ok") {
                Some(ok) => assert_eq!(l, ledger_from(ok.get("ledger")), "{name}: ledger after {op:?}"),
                None => assert_eq!(l, before, "{name}: failed op must not change the ledger"),
            }
        }
    }
}

#[test]
fn daily_demand_vectors_include_spec_example() {
    let v = vectors();
    let cases = v.get("dailyDemand").arr();
    assert!(cases.iter().any(|c| c.get("volumeUsd").u64() == 200_000 * MICRO_USD
        && c.get("feeBps").u16() == 100
        && c.get("holdersBps").u16() == 1_750
        && c.get("expected").get("ok").u64() == 350 * MICRO_USD));
    for c in cases {
        let got = daily_parent_demand(c.get("volumeUsd").u64(), c.get("feeBps").u16(), c.get("holdersBps").u16());
        check(c.get("name").str(), got, c.get("expected"), |x, ok| assert_eq!(*x, ok.u64()));
    }
}
