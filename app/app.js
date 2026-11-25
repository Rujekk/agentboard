/* AgentBoard web directory — reads the leaderboard straight from chain.
 *
 * No build step and no backend: @solana/web3.js (CDN) fetches every account
 * owned by the program with getProgramAccounts, accounts are split by the
 * discriminators from the generated IDL (./idl.json, copied from
 * target/idl/agentboard.json), and account bytes are decoded with a small
 * Borsh reader driven by the IDL's own type definitions.
 */
(function () {
  const { Connection, PublicKey } = window.solanaWeb3;

  const $ = (id) => document.getElementById(id);
  const status = (msg) => ($("status").textContent = msg);

  /* ---------- tiny Borsh reader (subset used by this program) -------- */
  function Reader(buf) {
    this.buf = buf;
    this.off = 0;
  }
  Reader.prototype.u8 = function () {
    const v = this.buf[this.off];
    this.off += 1;
    return v;
  };
  Reader.prototype.u32 = function () {
    const v = new DataView(
      this.buf.buffer,
      this.buf.byteOffset + this.off,
      4
    ).getUint32(0, true);
    this.off += 4;
    return v;
  };
  Reader.prototype.u64 = function () {
    const lo = BigInt(this.u32());
    const hi = BigInt(this.u32());
    return Number(lo + (hi << 32n));
  };
  Reader.prototype.i64 = function () {
    const lo = BigInt(this.u32());
    const hi = BigInt(this.u32());
    const v = lo + (hi << 32n);
    return Number(v >= 1n << 63n ? v - (1n << 64n) : v);
  };
  Reader.prototype.string = function () {
    const len = this.u32();
    const bytes = this.buf.slice(this.off, this.off + len);
    this.off += len;
    return new TextDecoder().decode(bytes);
  };
  Reader.prototype.pubkey = function () {
    const bytes = this.buf.slice(this.off, this.off + 32);
    this.off += 32;
    return new PublicKey(bytes).toBase58();
  };
  Reader.prototype.read = function (type) {
    switch (type) {
      case "u8":
        return this.u8();
      case "u32":
        return this.u32();
      case "u64":
        return this.u64();
      case "i64":
        return this.i64();
      case "string":
        return this.string();
      case "pubkey":
        return this.pubkey();
      default:
        throw new Error("unsupported IDL type: " + type);
    }
  };

  function decodeByIdl(idl, typeName, data) {
    const t = (idl.types || []).find((x) => x.name === typeName);
    if (!t || !t.type || t.type.kind !== "struct")
      throw new Error("type not found in IDL: " + typeName);
    const r = new Reader(data.slice(8)); // skip 8-byte discriminator
    const out = {};
    for (const f of t.type.fields) out[f.name] = r.read(f.type);
    return out;
  }

  function discMatches(idl, accountName, data) {
    const acc = (idl.accounts || []).find((x) => x.name === accountName);
    if (!acc || !acc.discriminator) return false;
    return acc.discriminator.every((b, i) => data[i] === b);
  }

  /* ------------------------------- load ------------------------------ */
  let idl = null;

  async function load() {
    const cluster = $("cluster").value;
    $("refresh").disabled = true;
    status("loading from " + cluster + " …");
    try {
      if (!idl) {
        const res = await fetch("./idl.json");
        idl = await res.json();
      }
      const programId = new PublicKey(idl.address);
      $("program-id").textContent = idl.address;
      const clusterParam = cluster.includes("devnet")
        ? "?cluster=devnet"
        : cluster.includes("testnet")
        ? "?cluster=testnet"
        : "";
      $("explorer").href =
        "https://explorer.solana.com/address/" + idl.address + clusterParam;

      const conn = new Connection(cluster, "confirmed");
      const programInfo = await conn.getAccountInfo(programId);
      if (!programInfo) {
        status(
          "Program is not deployed on this cluster yet — deploy it with `anchor deploy` and refresh."
        );
        $("rows").innerHTML =
          '<tr><td colspan="6">No on-chain data yet.</td></tr>';
        return;
      }

      const accounts = await conn.getProgramAccounts(programId);
      const profiles = [];
      let stats = null;
      for (const { account } of accounts) {
        const data = account.data;
        if (discMatches(idl, "AgentProfile", data)) {
          profiles.push(decodeByIdl(idl, "AgentProfile", data));
        } else if (discMatches(idl, "BoardStats", data)) {
          stats = decodeByIdl(idl, "BoardStats", data);
        }
      }

      profiles.sort(
        (a, b) =>
          b.checkin_streak - a.checkin_streak ||
          b.total_checkins - a.total_checkins ||
          b.best_streak - a.best_streak ||
          a.name.localeCompare(b.name)
      );

      $("stat-agents").textContent = stats ? stats.total_agents : "0";
      $("stat-checkins").textContent = stats ? stats.total_checkins : "0";
      $("stat-unique").textContent = stats ? stats.unique_agents : "0";

      $("rows").innerHTML =
        profiles.length === 0
          ? '<tr><td colspan="6">No agents registered yet — run <span class="mono">npm run demo:devnet</span>.</td></tr>'
          : profiles
              .map(
                (p, i) =>
                  "<tr><td>" +
                  (i + 1) +
                  "</td><td>" +
                  escapeHtml(p.name) +
                  "</td><td>" +
                  p.checkin_streak +
                  "</td><td>" +
                  p.best_streak +
                  "</td><td>" +
                  p.total_checkins +
                  '</td><td class="mono">' +
                  p.authority +
                  "</td></tr>"
              )
              .join("");
      status(
        "updated " +
          new Date().toLocaleTimeString() +
          " — " +
          profiles.length +
          " agent(s) on-chain"
      );
    } catch (err) {
      console.error(err);
      status("error: " + (err && err.message ? err.message : err));
    } finally {
      $("refresh").disabled = false;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  $("refresh").addEventListener("click", load);
  $("cluster").addEventListener("change", load);
  load();
})();
