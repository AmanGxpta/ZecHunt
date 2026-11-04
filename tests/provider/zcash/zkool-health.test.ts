import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isUnderTempDir, resolveZkoolDataDir, zkoolDataPaths, zkoolWatcherArgs } from "../../../lib/zcash/data-dir";
import { ZkoolZcashAdapter } from "../../../lib/zcash/zkool";

const address = `utest1${"q".repeat(90)}`;

// Reply shapes match the running watch-only service, read-only on 4 Nov 2026:
// { currentHeight } and { accounts: [{ id, height }] }.
function fakeZkool(opts: { tip?: number | "error"; synced?: number | "unauthorized" | "error" } = {}) {
  const queries: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    queries.push(query);
    const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (query.includes("currentHeight")) {
      return opts.tip === "error" ? reply({ data: null, errors: [{ message: "lightwalletd: connection refused" }] })
        : reply({ data: { currentHeight: opts.tip ?? 4582641 } });
    }
    if (query.includes("accounts(")) {
      if (opts.synced === "unauthorized") return reply({ data: null, errors: [{ message: "Unauthorized" }] });
      if (opts.synced === "error") return new Response("down", { status: 502 });
      return reply({ data: { accounts: [{ id: 1, height: opts.synced ?? 4582418 }] } });
    }
    if (query.includes("synchronizeAccount")) return reply({ data: { synchronizeAccount: 4582640 } });
    if (query.includes("transactionsByAccount")) return reply({ data: { transactionsByAccount: [] } });
    if (query.includes("newAddresses")) return reply({ data: { newAddresses: { ironwood: address } } });
    if (query.includes("addressByAccount")) return reply({ data: { addressByAccount: { ua: address, ironwood: address } } });
    throw new Error(`unexpected query ${query}`);
  };
  return { fetchImpl, queries };
}

function adapter(fetchImpl: typeof fetch, mappingDbPath = ":memory:") {
  return new ZkoolZcashAdapter({ endpoint: "http://127.0.0.1:8766/graphql", accountId: 1, mappingDbPath, fetchImpl });
}

test("watcher health: tip and synced height, read-only, never asking for keys", async () => {
  const z = fakeZkool();
  const a = adapter(z.fetchImpl);
  assert.deepEqual(await a.getWatcherHealth(),
    { syncedHeight: 4582418, chainTipHeight: 4582641, lastSuccessfulScanAt: null, unavailable: ["never_scanned"] });
  assert.equal(z.queries.length, 2);
  for (const q of z.queries) {
    assert.ok(!/mutation|synchronize/i.test(q), "health must not sync or mutate");
    assert.ok(!/seed|passphrase|key/i.test(q), "health must never select secrets");
  }
  a.close();
});

test("watcher health says what is unavailable instead of inventing heights", async () => {
  const noTip = adapter(fakeZkool({ tip: "error" }).fetchImpl);
  const h1 = await noTip.getWatcherHealth();
  assert.equal(h1.chainTipHeight, null);
  assert.equal(h1.syncedHeight, 4582418, "a missing tip doesn't hide the synced height");
  assert.ok(h1.unavailable.includes("chain_tip_unavailable"));
  noTip.close();

  const scoped = adapter(fakeZkool({ synced: "unauthorized" }).fetchImpl);
  const h2 = await scoped.getWatcherHealth();
  assert.deepEqual([h2.syncedHeight, h2.chainTipHeight], [null, 4582641]);
  assert.ok(h2.unavailable.includes("synced_height_unauthorized"));
  scoped.close();

  const down = adapter(fakeZkool({ tip: "error", synced: "error" }).fetchImpl);
  const h3 = await down.getWatcherHealth();
  assert.deepEqual([h3.syncedHeight, h3.chainTipHeight], [null, null]);
  assert.deepEqual(h3.unavailable, ["chain_tip_unavailable", "synced_height_unavailable", "never_scanned"]);
  down.close();
});

