/**
 * End-to-end CLI tests against an in-process mock JSON-RPC server that serves
 * LaunchLab / CPMM / SPL accounts encoded with the vendored Raydium IDLs.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, MINTS, PublicKey, TOKEN_PROGRAM_ID, Writer, cpmm, decodeBase58, launchLab, type IdlCoder } from "@float-community/sdk";
import { run } from "../src/main.ts";

const coin = Keypair.generate().publicKey;
const creator = Keypair.generate().publicKey;
const platformAdmin = Keypair.generate().publicKey;
const platformConfig = launchLab.launchLabPda.platformConfig(platformAdmin);
const globalConfig = launchLab.launchLabPda.globalConfig(MINTS.WSOL, 0, 0);
const poolAddr = launchLab.launchLabPda.pool(coin, MINTS.WSOL);

function encodeAccount(coder: IdlCoder, name: string, value: Record<string, unknown>): Uint8Array {
  const w = new Writer().bytes(coder.accountDiscriminator(name));
  coder.encodeType({ defined: { name } }, value, w);
  return w.toBytes();
}

const fixed = (s: string, n: number) => {
  const b = new Uint8Array(n);
  b.set(new TextEncoder().encode(s));
  return b;
};

function poolData(overrides: Record<string, unknown> = {}) {
  return encodeAccount(launchLab.launchLabCoder, "PoolState", {
    epoch: 800n, auth_bump: 255, status: 0, base_decimals: 6, quote_decimals: 9, migrate_type: 1,
    supply: 1_000_000_000_000_000n, total_base_sell: 793_100_000_000_000n,
    virtual_base: 1_073_025_605_596_382n, virtual_quote: 30_000_852_951n,
    real_base: 200_000_000_000_000n, real_quote: 10_000_000_000n,
    total_quote_fund_raising: 85_000_000_000n, quote_protocol_fee: 1_000n, platform_fee: 2_000_000_000n, migrate_fee: 0n,
    vesting_schedule: { total_locked_amount: 0n, cliff_period: 0n, unlock_period: 0n, start_time: 0n, allocated_share_amount: 0n },
    global_config: globalConfig, platform_config: platformConfig, base_mint: coin, quote_mint: MINTS.WSOL,
    base_vault: launchLab.launchLabPda.vault(poolAddr, coin), quote_vault: launchLab.launchLabPda.vault(poolAddr, MINTS.WSOL),
    creator, token_program_flag: 0, amm_creator_fee_on: { kind: "QuoteToken" }, platform_vesting_share: 0n,
    padding: new Uint8Array(54),
    ...overrides,
  });
}

const globalData = encodeAccount(launchLab.launchLabCoder, "GlobalConfig", {
  epoch: 1n, curve_type: 0, index: 0, migrate_fee: 0n, trade_fee_rate: 2_500n, max_share_fee_rate: 10_000n,
  min_base_supply: 10_000_000n, max_lock_rate: 300_000n, min_base_sell_rate: 200_000n, min_base_migrate_rate: 200_000n,
  min_quote_fund_raising: 30_000_000_000n, quote_mint: MINTS.WSOL, protocol_fee_owner: PublicKey.default,
  migrate_fee_owner: PublicKey.default, migrate_to_amm_wallet: PublicKey.default, migrate_to_cpswap_wallet: PublicKey.default,
  requires_platform_auth: 0, padding_alignment: new Uint8Array(7), padding: Array(15).fill(0n),
});

const platformData = encodeAccount(launchLab.launchLabCoder, "PlatformConfig", {
  epoch: 1n, platform_fee_wallet: platformAdmin, platform_nft_wallet: platformAdmin, platform_scale: 0n, creator_scale: 0n,
  burn_scale: 1_000_000n, fee_rate: 7_500n, name: fixed("Float", 64), web: fixed("https://www.floatlaunch.xyz", 256),
  img: fixed("", 256), cpswap_config: cpmm.cpmmPda.ammConfig(0), creator_fee_rate: 0n,
  transfer_fee_extension_auth: PublicKey.default, platform_vesting_wallet: PublicKey.default, platform_vesting_scale: 0n,
  platform_cp_creator: PublicKey.default, padding: new Uint8Array(108), curve_params: [],
});

const mintData = (() => {
  const w = new Writer().u32(0).bytes(new Uint8Array(32)).u64(0n).u8(9).bool(true).u32(0).bytes(new Uint8Array(32));
  return w.toBytes();
})();

const accounts = new Map<string, { owner: PublicKey; data: Uint8Array }>([
  [poolAddr.toBase58(), { owner: launchLab.LAUNCHLAB_PROGRAM_ID, data: poolData() }],
  [globalConfig.toBase58(), { owner: launchLab.LAUNCHLAB_PROGRAM_ID, data: globalData }],
  [platformConfig.toBase58(), { owner: launchLab.LAUNCHLAB_PROGRAM_ID, data: platformData }],
  [MINTS.WSOL.toBase58(), { owner: TOKEN_PROGRAM_ID, data: mintData }],
]);

// --- Graduated Float coins with CPMM pools (Coin Families parent, Float Index basket).
const ammConfig0 = cpmm.cpmmPda.ammConfig(0);
const nowSecs = BigInt(Math.floor(Date.now() / 1000));

function tokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint): Uint8Array {
  return new Writer().bytes(mint.bytes).bytes(owner.bytes).u64(amount).u32(0).bytes(new Uint8Array(32)).u8(1).u32(0).u64(0n).u64(0n).u32(0).bytes(new Uint8Array(32)).toBytes();
}

accounts.set(ammConfig0.toBase58(), {
  owner: cpmm.CPMM_PROGRAM_ID,
  data: encodeAccount(cpmm.cpmmCoder, "AmmConfig", {
    bump: 255, disable_create_pool: false, index: 0, trade_fee_rate: 2_500n, protocol_fee_rate: 120_000n, fund_fee_rate: 40_000n,
    create_pool_fee: 0n, protocol_owner: PublicKey.default, fund_owner: PublicKey.default, creator_fee_rate: 0n, padding: Array(15).fill(0n),
  }),
});

/** A coin on the mock Float platform config that graduated `ageDays` ago into a CPMM pool against WSOL. */
function addGraduatedCoin(coinReserve: bigint, solReserve: bigint, ageDays: number, poolStatus = 0) {
  const mint = Keypair.generate().publicKey;
  const [m0, m1] = cpmm.sortMints(mint, MINTS.WSOL);
  const pool = cpmm.cpmmPda.pool(ammConfig0, m0, m1);
  const coinIs0 = m0.equals(mint);
  const v0 = cpmm.cpmmPda.vault(pool, m0);
  const v1 = cpmm.cpmmPda.vault(pool, m1);
  accounts.set(launchLab.launchLabPda.pool(mint, MINTS.WSOL).toBase58(), {
    owner: launchLab.LAUNCHLAB_PROGRAM_ID,
    data: poolData({ status: 2, base_mint: mint, real_base: 793_100_000_000_000n, real_quote: 85_000_000_000n, platform_fee: 0n }),
  });
  accounts.set(pool.toBase58(), {
    owner: cpmm.CPMM_PROGRAM_ID,
    data: encodeAccount(cpmm.cpmmCoder, "PoolState", {
      amm_config: ammConfig0, pool_creator: platformAdmin, token_0_vault: v0, token_1_vault: v1,
      lp_mint: cpmm.cpmmPda.lpMint(pool), token_0_mint: m0, token_1_mint: m1,
      token_0_program: TOKEN_PROGRAM_ID, token_1_program: TOKEN_PROGRAM_ID, observation_key: cpmm.cpmmPda.observation(pool),
      auth_bump: 255, status: poolStatus, lp_mint_decimals: 9, mint_0_decimals: coinIs0 ? 6 : 9, mint_1_decimals: coinIs0 ? 9 : 6,
      lp_supply: 1n, protocol_fees_token_0: 0n, protocol_fees_token_1: 0n, fund_fees_token_0: 0n, fund_fees_token_1: 0n,
      open_time: nowSecs - BigInt(Math.round(ageDays * 86_400)), recent_epoch: 0n, creator_fee_on: 0, enable_creator_fee: false, padding1: new Uint8Array(6),
      creator_fees_token_0: 0n, creator_fees_token_1: 0n, padding: Array(28).fill(0n),
    }),
  });
  accounts.set(v0.toBase58(), { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(m0, platformAdmin, coinIs0 ? coinReserve : solReserve) });
  accounts.set(v1.toBase58(), { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(m1, platformAdmin, coinIs0 ? solReserve : coinReserve) });
  return { mint, pool };
}

