/**
 * AgentBoard — end-to-end demo script.
 *
 * Runs the full demo flow against a target cluster:
 *   1. Read BoardStats (created lazily by the first register_agent call —
 *      the program uses init_if_needed for the stats PDA).
 *   2. Register two demo agents.
 *   3. Check both agents in.
 *   4. Attempt a second check-in for agent #1 on the same UTC day and
 *      verify the program rejects it with AlreadyCheckedInToday (6003).
 *   5. Print the leaderboard, read back from on-chain AgentProfile
 *      accounts, sorted by streak, then total check-ins, then best streak.
 *
 * Targets:
 *   - litesvm (default): fully local, in-process LiteSVM running the
 *     Anchor-built program (target/deploy/agentboard.so). No network.
 *   - devnet: talks to Solana devnet via the Anchor client. Requires the
 *     program to be deployed and the project deployer keypair
 *     (../deployer-keypair.json) to hold devnet SOL; the deployer funds
 *     two persistent demo keypairs (scripts/demo-keypairs.json).
 *
 * Usage:
 *   npm run demo                 # local LiteSVM demo
 *   npm run demo:devnet          # devnet demo
 *   node scripts/demo.ts --cluster devnet --rpc https://api.devnet.solana.com
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PROGRAM_ID_STR = "2iPfRiccKppYcNzZb15b68ydZdjDh2oDM5HUH5BpNHRz";
const ALREADY_CHECKED_IN = 6003;

const DEMO_AGENTS = [
  { name: "elsanani", metadataUri: "https://example.com/agents/elsanani.json" },
  { name: "agent-bravo", metadataUri: "https://example.com/agents/bravo.json" },
];

interface AgentView {
  name: string;
  authority: string;
  metadataUri: string;
  streak: number;
  bestStreak: number;
  totalCheckins: number;
  lastCheckinDay: number;
}

interface StatsView {
  totalAgents: number;
  totalCheckins: number;
  uniqueAgents: number;
}

/** Backend abstraction so the same demo flow runs on LiteSVM and devnet. */
interface Backend {
  label: string;
  /** Returns null when the stats account does not exist yet. */
  fetchStats(): Promise<StatsView | null>;
  fetchProfile(authority: string): Promise<AgentView | null>;
  fetchAllProfiles(): Promise<AgentView[]>;
  /** Resolves to the authority (base58) of demo agent `index`. */
  agentAuthority(index: number): Promise<string>;
  register(index: number): Promise<string>; // returns tx signature / marker
  checkIn(index: number): Promise<string>;
}

function printLeaderboard(agents: AgentView[], stats: StatsView | null) {
  const sorted = [...agents].sort(
    (a, b) =>
      b.streak - a.streak ||
      b.totalCheckins - a.totalCheckins ||
      b.bestStreak - a.bestStreak ||
      a.name.localeCompare(b.name)
  );
  console.log("\n=== AgentBoard leaderboard ===");
  if (stats) {
    console.log(
      `Board: ${stats.totalAgents} agents · ${stats.totalCheckins} check-ins · ${stats.uniqueAgents} unique agents`
    );
  }
  console.log(
    "rank  name            streak  best  total  last-day   authority"
  );
  sorted.forEach((a, i) => {
    console.log(
      `${String(i + 1).padEnd(5)} ${a.name.padEnd(15)} ${String(a.streak).padEnd(
        7
      )} ${String(a.bestStreak).padEnd(5)} ${String(a.totalCheckins).padEnd(
        6
      )} ${String(a.lastCheckinDay).padEnd(10)} ${a.authority}`
    );
  });
  if (sorted.length === 0) console.log("(no agents registered yet)");
}

