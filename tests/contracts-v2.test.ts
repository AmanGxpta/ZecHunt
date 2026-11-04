import { test } from "node:test";
import assert from "node:assert/strict";
import { MockBitrefillAdapterV2 } from "../lib/providers/mock-v2";
import { CLAIM_TRANSITIONS, canTransition, type ClaimState } from "../lib/contracts/domain";
import { runBitrefillV2Conformance } from "./contracts/bitrefill-v2";

runBitrefillV2Conformance("mock v2", async () => {
  const adapter = new MockBitrefillAdapterV2();
  return {
    adapter,
    moneyCalls: () => adapter.moneyCalls,
    loseNextPurchaseResponse: () => adapter.loseNextPurchaseResponse(),
    fixture: { country: "IN", category: "food", maxSpendUsdCents: 63 },
  };
});

test("claim state machine: terminal states are terminal, uncertain never jumps to failed via retry", () => {
  for (const s of ["fulfilled", "failed", "cancelled"] as ClaimState[]) assert.deepEqual(CLAIM_TRANSITIONS[s], []);
  assert.equal(canTransition("needs_reconciliation", "approved"), false, "no re-approval (= re-purchase) after an uncertain outcome");
  assert.equal(canTransition("needs_reconciliation", "choosing_reward"), false);
  assert.equal(canTransition("purchase_pending", "cancelled"), false, "cannot cancel once money may have moved");
});
