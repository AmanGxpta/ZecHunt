"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Card, CATEGORY_LABEL, CopyField, ErrorNote, Eyebrow, formatInr, ModeBadge, Shell, Spinner } from "@/components/ui";

type Mode = "mock" | "live";
interface PublicQuest {
  id: string; title: string; clue: string; rewardCategory: string; rewardCapCents: number; rewardCapInr: number;
  status: "awaiting_funding" | "active" | "exhausted"; winnersRemaining: number; zcashMode: Mode;
}
interface ClaimView {
  claimId: string; claimStatus: string; reason?: string;
  purchase: { productName: string; priceCents: number; priceInr: number; state: string; invoiceId: string | null; providerMode: Mode } | null;
}

const ERRORS: Record<string, string> = {
  invalid_code: "That’s not the code. Check the checkpoint and try again.",
  too_many_attempts: "Too many wrong tries. Take a breather and try again in a few minutes.",
  quest_exhausted: "Someone got there first. This reward has been claimed.",
  quest_not_active: "This quest isn’t live yet.",
  already_claimed: "You’ve already claimed this quest.",
  invalid_token: "Your claim expired. Enter the current code again.",
};

export default function PlayerView({ id }: { id: string }) {
  const [quest, setQuest] = useState<PublicQuest | null>(null);
  const [modes, setModes] = useState<{ zcash: Mode; bitrefill: Mode } | null>(null);
  const [missing, setMissing] = useState(false);
  const [claim, setClaim] = useState<ClaimView | null>(null);
  const [redemption, setRedemption] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const claimRef = useRef<ClaimView | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [qr, cr] = await Promise.all([fetch(`/api/quests/${id}`), fetch(`/api/quests/${id}/claim`)]);
        if (!alive) return;
        if (qr.status === 404) { setMissing(true); return; }
        const qd = await qr.json();
        setQuest(qd.quest); setModes(qd.modes);
        if (cr.ok) {
          const cd = await cr.json();
          if (cd.claim) { claimRef.current = cd.claim; setClaim(cd.claim); }
          if (cd.redemptionData) setRedemption(cd.redemptionData);
        }
      } catch {}
    };
    load();
    // Keep polling while there's something to wait for: activation or fulfillment.
    const t = setInterval(() => {
      const c = claimRef.current;
      if (!c || ["purchase_pending", "reserved"].includes(c.claimStatus) || c.purchase?.state === "INVOICE_CREATED") load();
    }, 4_000);
    return () => { alive = false; clearInterval(t); };
  }, [id]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const cp = await fetch(`/api/quests/${id}/checkpoint`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }),
      });
      const cpd = await cp.json();
      if (!cp.ok) throw new Error(ERRORS[cpd.error] ?? cpd.message ?? "Something went wrong");
      const cl = await fetch(`/api/quests/${id}/claim`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ claimToken: cpd.claimToken }),
      });
      const cld = await cl.json();
      if (!cl.ok) throw new Error(ERRORS[cld.error] ?? cld.message ?? "Could not claim");
      claimRef.current = cld; setClaim(cld);
      const again = await fetch(`/api/quests/${id}/claim`).then((r) => r.json());
      if (again.claim) { claimRef.current = again.claim; setClaim(again.claim); }
      if (again.redemptionData) setRedemption(again.redemptionData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      const qd = await fetch(`/api/quests/${id}`).then((r) => r.json()).catch(() => null);
      if (qd?.quest) setQuest(qd.quest);
    } finally {
      setBusy(false);
    }
  }

  if (missing) return <Shell><Card><h1 className="font-display text-2xl">No quest here</h1><p className="mt-2 text-muted">Check the link you were sent.</p></Card></Shell>;
  if (!quest || !modes) return <Shell><p className="text-muted">Loading quest…</p></Shell>;

  return (
    <Shell>
      <div className="rise">
        <Eyebrow>{claim ? "You won this quest" : quest.status === "active" ? "Quest is live" : quest.status === "exhausted" ? "Quest complete" : "Not live yet"}</Eyebrow>
        <h1 className="mt-2 font-display text-4xl leading-tight tracking-tight">{quest.title}</h1>
        <p className="mt-2 text-muted">
          Reward: {CATEGORY_LABEL[quest.rewardCategory] ?? quest.rewardCategory}, worth up to {formatInr(quest.rewardCapInr)}
        </p>
      </div>

      <Card className="mt-6">
        <p className="text-[11px] uppercase tracking-[0.22em] text-muted">The clue</p>
        <p className="mt-3 font-display text-xl leading-8 text-fg">“{quest.clue}”</p>
      </Card>

      {claim ? (
        <Victory claim={claim} redemption={redemption} />
      ) : quest.status === "active" ? (
        <form onSubmit={submit} className="mt-4">
          <Card className="space-y-4">
            <label htmlFor="code" className="block font-display text-xl">Found the checkpoint?</label>
            <p className="-mt-2 text-sm text-muted">Enter the six-digit code shown there. First correct code wins.</p>
            <input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="w-full rounded-xl border border-line bg-ink-2 px-4 py-4 text-center font-mono text-4xl tracking-[0.5em] text-lantern outline-none placeholder:text-line focus:border-lantern/70"
              placeholder="······" />
            {error && <ErrorNote>{error}</ErrorNote>}
            <Button type="submit" disabled={busy || code.length !== 6} className="w-full">
              {busy ? <><Spinner /> Checking…</> : "Claim the reward"}
            </Button>
          </Card>
        </form>
      ) : quest.status === "exhausted" ? (
        <Card className="mt-4 text-center">
          <p className="font-display text-2xl">Someone got there first</p>
          <p className="mt-2 text-muted">This quest’s reward has been claimed. Better luck on the next hunt.</p>
          {error && <p className="mt-3 text-sm text-ember">{error}</p>}
        </Card>
      ) : (
        <Card className="mt-4 text-center">
          <p className="font-display text-xl">Waiting for the creator to fund this quest</p>
          <p className="mt-2 text-sm text-muted">This page updates on its own.</p>
        </Card>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        <ModeBadge mode={quest.zcashMode} what="Zcash funding" />
        {modes.bitrefill === "mock" && <ModeBadge mode={modes.bitrefill} what="Bitrefill reward" />}
      </div>
      <p className="mt-3 text-xs leading-5 text-muted/80">
        No wallet or account needed. This browser holds an anonymous session so only you can see your reward.
      </p>
    </Shell>
  );
}

const REASONS: Record<string, string> = {
  no_eligible_product: "no in-stock product fits this quest’s budget",
  over_reward_cap: "the price is above the creator’s cap",
  insufficient_credit: "the reward budget is used up",
  category_mismatch: "the product didn’t match the reward type",
  quest_not_funded: "the quest isn’t funded",
};

function Victory({ claim, redemption }: { claim: ClaimView; redemption: string | null }) {
  const p = claim.purchase;
  const delivered = claim.claimStatus === "delivered";
  const pending = claim.claimStatus === "purchase_pending" || claim.claimStatus === "reserved" || p?.state === "INVOICE_CREATED";
  return (
    <Card className="mt-4 overflow-hidden border-lantern/40">
      <div className="-m-5 mb-5 bg-gradient-to-br from-lantern/25 via-lantern/5 to-transparent px-5 py-6">
        <p className="text-[11px] uppercase tracking-[0.22em] text-lantern">You found it</p>
        <p className="mt-1 font-display text-3xl">First to the checkpoint 🏆</p>
      </div>
      {delivered && p ? (
        <div className="space-y-4">
          <p className="text-muted">
            Your reward: <span className="text-fg">{p.productName}</span>{/₹/.test(p.productName) ? null : ` (about ${formatInr(p.priceInr)})`}
          </p>
          {redemption ? (
            <CopyField label={p.providerMode === "mock" ? "Redemption (SIMULATED, not a real code)" : "Your redemption code"} value={redemption} />
          ) : (
            <p className="text-sm text-muted">Delivered. Fetching your redemption details…</p>
          )}
          {p.providerMode === "mock" && <ModeBadge mode="mock" what="purchase: no money was spent" />}
        </div>
      ) : pending ? (
        <p className="flex items-center gap-2 text-muted"><Spinner /> An agent is buying your reward within the creator’s limit…</p>
      ) : claim.claimStatus === "needs_reconciliation" ? (
        <p className="text-muted">Your win is recorded. The purchase needs a manual check before anything is retried. We won’t charge twice. Check back soon.</p>
      ) : (
        <p className="text-muted">
          Your win is recorded, but no reward could be bought:{" "}
          <span className="text-fg">{REASONS[claim.reason ?? ""] ?? claim.reason ?? "unknown reason"}</span>. No money was spent. The organiser has been flagged.
        </p>
      )}
    </Card>
  );
}