// Coin Families parent: 100 000 coins (6 decimals) against 1 000 SOL → $1.50 at $150/SOL, graduated 10 days ago.
const { mint: parentCoin, pool: parentCpmmPool } = addGraduatedCoin(100_000_000_000n, 1_000_000_000_000n, 10);

function rawAccount(addr: string) {
  const a = accounts.get(addr);
  if (!a) return null;
  return { data: [Buffer.from(a.data).toString("base64"), "base64"], owner: a.owner.toBase58(), lamports: 2_039_280, executable: false, rentEpoch: 0 };
}

let server: Server;
let rpc = "";

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body);
      let result: unknown;
      if (method === "getAccountInfo") result = { context: { slot: 1 }, value: rawAccount(params[0]) };
      else if (method === "getMultipleAccounts") result = { context: { slot: 1 }, value: params[0].map(rawAccount) };
      else if (method === "getProgramAccounts") {
        const filters: { memcmp?: { offset: number; bytes: string } }[] = params[1]?.filters ?? [];
        result = [...accounts.entries()]
          .filter(([, a]) => a.owner.toBase58() === params[0])
          .filter(([, a]) => filters.every((f) => !f.memcmp || Buffer.from(a.data.subarray(f.memcmp.offset, f.memcmp.offset + decodeBase58(f.memcmp.bytes).length)).equals(Buffer.from(decodeBase58(f.memcmp.bytes)))))
          .map(([pubkey]) => ({ pubkey, account: rawAccount(pubkey) }));
      }
      else result = null;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  rpc = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(() => server.close());

