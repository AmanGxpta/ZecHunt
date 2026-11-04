#!/usr/bin/env node
// Read-only zkool_graphql capability probe. Prints public txids and amounts;
// never queries account seeds, keys, or redemption data.

const endpoint = process.env.ZECHUNT_ZKOOL_GRAPHQL_URL ?? "http://127.0.0.1:8000/graphql";
const accountId = Number(process.env.ZECHUNT_ZKOOL_ACCOUNT_ID);
if (!Number.isSafeInteger(accountId) || accountId <= 0) {
  console.error("Set ZECHUNT_ZKOOL_ACCOUNT_ID to a positive wallet account ID.");
  process.exit(2);
}
if (!/^https?:\/\//.test(endpoint)) {
  console.error("ZECHUNT_ZKOOL_GRAPHQL_URL must be an HTTP(S) URL.");
  process.exit(2);
}

async function query(source, variables = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: source, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`zkool GraphQL HTTP ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(`zkool GraphQL: ${body.errors[0].message}`);
  if (!body.data) throw new Error("zkool GraphQL response has no data");
  return body.data;
}

function toZatoshis(value) {
  const match = String(value).match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (!match) throw new Error(`Invalid ZEC decimal amount: ${value}`);
  return BigInt(match[1]) * 100_000_000n + BigInt((match[2] ?? "").padEnd(8, "0"));
}

try {
  const data = await query(
    `query Probe($id: Int!) {
      currentHeight
      addressByAccount(idAccount: $id, pools: 4) { ua ironwood }
      transactionsByAccount(idAccount: $id) {
        txid height notes { id pool scope value address }
      }
    }`,
    { id: accountId },
  );
  const address = data.addressByAccount?.ua;
  if (!address?.startsWith("utest1") || !data.addressByAccount?.ironwood) {
    throw new Error("Account has no confirmed testnet Ironwood receiving address");
  }
  const tip = Number(data.currentHeight);
  if (!Number.isSafeInteger(tip) || tip <= 0) throw new Error("Invalid chain height");
  const incoming = [];
  for (const tx of data.transactionsByAccount ?? []) {
    const height = Number(tx.height);
    if (!Number.isSafeInteger(height) || height <= 0 || height > tip) continue;
    for (const note of tx.notes ?? []) {
      if (note.pool !== 3 || note.scope !== 0) continue;
      incoming.push({
        txid: tx.txid,
        walletNoteId: note.id,
        amountZatoshis: toZatoshis(note.value).toString(),
        height,
        confirmations: tip - height + 1,
      });
    }
  }
  console.log(JSON.stringify({ accountId, tip, receivingAddress: address, incoming }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
