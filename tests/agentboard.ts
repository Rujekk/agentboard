import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Agentboard } from "../target/types/agentboard";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";

describe("agentboard", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.agentboard as Program<Agentboard>;
  const authority = provider.wallet as anchor.Wallet;

  const profilePda = (auth: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), auth.toBuffer()],
      program.programId
    )[0];

  const statsPda = PublicKey.findProgramAddressSync(
    [Buffer.from("stats")],
    program.programId
  )[0];

  const agentB = Keypair.generate();

  async function airdrop(to: PublicKey, sol: number) {
    const sig = await provider.connection.requestAirdrop(
      to,
      sol * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");
  }

  it("registers the first agent and initializes board stats", async () => {
    await program.methods
      .registerAgent("elsanani", "https://example.com/elsanani.json")
      .accounts({
        profile: profilePda(authority.publicKey),
        stats: statsPda,
        authority: authority.publicKey,
      })
      .rpc();

    const profile = await program.account.agentProfile.fetch(
      profilePda(authority.publicKey)
    );
    expect(profile.authority.toBase58()).to.equal(
      authority.publicKey.toBase58()
    );
    expect(profile.name).to.equal("elsanani");
    expect(profile.checkinStreak).to.equal(0);
    expect(profile.totalCheckins).to.equal(0);
    expect(profile.lastCheckinDay.toNumber()).to.equal(-1);

    const stats = await program.account.boardStats.fetch(statsPda);
    expect(stats.totalAgents.toNumber()).to.equal(1);
    expect(stats.totalCheckins.toNumber()).to.equal(0);
    expect(stats.uniqueAgents.toNumber()).to.equal(0);
  });

  it("rejects a name longer than 32 bytes", async () => {
    const other = Keypair.generate();
    await airdrop(other.publicKey, 1);
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
      expect(err.error.errorCode.code).to.equal("NameTooLong");
    }
  });

  it("checks in: streak starts at 1 and board stats move", async () => {
    await program.methods
      .checkIn()
      .accounts({
        profile: profilePda(authority.publicKey),
        stats: statsPda,
        authority: authority.publicKey,
      })
      .rpc();

    const profile = await program.account.agentProfile.fetch(
      profilePda(authority.publicKey)
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
          profile: profilePda(authority.publicKey),
          stats: statsPda,
          authority: authority.publicKey,
        })
        .rpc();
      expect.fail("expected AlreadyCheckedInToday error");
    } catch (err) {
      expect(err.error.errorCode.code).to.equal("AlreadyCheckedInToday");
    }

    // Counters must be untouched by the rejected repeat.
    const stats = await program.account.boardStats.fetch(statsPda);
    expect(stats.totalCheckins.toNumber()).to.equal(1);
  });

  it("registers and checks in a second agent; unique count follows", async () => {
    await airdrop(agentB.publicKey, 1);

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
    expect(stats.totalCheckins.toNumber()).to.equal(2);
    expect(stats.uniqueAgents.toNumber()).to.equal(2);
  });

  it("updates the caller's own profile", async () => {
    await program.methods
      .updateProfile("elsanani-prime", "https://example.com/new.json")
      .accounts({
        profile: profilePda(authority.publicKey),
        authority: authority.publicKey,
      })
      .rpc();

    const profile = await program.account.agentProfile.fetch(
      profilePda(authority.publicKey)
    );
    expect(profile.name).to.equal("elsanani-prime");
    expect(profile.metadataUri).to.equal("https://example.com/new.json");
    // Check-in history must survive a profile update.
    expect(profile.totalCheckins).to.equal(1);
    expect(profile.checkinStreak).to.equal(1);
  });
});