async function cli(...argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await run([...argv, "--rpc", rpc], (s) => lines.push(s));
  return { code, out: lines.join("\n") };
}

test("pool: decodes LaunchLab pool, global and platform configs", async () => {
  const { code, out } = await cli("pool", coin.toBase58());
  assert.equal(code, 0, out);
  const j = JSON.parse(out);
  assert.equal(j.platform, "Float");
  assert.equal(j.stage, "bonding");
  assert.equal(j.bondingProgress, "11.76%");
  assert.equal(j.feeRates.platform, "0.750%");
  assert.equal(j.pendingPlatformFee, "2");
});

test("quote buy: 1 SOL pays 1% total fee", async () => {
  const { code, out } = await cli("quote", "buy", coin.toBase58(), "1");
  assert.equal(code, 0, out);
  const j = JSON.parse(out);
  assert.equal(j.fees.total, "0.01");
  assert.equal(j.fees.platform, "0.0075");
  assert.equal(j.graduatesOnThisBuy, false);
});

test("cycle: pending platform fee is routed through the Float split", async () => {
  const { code, out } = await cli("cycle", coin.toBase58(), "--json");
  assert.equal(code, 0, out);
  const j = JSON.parse(out);
  assert.equal(j.stage, "bonding");
  assert.equal(j.totalPending, "2000000000");
  assert.equal(j.split.flagship, "700000000");
  assert.equal(j.split.holders, "300000000");
  assert.equal(j.split.creator, "100000000");
});

test("cycle (table output) names every bucket", async () => {
  const { out } = await cli("cycle", coin.toBase58());
  for (const b of ["Holders", "Creator", "Flagship", "Traders", "Treasury"]) assert.match(out, new RegExp(b));
});

test("inspect: identifies a LaunchLab PlatformConfig by discriminator", async () => {
  const { out } = await cli("inspect", platformConfig.toBase58());
  const j = JSON.parse(out);
  assert.equal(j.type, "PlatformConfig");
  assert.equal(j.data.name, "Float");
  assert.equal(j.data.web, "https://www.floatlaunch.xyz");
});

test("inspect: decodes SPL mints", async () => {
  const { out } = await cli("inspect", MINTS.WSOL.toBase58());
  assert.equal(JSON.parse(out).data.decimals, 9);
});

