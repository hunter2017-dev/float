//! Rust ↔ TypeScript parity for the Float Index.
//!
//! `tests/fixtures/index-vectors.json` is generated from the TypeScript SDK
//! (`node scripts/dev/gen-fixtures.ts`); every case must give the same result
//! in float-core. Includes the spec's §4 vector (9 shares).

mod common;

use common::{check, parse, Json};
use float_core::index::*;

fn vectors() -> Json {
    parse(include_str!("fixtures/index-vectors.json"))
}

fn u64s(j: &Json) -> Vec<u64> {
    j.arr().iter().map(Json::u64).collect()
}

#[test]
fn liquidity_cap_vectors() {
    let v = vectors();
    for c in v.get("liquidityCaps").arr() {
        let got = liquidity_cap_bps(c.get("poolPairedUsd").u64(), c.get("aumUsd").u64(), c.get("liqFactorBps").u16());
        assert_eq!(got, c.get("expected").u16(), "{c:?}");
    }
}

#[test]
fn weight_vectors() {
    let v = vectors();
    for c in v.get("weights").arr() {
        let cands: Vec<WeightInput> = c
            .get("candidates")
            .arr()
            .iter()
            .map(|x| {
                let x = x.arr();
                WeightInput { mint: x[0].addr(), mcap: x[1].u64(), liq_cap_bps: x[2].u16() }
            })
            .collect();
        let mut out = [0u16; MAX_COMPONENTS + 1];
        let got = target_weights(&cands, c.get("capBps").u16(), &mut out);
        check(c.get("name").str(), got, c.get("expected"), |_, ok| {
            let want: Vec<u16> = ok.arr().iter().map(Json::u16).collect();
            assert_eq!(&out[..cands.len()], want.as_slice(), "{}", c.get("name").str());
        });
    }
}

#[test]
fn creation_vectors_include_spec_example() {
    let v = vectors();
    let cases = v.get("creation").arr();
    assert_eq!(u64s(cases[0].get("qOld")), [1_000, 500, 200]);
    assert_eq!(u64s(cases[0].get("qNew")), [100, 52, 19]);
    assert_eq!(cases[0].get("expected").get("ok").u64(), 9);
    for c in cases {
        let got = creation_shares(c.get("supply").u64(), &u64s(c.get("qOld")), &u64s(c.get("qNew")), c.get("tNet").u64());
        check(c.get("name").str(), got, c.get("expected"), |s, ok| assert_eq!(*s, ok.u64()));
    }
    for c in v.get("tickets").arr() {
        let got = ticket_shares(c.get("epochShares").u64(), c.get("ticket").u64(), c.get("epochTotal").u64());
        check(&format!("{c:?}"), got, c.get("expected"), |s, ok| assert_eq!(*s, ok.u64()));
    }
}

#[test]
fn redeem_and_reward_vectors() {
    let v = vectors();
    for c in v.get("redeem").arr() {
        let q = u64s(c.get("quantities"));
        let mut out = vec![0u64; q.len()];
        let got = redeem_amounts(&q, c.get("x").u64(), c.get("supply").u64(), &mut out);
        check(&format!("{c:?}"), got, c.get("expected"), |_, ok| assert_eq!(out, u64s(ok)));
    }
    for c in v.get("rewards").arr() {
        let got = reward_available(c.get("balance").u64(), c.get("tracked").u64());
        check(&format!("{c:?}"), got, c.get("expected"), |r, ok| assert_eq!(*r, ok.u64()));
    }
}

#[test]
fn rebalance_vectors() {
    let v = vectors();
    for c in v.get("rebalance").arr() {
        let name = c.get("name").str();
        let q = u64s(c.get("quantities"));
        let prices: Vec<u128> = c.get("prices").arr().iter().map(Json::u128).collect();
        let targets: Vec<u16> = c.get("targets").arr().iter().map(Json::u16).collect();
        let mut drift = vec![0i32; q.len()];
        check(name, drift_bps(&q, &prices, &targets, &mut drift), c.get("drift"), |_, ok| {
            let want: Vec<i32> = ok.arr().iter().map(|d| d.i64() as i32).collect();
            assert_eq!(drift, want, "{name}");
        });
        let mut legs = vec![RebalanceLeg::default(); q.len()];
        let got = rebalance_plan(&q, &prices, &targets, c.get("bandBps").u16(), c.get("turnoverBps").u16(), &mut legs);
        check(name, got, c.get("expected"), |_, ok| {
            let want: Vec<RebalanceLeg> =
                ok.arr().iter().map(|l| RebalanceLeg { sell: l.get("sell").u64(), buy: l.get("buy").u64() }).collect();
            assert_eq!(legs, want, "{name}");
        });
    }
}
