# Proposals

Community proposals for new Float platform features. None of these are official Float features. Each one specifies the mechanism, the rule changes Float would need, a reference implementation plan for this repo, and open questions for the Float team.

| Proposal | One line | Phase 1 (off-chain) | Phase 2 (on-chain) |
| --- | --- | --- | --- |
| [Coin Families](coin-families.md) | Child coins pay their holders in a parent coin or `$FLOAT`, creating structural demand for the parent | `float-core::family`, SDK `families.ts`, `float family …` | `FamilyRecord`, `ParentStats`, multi-hop conversions in `float-router` |
| [Fair Launch Lobby](fair-launch-lobby.md) | Batched launch: deposits first, then coin creation plus one same-price buy in a single transaction | `float-core::lobby`, SDK `lobby.ts`, `float lobby simulate` | Lobby instructions in `float-router` |
| [Float Index](float-index.md) | FIDX: one token over the top Float coins that passes through their holder rewards | `float-core::index`, SDK `floatIndex.ts`, `float index …` | New program `float-index` |

Conventions: **Assumption** marks anything that depends on Float's closed program or on third parties. Numbers taken from the official docs cite <https://www.floatlaunch.xyz/docs> and are parameters, not constants.
