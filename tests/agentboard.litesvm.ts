import { Clock, FailedTransactionMetadata, LiteSVM } from "litesvm";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  createTransactionMessage,
  generateKeyPairSigner,
  lamports,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { BorshAccountsCoder, BorshInstructionCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import * as fs from "fs";
import { fileURLToPath } from "url";

// LiteSVM suite: executes the canonical Anchor-built program
// (target/deploy/agentboard.so, SBPFv3) in the LiteSVM in-process VM.
// Used because in this sandbox (a) solana-test-validator (Agave 4.4.1)
// panics on an io_uring assertion in solana-accounts-db, and
// (b) solana-bankrun's bundled solana-program-test 1.18 runtime rejects
// the modern ELF ("Program is not deployed"). The canonical validator
// suite remains tests/agentboard.ts (`anchor test`); a bankrun variant
// is in tests/agentboard.bankrun.ts.
const idl = JSON.parse(
  fs.readFileSync(
    new URL("../target/idl/agentboard.json", import.meta.url),
    "utf8"
  )
);

const PROGRAM_ID_STR = "2iPfRiccKppYcNzZb15b68ydZdjDh2oDM5HUH5BpNHRz";
const PROGRAM_ID = address(PROGRAM_ID_STR);
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const SO_PATH = fileURLToPath(
  new URL("../target/deploy/agentboard.so", import.meta.url)
);
const DAY_SECONDS = 86_400n;
const SOL = 1_000_000_000n;

describe("agentboard (litesvm)", () => {
  const svm = new LiteSVM();
  const ixCoder = new BorshInstructionCoder(idl);
  const accountsCoder = new BorshAccountsCoder(idl);

  let agentA: TransactionSigner; // funded fee payer / first agent
  let agentB: TransactionSigner;

  const pda = (seeds: (Buffer | Uint8Array)[]): Address => {
    const [pk] = PublicKey.findProgramAddressSync(
      seeds.map((s) => Buffer.from(s)),
      new PublicKey(PROGRAM_ID_STR)
    );
    return address(pk.toBase58());
  };
  const profilePda = (auth: Address) =>
    pda([Buffer.from("agent"), Buffer.from(new PublicKey(auth).toBuffer())]);
  const statsPda = pda([Buffer.from("stats")]);

  function programIx(
    name: string,
    args: any,
    accounts: { address: Address; role: AccountRole; signer?: TransactionSigner }[]
  ): Instruction {
    return {
      programAddress: PROGRAM_ID,
      accounts: accounts.map((a) =>
        a.signer
          ? { address: a.address, role: a.role, signer: a.signer }
          : { address: a.address, role: a.role }
      ) as any,
      data: ixCoder.encode(name, args),
    };
  }

  async function send(ixs: Instruction[], feePayer: TransactionSigner) {
    // LiteSVM's blockhash only changes when expired/warped; without this,
    // resending an identical instruction would collide with the previous
    // signature and fail as AlreadyProcessed instead of executing.
    svm.expireBlockhash();
    let msg = createTransactionMessage({ version: 0 });
    msg = setTransactionMessageFeePayerSigner(feePayer, msg);
    msg = setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1000n },
      msg
    );
    for (const ix of ixs) msg = appendTransactionMessageInstruction(ix, msg);
    const signed = await signTransactionMessageWithSigners(msg);
    return svm.sendTransaction(signed);
  }

  function expectSuccess(res: any) {
    if (res instanceof FailedTransactionMetadata) {
      throw new Error(
        `expected success, got error: ${res.err()} logs: ${res
          .meta()
          .logs()
          .join(" | ")}`
      );
    }
  }

  function expectCustomError(res: any, codeName: string, code: number) {
    expect(
      res instanceof FailedTransactionMetadata,
      `expected failed tx with ${codeName}`
    ).to.be.true;
    const failed = res as FailedTransactionMetadata;
    const errStr = JSON.stringify(failed.err());
    const logs = failed.meta().logs().join(" | ");
    expect(
      errStr.includes(`"Custom":${code}`) ||
        errStr.includes(`"Custom": ${code}`) ||
        logs.includes(codeName) ||
        logs.includes("0x" + code.toString(16)),
      `expected custom error ${code} (${codeName}); err=${errStr} logs=${logs.slice(0, 300)}`
    ).to.be.true;
  }

  function fetchAccount(name: string, addr: Address): any {
    const acc = svm.getAccount(addr);
    if (!("exists" in acc) || !(acc as any).exists) {
      // MaybeEncodedAccount: check via data presence
    }
    const data = (acc as any).data as Uint8Array | undefined;
    expect(data, `account ${name} at ${addr} should exist`).to.not.equal(
      undefined
    );
    return accountsCoder.decode(name, Buffer.from(data!));
  }

  function warpDays(days: bigint) {
    const clock = svm.getClock();
    svm.setClock(
      new Clock(
        clock.slot,
        clock.epochStartTimestamp,
        clock.epoch,
        clock.leaderScheduleEpoch,
        clock.unixTimestamp + days * DAY_SECONDS
      )
    );
  }

  before(async () => {
    svm.addProgramFromFile(PROGRAM_ID, SO_PATH);
    agentA = await generateKeyPairSigner();
    agentB = await generateKeyPairSigner();
    expectSuccess(svm.airdrop(agentA.address, lamports(10n * SOL)));
    // Fund agent B with a plain SOL transfer from A.
    const transfer = getTransferSolInstruction({
      source: agentA,
      destination: agentB.address,
      amount: lamports(2n * SOL),
    });
    expectSuccess(await send([transfer as unknown as Instruction], agentA));
    expect(fs.existsSync(SO_PATH)).to.be.true;
  });

  it("registers the first agent and initializes board stats", async () => {
    const res = await send(
      [
        programIx(
          "register_agent",
          { name: "elsanani", metadata_uri: "https://example.com/elsanani.json" },
          [
            { address: profilePda(agentA.address), role: AccountRole.WRITABLE },
            { address: statsPda, role: AccountRole.WRITABLE },
            {
              address: agentA.address,
              role: AccountRole.WRITABLE_SIGNER,
              signer: agentA,
            },
            { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
          ]
        ),
      ],
      agentA
    );
    expectSuccess(res);

    const profile = fetchAccount("AgentProfile", profilePda(agentA.address));
    expect(profile.authority.toBase58()).to.equal(agentA.address);
    expect(profile.name).to.equal("elsanani");
    expect(profile.checkin_streak).to.equal(0);
    expect(profile.total_checkins).to.equal(0);
    expect(profile.last_checkin_day.toNumber()).to.equal(-1);

    const stats = fetchAccount("BoardStats", statsPda);
    expect(stats.total_agents.toNumber()).to.equal(1);
    expect(stats.total_checkins.toNumber()).to.equal(0);
    expect(stats.unique_agents.toNumber()).to.equal(0);
  });

  it("rejects an empty name and a name longer than 32 bytes", async () => {
    const mkIx = (name: string) =>
      programIx(
        "register_agent",
        { name, metadata_uri: "https://example.com/x.json" },
        [
          { address: profilePda(agentB.address), role: AccountRole.WRITABLE },
          { address: statsPda, role: AccountRole.WRITABLE },
          {
            address: agentB.address,
            role: AccountRole.WRITABLE_SIGNER,
            signer: agentB,
          },
          { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
        ]
      );

    expectCustomError(await send([mkIx("")], agentB), "EmptyName", 6000);
    expectCustomError(
      await send([mkIx("a".repeat(33))], agentB),
      "NameTooLong",
      6001
    );
  });

  it("checks in: streak starts at 1 and board stats move", async () => {
    const res = await send(
      [
        programIx("check_in", {}, [
          { address: profilePda(agentA.address), role: AccountRole.WRITABLE },
          { address: statsPda, role: AccountRole.WRITABLE },
          {
            address: agentA.address,
            role: AccountRole.WRITABLE_SIGNER,
            signer: agentA,
          },
        ]),
      ],
      agentA
    );
    expectSuccess(res);

    const profile = fetchAccount("AgentProfile", profilePda(agentA.address));
    expect(profile.checkin_streak).to.equal(1);
    expect(profile.best_streak).to.equal(1);
    expect(profile.total_checkins).to.equal(1);
    // LiteSVM boots with unixTimestamp = 0, so compare against the clock's
    // own day number rather than assuming a realistic timestamp.
    const clockDay = Number(svm.getClock().unixTimestamp / DAY_SECONDS);
    expect(profile.last_checkin_day.toNumber()).to.equal(clockDay);

    const stats = fetchAccount("BoardStats", statsPda);
    expect(stats.total_checkins.toNumber()).to.equal(1);
    expect(stats.unique_agents.toNumber()).to.equal(1);
  });

  it("rejects a second check-in on the same UTC day", async () => {
    const res = await send(
      [
        programIx("check_in", {}, [
          { address: profilePda(agentA.address), role: AccountRole.WRITABLE },
          { address: statsPda, role: AccountRole.WRITABLE },
          {
            address: agentA.address,
            role: AccountRole.WRITABLE_SIGNER,
            signer: agentA,
          },
        ]),
      ],
      agentA
    );
    expectCustomError(res, "AlreadyCheckedInToday", 6003);

    const stats = fetchAccount("BoardStats", statsPda);
    expect(stats.total_checkins.toNumber()).to.equal(1);
  });

  it("extends the streak on the next UTC day", async () => {
    warpDays(1n);
    const res = await send(
      [
        programIx("check_in", {}, [
          { address: profilePda(agentA.address), role: AccountRole.WRITABLE },
          { address: statsPda, role: AccountRole.WRITABLE },
          {
            address: agentA.address,
            role: AccountRole.WRITABLE_SIGNER,
            signer: agentA,
          },
        ]),
      ],
      agentA
    );
    expectSuccess(res);

    const profile = fetchAccount("AgentProfile", profilePda(agentA.address));
    expect(profile.checkin_streak).to.equal(2);
    expect(profile.best_streak).to.equal(2);
    expect(profile.total_checkins).to.equal(2);

    const stats = fetchAccount("BoardStats", statsPda);
    expect(stats.total_checkins.toNumber()).to.equal(2);
    expect(stats.unique_agents.toNumber()).to.equal(1);
  });

  it("resets the streak after a missed day, keeping best streak", async () => {
    warpDays(2n); // skip one full day
    const res = await send(
      [
        programIx("check_in", {}, [
          { address: profilePda(agentA.address), role: AccountRole.WRITABLE },
          { address: statsPda, role: AccountRole.WRITABLE },
          {
            address: agentA.address,
            role: AccountRole.WRITABLE_SIGNER,
            signer: agentA,
          },
        ]),
      ],
      agentA
    );
    expectSuccess(res);

    const profile = fetchAccount("AgentProfile", profilePda(agentA.address));
    expect(profile.checkin_streak).to.equal(1);
    expect(profile.best_streak).to.equal(2);
    expect(profile.total_checkins).to.equal(3);
  });

  it("registers and checks in a second agent; unique count follows", async () => {
    expectSuccess(
      await send(
        [
          programIx(
            "register_agent",
            { name: "agent-b", metadata_uri: "https://example.com/b.json" },
            [
              { address: profilePda(agentB.address), role: AccountRole.WRITABLE },
              { address: statsPda, role: AccountRole.WRITABLE },
              {
                address: agentB.address,
                role: AccountRole.WRITABLE_SIGNER,
                signer: agentB,
              },
              { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
            ]
          ),
        ],
        agentB
      )
    );

    expectSuccess(
      await send(
        [
          programIx("check_in", {}, [
            { address: profilePda(agentB.address), role: AccountRole.WRITABLE },
            { address: statsPda, role: AccountRole.WRITABLE },
            {
              address: agentB.address,
              role: AccountRole.WRITABLE_SIGNER,
              signer: agentB,
            },
          ]),
        ],
        agentB
      )
    );

    const stats = fetchAccount("BoardStats", statsPda);
    expect(stats.total_agents.toNumber()).to.equal(2);
    expect(stats.total_checkins.toNumber()).to.equal(4);
    expect(stats.unique_agents.toNumber()).to.equal(2);
  });

  it("updates the caller's own profile without touching counters", async () => {
    const res = await send(
      [
        programIx(
          "update_profile",
          {
            name: "elsanani-prime",
            metadata_uri: "https://example.com/new.json",
          },
          [
            { address: profilePda(agentA.address), role: AccountRole.WRITABLE },
            {
              address: agentA.address,
              role: AccountRole.WRITABLE_SIGNER,
              signer: agentA,
            },
          ]
        ),
      ],
      agentA
    );
    expectSuccess(res);

    const profile = fetchAccount("AgentProfile", profilePda(agentA.address));
    expect(profile.name).to.equal("elsanani-prime");
    expect(profile.metadata_uri).to.equal("https://example.com/new.json");
    expect(profile.total_checkins).to.equal(3);
    expect(profile.checkin_streak).to.equal(1);
  });
});