async function runDemo(backend: Backend) {
  console.log(`\n### AgentBoard demo — target: ${backend.label}`);
  console.log(`Program: ${PROGRAM_ID_STR}`);

  let stats = await backend.fetchStats();
  console.log(
    stats
      ? `BoardStats already initialized: ${stats.totalAgents} agents, ${stats.totalCheckins} check-ins.`
      : "BoardStats not initialized yet — the first register_agent call will create it (init_if_needed)."
  );

  for (let i = 0; i < DEMO_AGENTS.length; i++) {
    const authority = await backend.agentAuthority(i);
    const existing = await backend.fetchProfile(authority);
    if (existing) {
      console.log(
        `Agent #${i + 1} "${existing.name}" already registered (${authority}).`
      );
    } else {
      const sig = await backend.register(i);
      console.log(
        `Registered agent #${i + 1} "${DEMO_AGENTS[i].name}" (${authority}) — ${sig}`
      );
    }
  }

  stats = await backend.fetchStats();
  if (!stats) throw new Error("BoardStats missing after registration");

  // Check both agents in. If an agent already checked in today (e.g. a
  // repeat devnet run), the first attempt itself proves the daily gate.
  let duplicateProven = false;
  for (let i = 0; i < DEMO_AGENTS.length; i++) {
    try {
      const sig = await backend.checkIn(i);
      console.log(`Check-in agent #${i + 1} — ${sig}`);
    } catch (err: any) {
      if (err && err.code === ALREADY_CHECKED_IN) {
        console.log(
          `Check-in agent #${i + 1}: rejected with AlreadyCheckedInToday (agent had already checked in today).`
        );
        if (i === 0) duplicateProven = true;
      } else {
        throw err;
      }
    }
  }

  if (!duplicateProven) {
    // The core demo beat: a second check-in on the same UTC day must fail.
    try {
      await backend.checkIn(0);
      throw new Error(
        "DEMO FAILED: duplicate same-day check-in unexpectedly succeeded"
      );
    } catch (err: any) {
      if (err && err.code === ALREADY_CHECKED_IN) {
        console.log(
          "Duplicate check-in agent #1: correctly rejected with AlreadyCheckedInToday (error 6003). ✔"
        );
        duplicateProven = true;
      } else {
        throw err;
      }
    }
  }

  const agents = await backend.fetchAllProfiles();
  stats = await backend.fetchStats();
  printLeaderboard(agents, stats);
  console.log("\nDemo completed successfully. ✔");
}

/* ------------------------------------------------------------------ */
/* LiteSVM backend (local, default)                                    */
/* ------------------------------------------------------------------ */

