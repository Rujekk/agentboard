/**
 * AgentBoard — TypeScript client stub.
 *
 * Day 1: wire register/check-in against devnet.
 * Day 2: add the Supabase indexer (see src/indexer.ts, to be created) and
 *        the web directory UI.
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";

// Program id synced via `anchor keys sync` (deploy in phase 2).
export const PROGRAM_ID = new PublicKey(
  "2iPfRiccKppYcNzZb15b68ydZdjDh2oDM5HUH5BpNHRz"
);

export function getConnection(): Connection {
  return new Connection(clusterApiUrl("devnet"), "confirmed");
}

/** PDA of an agent profile for a given authority wallet. */
export function profilePda(authority: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), authority.toBuffer()],
    PROGRAM_ID
  )[0];
}

/** PDA of the global board stats account. */
export function statsPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("stats")], PROGRAM_ID)[0];
}

async function main() {
  const connection = getConnection();
  const slot = await connection.getSlot();
  console.log(`AgentBoard client stub — connected to devnet at slot ${slot}`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  // TODO(day1): load wallet, build Anchor provider + program from IDL,
  //             call registerAgent(name, metadataUri) then checkIn().
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