test("airdrop: ranks a CSV of trades", async () => {
  const dir = mkdtempSync(join(tmpdir(), "float-"));
  const f = join(dir, "trades.csv");
  writeFileSync(f, [
    "wallet,coin,pair,side,timestamp,volume_usd",
    "alice,C1,SOL,buy,2026-11-05T10:00:00Z,500",
    "bob,C1,SOL,buy,2026-11-05T10:05:00Z,300",
    "alice,C2,SOL,sell,2026-11-06T09:00:00Z,250",
    "early,C1,SOL,buy,2026-11-03T09:00:00Z,99999",
  ].join("\n"));
  const { code, out } = await cli("airdrop", "--trades", f, "--round", "2", "--pot", "1000", "--csv");
  assert.equal(code, 0, out);
  const rows = out.split("\n");
  assert.equal(rows[0], "rank,wallet,volumeUsd,trades,usdc");
  assert.equal(rows[1], "1,alice,750.00,2,714.285714");
  assert.equal(rows[2], "2,bob,300.00,1,285.714285");
  assert.equal(rows.length, 3);
});

test("unknown command and usage errors return exit code 2", async () => {
  assert.equal((await cli("nope")).code, 2);
  assert.equal((await cli("airdrop")).code, 2);
  assert.equal((await cli("family")).code, 2);
  assert.equal((await cli("family", "simulate", "--parent", parentCoin.toBase58())).code, 2);
});

// ----------------------------------------------------------- Coin Families

test("family check: graduated Float coin with $150k paired liquidity is eligible", async () => {
  const { code, out } = await cli("family", "check", parentCoin.toBase58(), "--platform-config", platformConfig.toBase58(), "--paired-usd", "150", "--json");
  assert.equal(code, 0, out);
  const j = JSON.parse(out);
  assert.equal(j.eligible, true, out);
  assert.equal(j.cpmmPool, parentCpmmPool.toBase58());
  assert.deepEqual(j.rules.map((r: { ok: boolean }) => r.ok), [true, true, true, true, true, true]);
});

test("family check: explains why a coin is not eligible", async () => {
  const notGraduated = await cli("family", "check", coin.toBase58(), "--platform-config", platformConfig.toBase58(), "--paired-usd", "150");
  assert.equal(notGraduated.code, 0, notGraduated.out);
  assert.match(notGraduated.out, /Not eligible as a parent: ParentNotGraduated/);
  const thin = await cli("family", "check", parentCoin.toBase58(), "--platform-config", platformConfig.toBase58(), "--paired-usd", "50");
  assert.match(thin.out, /Not eligible as a parent: ParentPoolTooThin/);
  const young = await cli("family", "check", parentCoin.toBase58(), "--platform-config", platformConfig.toBase58(), "--paired-usd", "150", "--min-age-days", "30");
  assert.match(young.out, /ParentTooYoung/);
  const unknown = await cli("family", "check", parentCoin.toBase58(), "--paired-usd", "150");
  assert.match(unknown.out, /ParentNotFloatCoin/);
  assert.match(unknown.out, /No --platform-config given/);
});

test("family simulate: 5 children × $200k/day buy parent through its pool, labelled as scenarios", async () => {
  const { code, out } = await cli("family", "simulate", "--parent", parentCoin.toBase58(), "--children", "5", "--volume", "200000", "--paired-usd", "150", "--days", "30", "--json");
  assert.equal(code, 0, out);
  const j = JSON.parse(out);
  assert.equal(j.mode, "B");
  assert.equal(j.parentPriceUsd, 1.5); // 1 000 SOL × $150 / 100 000 parent
  assert.equal(j.days.length, 30);
  assert.equal(j.days[0].holderRewardsUsd, 1_312.5); // 5 × $200 000 × 0.75 % × 17.5 %
  assert.equal(j.days[0].parentBought, 875);
  // 8.75 SOL into a 1 000 SOL pool moves the price ~1.7 %: two ≤ 1 % swaps.
  assert.ok(j.days[0].priceImpact > 0.015 && j.days[0].priceImpact < 0.02, String(j.days[0].priceImpact));
  assert.equal(j.days[0].swapsWithinCap, 2);
  assert.match(j.disclaimer, /^Scenarios, not forecasts/);

  const spec = await cli("family", "simulate", "--parent", parentCoin.toBase58(), "--children", "1", "--volume", "200000", "--fee-bps", "100", "--paired-usd", "150", "--days", "1");
  assert.match(spec.out, /\$350/); // spec §7 example
  assert.match(spec.out, /Scenarios, not forecasts/);
});

// ------------------------------------------------------------- Float Index

