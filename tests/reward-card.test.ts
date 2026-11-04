import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRedemption } from "../components/reward-card";

test("redemption text splits into code, PIN and expiry; unknown shapes stay visible", () => {
  const p = parseRedemption("Code: ABC123XYZ\nPIN Code: 445566\nValid until: 2027-03-30");
  assert.deepEqual(p.fields, [{ label: "Code", value: "ABC123XYZ" }, { label: "PIN", value: "445566" }]);
  assert.equal(p.expires, "2027-03-30");
  assert.deepEqual(parseRedemption("MOCK-REDEMPTION-NOT-A-REAL-CODE").fields, [{ label: "Code", value: "MOCK-REDEMPTION-NOT-A-REAL-CODE" }]);
  assert.equal(parseRedemption("Link: javascript:alert(1)").link, null, "only https links become buttons");
  assert.equal(parseRedemption("Link: https://example.com/v").link, "https://example.com/v");
});