async function makeLitesvmBackend(): Promise<Backend> {
  const { LiteSVM, FailedTransactionMetadata } = await import("litesvm");
  const kit = await import("@solana/kit");
  const { getTransferSolInstruction } = await import(
    "@solana-program/system"
  );
  const { BorshAccountsCoder, BorshInstructionCoder } = await import(
    "@coral-xyz/anchor"
  );
  const { PublicKey } = await import("@solana/web3.js");

  const idl = JSON.parse(
    fs.readFileSync(path.join(ROOT, "target/idl/agentboard.json"), "utf8")
  );
  const ixCoder = new BorshInstructionCoder(idl);
  const accountsCoder = new BorshAccountsCoder(idl);

  const svm = new LiteSVM();
  svm.addProgramFromFile(
    kit.address(PROGRAM_ID_STR),
    path.join(ROOT, "target/deploy/agentboard.so")
  );

  const SYSTEM_PROGRAM = kit.address("11111111111111111111111111111111");
  const SOL = 1_000_000_000n;

  const pda = (seeds: Buffer[]): string => {
    const [pk] = PublicKey.findProgramAddressSync(
      seeds,
      new PublicKey(PROGRAM_ID_STR)
    );
    return pk.toBase58();
  };
  const profilePda = (auth: string) =>
    pda([Buffer.from("agent"), Buffer.from(new PublicKey(auth).toBuffer())]);
  const statsPda = pda([Buffer.from("stats")]);

  const signers: any[] = [];
  async function ensureSigners() {
    if (signers.length) return;
    const funder = await kit.generateKeyPairSigner();
    const a = await kit.generateKeyPairSigner();
    const b = await kit.generateKeyPairSigner();
    svm.airdrop(funder.address, kit.lamports(20n * SOL));
    signers.push(a, b);
    for (const s of [a, b]) {
      const transfer = getTransferSolInstruction({
        source: funder,
        destination: s.address,
        amount: kit.lamports(2n * SOL),
      });
      await send([transfer as any], funder);
    }
  }

  async function send(ixs: any[], feePayer: any) {
    svm.expireBlockhash(); // LiteSVM blockhash is static otherwise -> AlreadyProcessed
    let msg = kit.createTransactionMessage({ version: 0 });
    msg = kit.setTransactionMessageFeePayerSigner(feePayer, msg);
    msg = kit.setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1000n },
      msg
    );
    for (const ix of ixs) msg = kit.appendTransactionMessageInstruction(ix, msg);
    const signed = await kit.signTransactionMessageWithSigners(msg);
    const res = svm.sendTransaction(signed);
    if (res instanceof FailedTransactionMetadata) {
      const errObj: any = res.err();
      const logs = res.meta().logs().join("\n");
      const m = logs.match(/custom program error: 0x([0-9a-f]+)/i);
      const e: any = new Error(
        `transaction failed: ${JSON.stringify(errObj)} logs: ${logs.slice(0, 400)}`
      );
      if (m) e.code = parseInt(m[1], 16);
      if (errObj && typeof errObj === "object" && "InstructionError" in errObj) {
        const ie: any = (errObj as any).InstructionError;
        if (ie && ie[1] && typeof ie[1] === "object" && "Custom" in ie[1])
          e.code = ie[1].Custom;
      }
      throw e;
    }
    return "litesvm-tx-ok";
  }

  function programIx(name: string, args: any, accounts: any[], signer: any) {
    return {
      programAddress: kit.address(PROGRAM_ID_STR),
      accounts: accounts.map((a: any) => ({
        address: kit.address(a.address),
        role: a.role,
        ...(a.signer ? { signer } : {}),
      })),
      data: ixCoder.encode(name, args),
    };
  }

  function decodeAccount(name: string, addr: string): any | null {
    const acc: any = svm.getAccount(kit.address(addr));
    const data = acc && acc.data ? acc.data : undefined;
    if (!data || data.length === 0) return null;
    try {
      return accountsCoder.decode(name, Buffer.from(data));
    } catch {
      return null;
    }
  }

  const toView = (p: any): AgentView => ({
    name: p.name,
    authority: p.authority.toBase58(),
    metadataUri: p.metadata_uri,
    streak: p.checkin_streak,
    bestStreak: p.best_streak,
    totalCheckins: p.total_checkins,
    lastCheckinDay: p.last_checkin_day.toNumber(),
  });

  return {
    label: "LiteSVM (local, in-process)",
    async agentAuthority(i: number) {
      await ensureSigners();
      return signers[i].address as string;
    },
    async fetchStats() {
      const s = decodeAccount("BoardStats", statsPda);
      if (!s) return null;
      return {
        totalAgents: s.total_agents.toNumber(),
        totalCheckins: s.total_checkins.toNumber(),
        uniqueAgents: s.unique_agents.toNumber(),
      };
    },
    async fetchProfile(authority: string) {
      const p = decodeAccount("AgentProfile", profilePda(authority));
      return p ? toView(p) : null;
    },
    async fetchAllProfiles() {
      await ensureSigners();
      const out: AgentView[] = [];
      for (const s of signers) {
        const v = await this.fetchProfile(s.address as string);
        if (v) out.push(v);
      }
      return out;
    },
    async register(i: number) {
      await ensureSigners();
      const signer = signers[i];
      return send(
        [
          programIx(
            "register_agent",
            {
              name: DEMO_AGENTS[i].name,
              metadata_uri: DEMO_AGENTS[i].metadataUri,
            },
            [
              { address: profilePda(signer.address), role: kit.AccountRole.WRITABLE },
              { address: statsPda, role: kit.AccountRole.WRITABLE },
              {
                address: signer.address,
                role: kit.AccountRole.WRITABLE_SIGNER,
                signer: true,
              },
              { address: SYSTEM_PROGRAM, role: kit.AccountRole.READONLY },
            ],
            signer
          ),
        ],
        signer
      );
    },
    async checkIn(i: number) {
      await ensureSigners();
      const signer = signers[i];
      return send(
        [
          programIx(
            "check_in",
            {},
            [
              { address: profilePda(signer.address), role: kit.AccountRole.WRITABLE },
              { address: statsPda, role: kit.AccountRole.WRITABLE },
              {
                address: signer.address,
                role: kit.AccountRole.WRITABLE_SIGNER,
                signer: true,
              },
            ],
            signer
          ),
        ],
        signer
      );
    },
  };
}

/* ------------------------------------------------------------------ */
/* Devnet backend                                                      */
/* ------------------------------------------------------------------ */