// Eight eligible coins: i × 50 000 coins against 2 000 SOL ($300k paired side), graduated 30 days ago.
const basketCoins = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => addGraduatedCoin(BigInt(i) * 50_000_000_000n, 2_000_000_000_000n, 30).mint);
const youngCoin = addGraduatedCoin(50_000_000_000n, 2_000_000_000_000n, 2).mint;
const thinCoin = addGraduatedCoin(50_000_000_000n, 100_000_000_000n, 30).mint; // 100 SOL = $15k
const pausedCoin = addGraduatedCoin(50_000_000_000n, 2_000_000_000_000n, 30, 4).mint; // swap bit set
const undiscoveredCoin = addGraduatedCoin(50_000_000_000n, 2_000_000_000_000n, 30).mint; // not in stats.json

const statsFile = (() => {
  const dir = mkdtempSync(join(tmpdir(), "float-index-"));
  const path = join(dir, "stats.json");
  const coins = [
    ...basketCoins.map((m, i) => ({ mint: m.toBase58(), pair: "SOL", fees30dUsd: 100_000 - i * 1_000 })),
    { mint: parentCoin.toBase58(), pair: "SOL", fees30dUsd: 1_000 },
    { mint: youngCoin.toBase58(), fees30dUsd: 500_000 },
    { mint: thinCoin.toBase58(), fees30dUsd: 500_000 },
    { mint: pausedCoin.toBase58(), fees30dUsd: 500_000 },
    { mint: coin.toBase58(), fees30dUsd: 500_000 },
  ];
  writeFileSync(path, JSON.stringify({ asOf: "2026-11-25T00:00:00Z", windowDays: 30, platformConfig: platformConfig.toBase58(), prices: { SOL: 150 }, coins }));
  return path;
})();

type IndexRow = { mint: string; included: boolean; weightBps: number; reason: string };
const rowOf = (rows: IndexRow[], m: PublicKey) => rows.find((r) => r.mint === m.toBase58())!;

test("index weights: top coins by 30-day fees, √mcap weights capped at 15 %, every exclusion explained", async () => {
  const { code, out } = await cli("index", "weights", "--stats", statsFile, "--json");
  assert.equal(code, 0, out);
  const j = JSON.parse(out);
  assert.equal(j.error, null);
  assert.equal(j.basket.length, 9);
  assert.equal(j.basket.reduce((a: number, b: { weightBps: number }) => a + b.weightBps, 0), 10_000);
  assert.ok(j.basket.every((b: { weightBps: number }) => b.weightBps <= 1_500));
  assert.match(rowOf(j.rows, youngCoin).reason, /graduated 2\.0 days ago \(min 7\)/);
  assert.match(rowOf(j.rows, thinCoin).reason, /pool \$15,000 paired side \(min \$50,000\)/);
  assert.equal(rowOf(j.rows, pausedCoin).reason, "pool swaps paused");
  assert.equal(rowOf(j.rows, coin).reason, "not graduated");
  assert.equal(rowOf(j.rows, basketCoins[0]!).included, true);
});

