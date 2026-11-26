import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keypair, lobby as l, router } from "../src/index.ts";
import { buildLobbyVectors } from "../../../scripts/dev/fixtures/lobby.ts";

const FIXTURE = fileURLToPath(new URL("../../../crates/float-core/tests/fixtures/lobby-allocation.json", import.meta.url));
const code = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    if (e instanceof l.LobbyError) return e.code;
    throw e;
  }
};

const VB = 1_073_025_605_596_382n;
const VQ = 30_000_852_951n;
const SELL = 793_100_000_000_000n;
const SUPPLY = 1_000_000_000_000_000n;
const FEE = 10_000n;
const curve: l.GenesisCurve = { virtualBase: VB, virtualQuote: VQ, totalBaseSell: SELL, supply: SUPPLY, baseDecimals: 6, quoteDecimals: 9, feeRate: FEE, source: "test" };
const genesis = l.genesisCurve(VB, VQ, SELL);

test("committed lobby vectors are up to date (run node scripts/dev/gen-fixtures.ts)", () => {
  assert.deepEqual(JSON.parse(readFileSync(FIXTURE, "utf8")), JSON.parse(JSON.stringify(buildLobbyVectors())));
});

test("spec §6.2 vector: 40/30/20, R = 60, B = 5 901", () => {
  const a = [40n, 30n, 20n].map((d) => l.claimAmounts(d, 90n, 60n, 5_901n));
  assert.deepEqual(a.map((x) => x.refund), [13n, 10n, 6n]);
  assert.deepEqual(a.map((x) => x.spent), [27n, 20n, 14n]);
  assert.deepEqual(a.map((x) => x.tokens), [2_622n, 1_967n, 1_311n]);
});

test("params: every §5 bound, with a message naming it", () => {
  const ok = l.lobbyParamsWithDefaults(1n);
  assert.equal(code(() => l.validateLobbyParams(ok)), "ok");
  assert.throws(() => l.validateLobbyParams({ ...ok, maxSupplyBps: 2_001 }), /maxSupplyBps must be 1-2000/);
  assert.throws(() => l.validateLobbyParams({ ...ok, lockWindowSecs: 301 }), /lockWindowSecs/);
  assert.equal(code(() => l.validateLobbyParams({ ...ok, minRaise: 0n })), "InvalidParams");
});

test("lifecycle: phases and allowed actions", () => {
  const t = l.lobbyTiming(1_000n, l.lobbyParamsWithDefaults(1n));
  assert.deepEqual(t, { openAt: 1_000n, lockAt: 1_540n, endAt: 1_600n, finalizeDeadline: 2_200n });
  assert.equal(l.phaseAt(t, "Open", false, 1_540n), "Locked");
  assert.equal(l.phaseAt(t, "Open", true, 1_600n), "Finalizable");
  assert.equal(l.phaseAt(t, "Open", false, 1_600n), "Expired");
  assert.equal(code(() => l.checkAction("Locked", "Withdraw", false)), "LobbyWrongPhase");
  assert.equal(code(() => l.checkAction("Expired", "Cancel", false)), "ok");
});

test("caps bind exactly: one more lamport would buy more than the share", () => {
  const caps = l.lobbyCaps(genesis, SUPPLY, l.lobbyParamsWithDefaults(1n), FEE);
  for (const [cap, bps] of [[caps.maxRaise, 1_500], [caps.walletCap, 100]] as const) {
    const target = l.supplyShare(SUPPLY, bps);
    assert.ok(l.quoteBuyExactIn(genesis, cap, FEE).amountOut <= target);
    assert.ok(l.quoteBuyExactIn(genesis, cap + 1n, FEE).amountOut > target);
  }
  assert.equal(caps.maxRaise, 4_924_656_210n);
  assert.equal(caps.walletCap, 285_072_078n);
});

test("running totals: cap per wallet, full withdrawal stops counting the wallet", () => {
  let t: l.LobbyTotals = { totalDeposits: 0n, depositors: 0 };
  t = l.applyDeposit(t, 0n, 30n, 40n).totals;
  assert.equal(code(() => l.applyDeposit(t, 30n, 11n, 40n)), "WalletCapExceeded");
  t = l.applyWithdraw(t, 30n, 30n).totals;
  assert.deepEqual(t, { totalDeposits: 0n, depositors: 0 });
});

test("PDAs follow spec §7 seeds under the router program id", () => {
  const launcher = Keypair.generate().publicKey;
  const pda = l.lobbyPda();
  const lobby = pda.lobby(launcher, 1n);
  assert.ok(!lobby.equals(pda.lobby(launcher, 2n)));
  const all = [lobby, pda.deposit(lobby, launcher), pda.quoteEscrow(lobby), pda.baseVault(lobby), pda.solPayer(lobby), pda.mint(lobby), pda.tickerReservation("PEPE")];
  assert.equal(new Set(all.map((k) => k.toBase58())).size, all.length);
  assert.ok(l.lobbyPda(router.ROUTER_PROGRAM_ID).mint(lobby).equals(pda.mint(lobby)));
});

test("simulateLobby: oversubscribed lobby fills pro rata at one price", () => {
  const p = { ...l.lobbyParamsWithDefaults(1n), minWallets: 3 };
  const deposits = Array.from({ length: 20 }, (_, i) => ({ wallet: `w${i}`, amount: 280_000_000n }));
  deposits.push({ wallet: "w0", amount: 100_000_000n }); // pushes w0 over the wallet cap
  const sim = l.simulateLobby(deposits, p, curve);
  assert.equal(sim.outcome, "finalized");
  assert.equal(sim.depositors, 20);
  assert.equal(sim.rows[0]!.deposit, sim.caps.walletCap);
  assert.equal(sim.raiseSpent, sim.caps.maxRaise);
  assert.ok(sim.totalDeposits > sim.caps.maxRaise);
  assert.ok(sim.tokensBought <= l.supplyShare(SUPPLY, 1_500));
  const refunds = sim.rows.reduce((a, r) => a + r.refund, 0n);
  assert.equal(sim.quoteDust, sim.totalDeposits - sim.raiseSpent - refunds);
  assert.ok(sim.quoteDust < 20n && sim.tokenDust < 20n);
  assert.ok(sim.postLobbyPriceRaw > sim.genesisPriceRaw);
  assert.ok(sim.uniformPriceRaw > sim.genesisPriceRaw && sim.uniformPriceRaw < sim.postLobbyPriceRaw * 1.02);
  // Every wallet pays the same price up to rounding.
  for (const r of sim.rows.slice(1)) assert.ok(Math.abs(Number(r.spent) / Number(r.tokens) - sim.uniformPriceRaw) / sim.uniformPriceRaw < 1e-6);
});

test("simulateLobby: quorum missed means everyone is refunded", () => {
  const sim = l.simulateLobby([{ wallet: "a", amount: 1_000n }], l.lobbyParamsWithDefaults(1n), curve);
  assert.equal(sim.outcome, "cancelled");
  assert.equal(sim.tokensBought, 0n);
  assert.deepEqual(sim.rows[0], { wallet: "a", requested: 1_000n, deposit: 1_000n, refund: 1_000n, spent: 0n, tokens: 0n, feeShare: 0n });
});
