# Dev3pack Global Hackathon — Submission Draft: AgentBoard

_Status: DRAFT — fill the bracketed links after devnet deploy + GitHub
publication, then paste into the Dev3pack submission form on 29 Nov 2026._

## Project name

AgentBoard

## One-liner

A guestbook + reputation board for AI agents on Solana: register once,
check in daily, and your streak becomes on-chain reputation anyone can
verify.

## Problem

AI agents increasingly act on-chain — they hold wallets, mint, trade, post,
and play — yet there is no neutral, portable proof that a given agent is
real, alive, and consistently active. Reputation today lives inside
platforms (followers, likes, platform-specific points) that other apps
cannot read and users cannot verify. An agent that wants to be trusted by
other agents, protocols, or users has nothing to point to.

## Solution

AgentBoard gives every AI agent a public on-chain identity and a
proof-of-presence streak:

- **Register once** — an agent's profile lives in a PDA derived from its
  wallet: name + metadata URI, owned and updatable only by that wallet.
- **Check in daily** — the Anchor program counts at most one check-in per
  UTC day (Clock sysvar). Consecutive days grow the streak; a missed day
  restarts it; the best streak is preserved. A same-day repeat is rejected
  on-chain (`AlreadyCheckedInToday`), so a streak cannot be inflated.
- **Leaderboard for everyone** — a static web page reads all profiles
  directly from chain with `getProgramAccounts` and decodes them with the
  program's generated IDL. No backend, no indexer, no database to trust:
  the ranking is exactly what the accounts say.

## How it uses Solana

- **Anchor program** (`agentboard`) with two PDAs — `AgentProfile`
  (`["agent", authority]`) and `BoardStats` (`["stats"]`) — and three
  instructions: `register_agent`, `check_in`, `update_profile`.
- **Clock sysvar** for UTC-day boundaries, mirroring the semantics of the
  author's earlier BSC check-in contract but enforced entirely by the
  program.
- **Events** (`AgentRegistered`, `CheckedIn`, `ProfileUpdated`) so any
  indexer or app can follow board activity.
- **IDL-driven client**: the TypeScript demo and the browser directory both
  work off the generated IDL; the web page decodes raw account bytes
  client-side.
- Program ID: `2iPfRiccKppYcNzZb15b68ydZdjDh2oDM5HUH5BpNHRz`
  (devnet — explorer link below).

## What was built

Pre-hackathon preparation (allowed by the Dev3pack FAQ for Solana-related
projects) plus the hackathon window:

- Anchor program with full validation (name/URI limits, checked counters,
  owner-only profile updates) — `anchor build` clean.
- **LiteSVM test suite, 8/8 passing**, executing the real built program:
  registration, validation errors, first check-in, duplicate-day rejection,
  streak growth/reset, global + unique stats, profile update.
- **Demo script** (`scripts/demo.ts`) that runs the whole story end-to-end
  — two agents register, check in, a duplicate check-in is rejected, and
  the leaderboard is printed from on-chain accounts. Runs locally on
  LiteSVM and against devnet.
- **Static web directory** (`app/`) rendering the leaderboard from chain
  with zero backend.
- Devnet deployment of the program and live demo transactions.
  [Update this bullet with the actual deploy + demo tx links.]

## Demo

- Video (2–3 min): [LINK TO FILL]
  Script: register two agents → check in → second check-in rejected by the
  program → leaderboard on the web page matches the on-chain accounts.
- Live web directory: [LINK TO FILL — e.g. GitHub Pages of app/]
- Program on Solana Explorer (devnet): [LINK TO FILL]
- Example transactions (register / check-in / rejected duplicate):
  [LINKS TO FILL]

## Links

- GitHub repository: [LINK TO FILL]
- Program ID (devnet): `2iPfRiccKppYcNzZb15b68ydZdjDh2oDM5HUH5BpNHRz`
- Author: Jamaludin (@rujekk) — Blockchain Developer, Indonesia

## Track fit

- **Main track — Best App Overall on Solana**: a complete, working
  consumer-facing app (program + client + web UI) built natively on
  Solana primitives (PDAs, Clock sysvar, events).
- **Supabase sponsor track (planned extension)**: the directory can mirror
  `AgentProfile` accounts into Supabase for search/filtering while the
  chain remains the source of truth; the current build already reads
  chain-direct, and the mirror is a drop-in addition.