test("lastSuccessfulScanAt is set by a completed funding scan and survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zechunt-zkool-health-"));
  const db = join(dir, "map.db");
  const z = fakeZkool();
  const a = adapter(z.fetchImpl, db);
  await a.getQuestAddress("quest-1");
  const before = Date.now();
  await a.findFunding("quest-1");
  a.close();
  const b = adapter(z.fetchImpl, db);
  const h = await b.getWatcherHealth();
  assert.ok(h.lastSuccessfulScanAt !== null && h.lastSuccessfulScanAt >= before);
  assert.deepEqual(h.unavailable, []);
  b.close();
  rmSync(dir, { recursive: true, force: true });
});

test("data dir: absolute, never a temp directory (including through a symlink)", () => {
  assert.throws(() => resolveZkoolDataDir(undefined), /not set/);
  assert.throws(() => resolveZkoolDataDir("data/zkool"), /absolute/);
  for (const p of ["/tmp/zkool", "/private/tmp/zkool", join(tmpdir(), "zkool")]) {
    assert.throws(() => resolveZkoolDataDir(p), /temporary/, p);
  }
  const dir = mkdtempSync(join(tmpdir(), "zechunt-link-"));
  const link = join(homedir(), `.zechunt-test-link-${process.pid}`);
  try {
    symlinkSync(dir, link);
    assert.equal(isUnderTempDir(join(link, "zkool")), true, "a symlink into /tmp is still /tmp");
  } finally {
    rmSync(link, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(resolveZkoolDataDir("/var/lib/zechunt/zkool"), "/var/lib/zechunt/zkool");
  assert.deepEqual(zkoolDataPaths({ ZECHUNT_ZKOOL_DATA_DIR: "/srv/zechunt/zkool" }), {
    dataDir: "/srv/zechunt/zkool", walletDb: "/srv/zechunt/zkool/watch-wallet.db",
    votingSidecar: "/srv/zechunt/zkool/watch-wallet.db.voting", passwordFile: "/srv/zechunt/zkool/wallet-password",
    mappingDb: "/srv/zechunt/zkool/quest-addresses.db",
  });
});

test("launcher args refuse a missing wallet, a readable password file and open unauthenticated access", () => {
  // Paths are built by hand: a real data dir can't live under the test's temp root.
  const dir = mkdtempSync(join(tmpdir(), "zechunt-launch-"));
  const paths = { dataDir: dir, walletDb: join(dir, "watch-wallet.db"), votingSidecar: join(dir, "watch-wallet.db.voting"),
    passwordFile: join(dir, "wallet-password"), mappingDb: join(dir, "quest-addresses.db") };
  const launch = { paths, lwdUrl: "https://testnet.zec.rocks:443", bindAddress: "127.0.0.1", port: 8766, allowUnauthenticated: true };
  assert.throws(() => zkoolWatcherArgs(launch), /No wallet/);
  mkdirSync(dir, { recursive: true });
  writeFileSync(paths.walletDb, "");
  writeFileSync(paths.passwordFile, "fixture");
  chmodSync(paths.passwordFile, 0o644);
  assert.throws(() => zkoolWatcherArgs(launch), /0600/);
  chmodSync(paths.passwordFile, 0o600);
  assert.deepEqual(zkoolWatcherArgs(launch), ["-d", paths.walletDb, "--db-password-file", paths.passwordFile,
    "-l", "https://testnet.zec.rocks:443", "-p", "8766", "--bind-address", "127.0.0.1", "-C", "1", "--allow-unauthenticated"]);
  assert.throws(() => zkoolWatcherArgs({ ...launch, bindAddress: "0.0.0.0" }), /loopback/);
  assert.throws(() => zkoolWatcherArgs({ ...launch, allowUnauthenticated: false }), /JWT/);
  assert.ok(zkoolWatcherArgs({ ...launch, bindAddress: "0.0.0.0", jwtPublicKeyFile: "/etc/zechunt/jwt.pub" }).includes("-j"));
  rmSync(dir, { recursive: true, force: true });
});