test("index weights: --n 8 drops the lowest-fee coin, --n 5 at 15 % is infeasible, --discover finds unlisted coins", async () => {
  const eight = JSON.parse((await cli("index", "weights", "--stats", statsFile, "--n", "8", "--json")).out);
  assert.match(rowOf(eight.rows, parentCoin).reason, /rank #9 by 30-day fees, outside the top 8/);
  const five = await cli("index", "weights", "--stats", statsFile, "--n", "5");
  assert.equal(five.code, 0, five.out);
  assert.match(five.out, /No basket: InfeasibleCaps/);
  const discovered = JSON.parse((await cli("index", "weights", "--stats", statsFile, "--discover", "--json")).out);
  assert.equal(rowOf(discovered.rows, undiscoveredCoin).reason, "no 30-day fees in stats.json");
  const table = await cli("index", "weights", "--stats", statsFile);
  assert.match(table.out, /Basket: 9 coins, weights sum to 100\.00%/);
});

test("index simulate: 10 SOL deposit, creation fee, pass-through rewards, labelled as scenarios", async () => {
  const { code, out } = await cli("index", "simulate", "--deposit", "10", "--days", "30", "--stats", statsFile, "--json");
  assert.equal(code, 0, out);
  const j = JSON.parse(out);
  assert.equal(j.feeSol, 0.05);
  assert.equal(j.netSol, 9.95);
  assert.equal(j.genesisShares, "9950000000");
  assert.equal(j.rows.length, 9);
  assert.ok(j.rewardsUsdPerDay > 0);
  assert.ok(Math.abs(j.rewardsUsdTotal - j.rewardsUsdPerDay * 30) < 1e-9);
  assert.ok(j.redeemUsd > 0 && j.redeemUsd < 10 * 150);
  assert.match(j.disclaimer, /^Scenarios, not forecasts/);
  const text = await cli("index", "simulate", "--deposit", "10", "--days", "30", "--stats", statsFile);
  assert.match(text.out, /Holder rewards passed through: \$[\d.]+\/day/);
  assert.equal((await cli("index", "simulate", "--stats", statsFile)).code, 2);
  assert.equal((await cli("index")).code, 2);
});

// ------------------------------------------------------- Fair Launch Lobby

const SAMPLE_DEPOSITS = join(import.meta.dirname, "../../../examples/lobby-deposits.sample.csv");

test("lobby simulate --pool: genesis reserves from a real pool, oversubscribed sample fills pro rata", async () => {
  const { code, out } = await cli("lobby", "simulate", "--deposits", SAMPLE_DEPOSITS, "--pool", poolAddr.toBase58(), "--json");
  assert.equal(code, 0, out);
  const j = JSON.parse(out);
  assert.equal(j.curve.virtualBase, "1073025605596382");
  assert.equal(j.curve.feeRate, "10000"); // 0.25 % protocol + 0.75 % platform
  assert.equal(j.caps.maxRaise, "4924656210");
  assert.equal(j.caps.walletCap, "285072078");
  assert.equal(j.outcome, "finalized");
  assert.equal(j.depositors, 20);
  assert.equal(j.raiseSpent, j.caps.maxRaise);
  assert.ok(BigInt(j.totalDeposits) > BigInt(j.raiseSpent));
  const w01 = j.rows.find((r: { wallet: string }) => r.wallet === "w01");
  assert.equal(w01.requested, "350000000");
  assert.equal(w01.deposit, j.caps.walletCap);
  assert.ok(BigInt(j.tokensBought) <= 150_000_000_000_000n);
});

test("lobby simulate (table): uniform price and curve move after the lobby", async () => {
  const { code, out } = await cli("lobby", "simulate", "--deposits", SAMPLE_DEPOSITS, "--pool", poolAddr.toBase58());
  assert.equal(code, 0, out);
  assert.match(out, /Caps: max raise 4\.92465621 \(15\.00% of supply\), wallet cap 0\.285072078 \(1\.00%\)/);
  assert.match(out, /quorum met/);
  assert.match(out, /Uniform price: .* per coin for everyone/);
  assert.match(out, /Curve price: genesis .* → after the lobby/);
  assert.match(out, /not an official Float feature/);
});

test("lobby simulate offline: --virtual-base/--virtual-quote, missed quorum refunds everyone", async () => {
  const { code, out } = await cli("lobby", "simulate", "--deposits", SAMPLE_DEPOSITS, "--virtual-base", "1073025605596382", "--virtual-quote", "30000852951",
    "--total-base-sell", "793100000000000", "--min-wallets", "25");
  assert.equal(code, 0, out);
  assert.match(out, /quorum MISSED/);
  assert.match(out, /Outcome: cancelled/);
  assert.equal((await cli("lobby", "simulate", "--deposits", SAMPLE_DEPOSITS)).code, 2);
  assert.equal((await cli("lobby", "simulate", "--deposits", SAMPLE_DEPOSITS, "--pool", poolAddr.toBase58(), "--max-supply-bps", "2500")).code, 1);
});

test("family simulate: Mode A reports parent locked at graduation", async () => {
  const { code, out } = await cli("family", "simulate", "--parent", parentCoin.toBase58(), "--mode", "A", "--children", "10", "--volume", "50000",
    "--paired-usd", "150", "--days", "7", "--net-inflow-bps", "300", "--grad-prob", "0.2", "--locked-usd", "40000");
  assert.equal(code, 0, out);
  assert.match(out, /Mode A \(native quote\)/);
  assert.match(out, /Expected parent locked forever at graduation: \$80,000/);
});
