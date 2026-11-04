import { ZkoolZcashAdapter } from "../lib/zcash/zkool";

const endpoint = process.env.ZECHUNT_ZKOOL_GRAPHQL_URL;
const accountId = Number(process.env.ZECHUNT_ZKOOL_ACCOUNT_ID);
const mappingDbPath = process.env.ZECHUNT_ZCASH_MAPPING_DB;
const questId = process.env.ZECHUNT_QUEST_ID;
if (!endpoint || !mappingDbPath || !questId) {
  throw new Error("Set ZECHUNT_ZKOOL_GRAPHQL_URL, ZECHUNT_ZKOOL_ACCOUNT_ID, ZECHUNT_ZCASH_MAPPING_DB, and ZECHUNT_QUEST_ID");
}

const adapter = new ZkoolZcashAdapter({ endpoint, accountId, mappingDbPath });
async function main() {
  try {
    const address = await adapter.getQuestAddress(questId!);
    const funding = await adapter.findFunding(questId!);
    console.log(JSON.stringify({
      questId,
      address,
      funding: funding.map((event) => ({
        ...event,
        amountZatoshis: event.amountZatoshis.toString(),
      })),
    }, null, 2));
  } finally {
    adapter.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
