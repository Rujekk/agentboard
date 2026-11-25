import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BankrunProvider } from "anchor-bankrun";
import { Agentboard } from "../target/types/agentboard";
import { Clock, ProgramTestContext, start } from "solana-bankrun";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { expect } from "chai";

// Bankrun suite: runs the compiled program in solana-program-test
// instead of a full test validator. STATUS in this sandbox: does NOT run
// — solana-bankrun 0.4.0 bundles solana-program-test 1.18, whose runtime
// rejects the modern SBF ELF ("Program is not deployed"), including the
// --arch v1 build in target/deploy-v1 (SBF_OUT_DIR should point there).
// Kept for environments with a newer bankrun; the suite that actually
// runs here is tests/agentboard.litesvm.ts. The canonical validator
// suite remains tests/agentboard.ts (`anchor test`).
const idl = require("../target/idl/agentboard.json");

const PROGRAM_ID = new PublicKey(
  "2iPfRiccKppYcNzZb15b68ydZdjDh2oDM5HUH5BpNHRz"
);
const DAY_SECONDS = 86_400n;

describe("agentboard (bankrun)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: Program<Agentboard>;
  let authority: PublicKey; // bankrun payer = agent A

  const agentB = Keypair.generate();

  const profilePda = (auth: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), auth.toBuffer()],
      PROGRAM_ID
    )[0];

  const statsPda = PublicKey.findProgramAddressSync(
    [Buffer.from("stats")],
    PROGRAM_ID
  )[0];

  async function warpDays(days: bigint) {
    const clock = await context.banksClient.getClock();
    context.setClock(
      new Clock(
        clock.slot,
        clock.epochStartTimestamp,
        clock.epoch,
        clock.leaderScheduleEpoch,
        clock.unixTimestamp + days * DAY_SECONDS
      )
    );
  }

  function expectAnchorError(err: any, code: string, customCode: number) {
    const haystack = [
      err?.message ?? "",
      err?.error?.errorCode?.code ?? "",
      JSON.stringify(err?.logs ?? []),
      String(err),
    ].join(" | ");
    const hex = "0x" + customCode.toString(16);
    expect(
      haystack.includes(code) || haystack.includes(hex),
      `expected error ${code} (${hex}), got: ${haystack.slice(0, 400)}`
    ).to.be.true;
  }

  before(async () => {
    context = await start([{ name: "agentboard", programId: PROGRAM_ID }], []);
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    program = new Program<Agentboard>(idl as Agentboard, provider);
    authority = provider.wallet.publicKey;

    // Fund agent B from the bankrun payer with a plain transfer.
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority,
        toPubkey: agentB.publicKey,
        lamports: 2 * LAMPORTS_PER_SOL,
      })
    );
    tx.recentBlockhash = context.lastBlockhash;
    tx.feePayer = authority;
    tx.sign(provider.wallet.payer);
    await context.banksClient.processTransaction(tx);
  });

  it("registers the first agent and initializes board stats", async () => {
    await program.methods
      .registerAgent("elsanani", "https://example.com/elsanani.json")
      .accounts({
        profile: profilePda(authority),
        stats: statsPda,
        authority,
      })
      .rpc();

    const profile = await program.account.agentProfile.fetch(
      profilePda(authority)
    );
    expect(profile.authority.toBase58()).to.equal(authority.toBase58());
    expect(profile.name).to.equal("elsanani");
    expect(profile.checkinStreak).to.equal(0);
    expect(profile.totalCheckins).to.equal(0);
    expect(profile.lastCheckinDay.toNumber()).to.equal(-1);

    const stats = await program.account.boardStats.fetch(statsPda);
    expect(stats.totalAgents.toNumber()).to.equal(1);
    expect(stats.totalCheckins.toNumber()).to.equal(0);
    expect(stats.uniqueAgents.toNumber()).to.equal(0);
  });

  it("rejects an empty name and a name longer than 32 bytes", async () => {
    const other = Keypair.generate();
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority,
        toPubkey: other.publicKey,
        lamports: LAMPORTS_PER_SOL,
      })
    );
    tx.recentBlockhash = context.lastBlockhash;
    tx.feePayer = authority;
    tx.sign(provider.wallet.payer);
    await context.banksClient.processTransaction(tx);

    try {
      await program.methods
        .registerAgent("", "https://example.com/x.json")
        .accounts({
          profile: profilePda(other.publicKey),
          stats: statsPda,
          authority: other.publicKey,
        })
        .signers([other])
        .rpc();
      expect.fail("expected EmptyName error");
    } catch (err) {
      expectAnchorError(err, "EmptyName", 6000);
    }

    try {
      await program.methods
        .registerAgent("a".repeat(33), "https://example.com/x.json")
        .accounts({
          profile: profilePda(other.publicKey),
          stats: statsPda,
          authority: other.publicKey,
        })
        .signers([other])
        .rpc();
      expect.fail("expected NameTooLong error");
    } catch (err) {
      expectAnchorError(err, "NameTooLong", 6001);
    }
  });

  it("checks in: streak starts at 1 and board stats move", async () => {
    await program.methods
      .checkIn()
      .accounts({ profile: profilePda(authority), stats: statsPda, authority })
      .rpc();

    const profile = await program.account.agentProfile.fetch(
      profilePda(authority)
    );
    expect(profile.checkinStreak).to.equal(1);
    expect(profile.bestStreak).to.equal(1);
    expect(profile.totalCheckins).to.equal(1);
    expect(profile.lastCheckinDay.toNumber()).to.be.greaterThan(0);

    const stats = await program.account.boardStats.fetch(statsPda);
    expect(stats.totalCheckins.toNumber()).to.equal(1);
    expect(stats.uniqueAgents.toNumber()).to.equal(1);
  });

  it("rejects a second check-in on the same UTC day", async () => {
    try {
      await program.methods
        .checkIn()
        .accounts({
          profile: profilePda(authority),
          stats: statsPda,
          authority,
        })
        .rpc();
      expect.fail("expected AlreadyCheckedInToday error");
    } catch (err) {
      expectAnchorError(err, "AlreadyCheckedInToday", 6003);
    }

    const stats = await program.account.boardStats.fetch(statsPda);
    expect(stats.totalCheckins.toNumber()).to.equal(1);
  });

  it("extends the streak on the next UTC day", async () => {
    await warpDays(1n);
    await program.methods
      .checkIn()
      .accounts({ profile: profilePda(authority), stats: statsPda, authority })
      .rpc();

    const profile = await program.account.agentProfile.fetch(
      profilePda(authority)
    );
    expect(profile.checkinStreak).to.equal(2);
    expect(profile.bestStreak).to.equal(2);
    expect(profile.totalCheckins).to.equal(2);

    const stats = await program.account.boardStats.fetch(statsPda);
    expect(stats.totalCheckins.toNumber()).to.equal(2);
    // Repeat check-ins by the same agent must not inflate unique_agents.
    expect(stats.uniqueAgents.toNumber()).to.equal(1);
  });

  it("resets the streak after a missed day, keeping best streak", async () => {
    await warpDays(2n); // skip one full day
    await program.methods
      .checkIn()
      .accounts({ profile: profilePda(authority), stats: statsPda, authority })
      .rpc();

    const profile = await program.account.agentProfile.fetch(
      profilePda(authority)
    );
    expect(profile.checkinStreak).to.equal(1);
    expect(profile.bestStreak).to.equal(2);
    expect(profile.totalCheckins).to.equal(3);
  });

  it("registers and checks in a second agent; unique count follows", async () => {
    await program.methods
      .registerAgent("agent-b", "https://example.com/b.json")
      .accounts({
        profile: profilePda(agentB.publicKey),
        stats: statsPda,
        authority: agentB.publicKey,
      })
      .signers([agentB])
      .rpc();

    await program.methods
      .checkIn()
      .accounts({
        profile: profilePda(agentB.publicKey),
        stats: statsPda,
        authority: agentB.publicKey,
      })
      .signers([agentB])
      .rpc();

    const stats = await program.account.boardStats.fetch(statsPda);
    expect(stats.totalAgents.toNumber()).to.equal(2);
    expect(stats.totalCheckins.toNumber()).to.equal(4);
    expect(stats.uniqueAgents.toNumber()).to.equal(2);
  });

  it("updates the caller's own profile without touching counters", async () => {
    await program.methods
      .updateProfile("elsanani-prime", "https://example.com/new.json")
      .accounts({ profile: profilePda(authority), authority })
      .rpc();

    const profile = await program.account.agentProfile.fetch(
      profilePda(authority)
    );
    expect(profile.name).to.equal("elsanani-prime");
    expect(profile.metadataUri).to.equal("https://example.com/new.json");
    expect(profile.totalCheckins).to.equal(3);
    expect(profile.checkinStreak).to.equal(1);
  });
});
