import assert from "node:assert/strict";
import { test } from "node:test";
import { ZkoolZcashAdapter, zecToZatoshis } from "../lib/zcash/zkool";

const address = `utest1${"q".repeat(90)}`;
const txid = "a".repeat(64);

test("decimal ZEC amounts convert without floating point rounding", () => {
  assert.equal(zecToZatoshis("0.00000001"), 1n);
  assert.equal(zecToZatoshis("1.01"), 101_000_000n);
  assert.throws(() => zecToZatoshis("0.000000001"));
  assert.throws(() => zecToZatoshis("1e-8"));
});

test("watch-only funding is matched to one quest and stable across repeated scans", async () => {
  let allocations = 0;
  let syncHeight = 101;
  const fakeFetch: typeof fetch = async (_url, init) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    let data: unknown;
    if (query.includes("newAddresses")) {
      allocations++;
      data = { newAddresses: { ironwood: address } };
    } else if (query.includes("addressByAccount")) {
      data = { addressByAccount: { ua: address, ironwood: address } };
    } else if (query.includes("synchronizeAccount")) {
      data = { synchronizeAccount: syncHeight };
    } else if (query.includes("transactionsByAccount")) {
      data = { transactionsByAccount: [
        { txid, height: 100, notes: [
          { pool: 3, scope: 0, value: "0.01", address },
          { pool: 3, scope: 0, value: "0.02", address },
          { pool: 3, scope: 1, value: "9.00", address },
          { pool: 2, scope: 0, value: "9.00", address },
        ] },
        { txid: "b".repeat(64), height: 102, notes: [
          { pool: 3, scope: 0, value: "1.00", address },
        ] },
      ] };
    } else {
      throw new Error(`Unexpected GraphQL query: ${query}`);
    }
    return new Response(JSON.stringify({ data }), {
      headers: { "content-type": "application/json" },
    });
  };

  const adapter = new ZkoolZcashAdapter({
    endpoint: "http://127.0.0.1:8766/graphql",
    accountId: 1,
    mappingDbPath: ":memory:",
    fetchImpl: fakeFetch,
  });
  try {
    assert.deepEqual(await Promise.all([
      adapter.getQuestAddress("quest-a"), adapter.getQuestAddress("quest-a"),
    ]), [address, address]);
    assert.equal(allocations, 1);
    const first = await adapter.findFunding("quest-a");
    assert.deepEqual(first, [{
      txid,
      outputId: `${txid}:${address}`,
      amountZatoshis: 3_000_000n,
      confirmations: 2,
    }]);
    syncHeight = 104;
    const repeated = await adapter.findFunding("quest-a");
    assert.equal(repeated[0].outputId, first[0].outputId);
    assert.equal(repeated[0].confirmations, 5);
    await assert.rejects(adapter.findFunding("unknown"), /Unknown Zcash quest address/);
  } finally {
    adapter.close();
  }
});