async function makeDevnetBackend(rpcUrl?: string): Promise<Backend> {
  const anchor = await import("@coral-xyz/anchor");
  const { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } =
    await import("@solana/web3.js");

  const idl = JSON.parse(
    fs.readFileSync(path.join(ROOT, "target/idl/agentboard.json"), "utf8")
  );
  const deployerSecret = JSON.parse(
    fs.readFileSync(path.join(ROOT, "deployer-keypair.json"), "utf8")
  );
  const deployer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));

  const connection = new Connection(
    rpcUrl || "https://api.devnet.solana.com",
    "confirmed"
  );
  const wallet = new anchor.Wallet(deployer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const program: any = new anchor.Program(idl, provider);

  // Persistent demo keypairs (devnet only, funded by the deployer).
  const kpFile = path.join(HERE, "demo-keypairs.json");
  let demoKps: any[];
  if (fs.existsSync(kpFile)) {
    const secrets = JSON.parse(fs.readFileSync(kpFile, "utf8"));
    demoKps = secrets.map((s: number[]) =>
      Keypair.fromSecretKey(Uint8Array.from(s))
    );
  } else {
    demoKps = DEMO_AGENTS.map(() => Keypair.generate());
    fs.writeFileSync(
      kpFile,
      JSON.stringify(demoKps.map((k) => Array.from(k.secretKey))),
      { mode: 0o600 }
    );
  }

  const profilePda = (auth: any) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), auth.toBuffer()],
      program.programId
    )[0];
  const statsPda = PublicKey.findProgramAddressSync(
    [Buffer.from("stats")],
    program.programId
  )[0];

  async function ensureFunded(i: number) {
    const kp = demoKps[i];
    const bal = await connection.getBalance(kp.publicKey);
    if (bal >= 0.02 * LAMPORTS_PER_SOL) return;
    const deployerBal = await connection.getBalance(deployer.publicKey);
    if (deployerBal < 0.06 * LAMPORTS_PER_SOL) {
      throw new Error(
        `Deployer ${deployer.publicKey.toBase58()} has only ${
          deployerBal / LAMPORTS_PER_SOL
        } devnet SOL — cannot fund demo agents. Run the airdrop first.`
      );
    }
    const tx = new (await import("@solana/web3.js")).Transaction().add(
      SystemProgram.transfer({
        fromPubkey: deployer.publicKey,
        toPubkey: kp.publicKey,
        lamports: 0.05 * LAMPORTS_PER_SOL,
      })
    );
    const sig = await connection.sendTransaction(tx, [deployer]);
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`Funded demo agent #${i + 1} with 0.05 devnet SOL — ${sig}`);
  }

  const toView = (p: any): AgentView => ({
    name: p.name,
    authority: p.authority.toBase58(),
    metadataUri: p.metadataUri,
    streak: p.checkinStreak,
    bestStreak: p.bestStreak,
    totalCheckins: p.totalCheckins,
    lastCheckinDay: p.lastCheckinDay.toNumber(),
  });

  const wrapErr = (err: any) => {
    const code =
      err?.error?.errorCode?.number ??
      (typeof err?.message === "string" &&
      err.message.includes("AlreadyCheckedInToday")
        ? ALREADY_CHECKED_IN
        : undefined);
    if (code !== undefined) {
      const e: any = new Error(err.message || `program error ${code}`);
      e.code = code;
      return e;
    }
    return err;
  };

  return {
    label: `devnet (${rpcUrl || "https://api.devnet.solana.com"})`,
    async agentAuthority(i: number) {
      return demoKps[i].publicKey.toBase58();
    },
    async fetchStats() {
      try {
        const s = await program.account.boardStats.fetch(statsPda);
        return {
          totalAgents: s.totalAgents.toNumber(),
          totalCheckins: s.totalCheckins.toNumber(),
          uniqueAgents: s.uniqueAgents.toNumber(),
        };
      } catch {
        return null;
      }
    },
    async fetchProfile(authority: string) {
      try {
        const p = await program.account.agentProfile.fetch(
          profilePda(new PublicKey(authority))
        );
        return toView(p);
      } catch {
        return null;
      }
    },
    async fetchAllProfiles() {
      const all = await program.account.agentProfile.all();
      return all.map((a: any) => toView(a.account));
    },
    async register(i: number) {
      await ensureFunded(i);
      const kp = demoKps[i];
      try {
        return await program.methods
          .registerAgent(DEMO_AGENTS[i].name, DEMO_AGENTS[i].metadataUri)
          .accounts({
            profile: profilePda(kp.publicKey),
            stats: statsPda,
            authority: kp.publicKey,
          })
          .signers([kp])
          .rpc();
      } catch (err) {
        throw wrapErr(err);
      }
    },
    async checkIn(i: number) {
      await ensureFunded(i);
      const kp = demoKps[i];
      try {
        return await program.methods
          .checkIn()
          .accounts({
            profile: profilePda(kp.publicKey),
            stats: statsPda,
            authority: kp.publicKey,
          })
          .signers([kp])
          .rpc();
      } catch (err) {
        throw wrapErr(err);
      }
    },
  };
}

/* ------------------------------------------------------------------ */

async function main() {
  const args = process.argv.slice(2);
  const clusterFlag = args.indexOf("--cluster");
  const cluster =
    (clusterFlag >= 0 ? args[clusterFlag + 1] : undefined) ||
    process.env.CLUSTER ||
    "litesvm";
  const rpcFlag = args.indexOf("--rpc");
  const rpc = rpcFlag >= 0 ? args[rpcFlag + 1] : process.env.RPC_URL;

  const backend =
    cluster === "devnet"
      ? await makeDevnetBackend(rpc)
      : await makeLitesvmBackend();
  await runDemo(backend);
}

main().catch((err) => {
  console.error("\nDemo failed:", err?.message || err);
  process.exit(1);
});
