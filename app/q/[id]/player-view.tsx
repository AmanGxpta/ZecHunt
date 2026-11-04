"use client";

import { useEffect, useRef, useState } from "react";
import { RewardCard } from "@/components/reward-card";
import { HuntCamera, type SubmitResult } from "@/components/hunt/hunt-camera";
import { requestMotionAccess } from "@/components/hunt/use-camera";
import { Button, Card, CATEGORY_LABEL, ErrorNote, Eyebrow, formatInr, ModeBadge, Shell, Spinner } from "@/components/ui";

type Mode = "mock" | "live";
interface PublicQuest {
  id: string; title: string; clue: string; rewardCategory: string; rewardCapCents: number; rewardCapInr: number;
  status: "awaiting_funding" | "active" | "paused" | "exhausted" | "cancelled"; winnersRemaining: number; zcashMode: Mode;
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
  quest_paused: "The organiser paused this quest for a moment. Try again shortly.",
  quest_cancelled: "This quest was cancelled by the organiser.",
  already_claimed: "You’ve already claimed this quest.",
  invalid_token: "Your claim expired. Enter the current code again.",
};

export default function PlayerView({ id }: { id: string }) {
  const [quest, setQuest] = useState<PublicQuest | null>(null);
  const [modes, setModes] = useState<{ zcash: Mode; bitrefill: Mode } | null>(null);
  const [missing, setMissing] = useState(false);
  const [claim, setClaim] = useState<ClaimView | null>(null);
  const [redemption, setRedemption] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const claimRef = useRef<ClaimView | null>(null);
  const [hunt, setHunt] = useState<{ startWon: boolean } | null>(null);

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
          if (cd.logoUrl) setLogoUrl(cd.logoUrl);
        }
      } catch {}
    };
    load();
    // Keep polling while there's something to wait for: activation or fulfillment.
    const t = setInterval(() => {
      const c = claimRef.current;
      if (!c || c.claimStatus === "purchase_pending" || c.purchase?.state === "INVOICE_CREATED") load();
    }, 4_000);
    return () => { alive = false; clearInterval(t); };
  }, [id]);

  /** Checkpoint code → claim token → winner slot. Used by the camera and the typed form. */
  async function submitCode(value: string): Promise<SubmitResult> {
    try {
      const cp = await fetch(`/api/quests/${id}/checkpoint`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: value }),
      });
      const cpd = await cp.json();
      if (!cp.ok) return { ok: false, error: cpd.error ?? "error", message: ERRORS[cpd.error] ?? cpd.message ?? "Something went wrong" };
      const cl = await fetch(`/api/quests/${id}/claim`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ claimToken: cpd.claimToken }),
      });
      const cld = await cl.json();
      if (!cl.ok) return { ok: false, error: cld.error ?? "error", message: ERRORS[cld.error] ?? cld.message ?? "Could not claim" };
      claimRef.current = cld; setClaim(cld);
      return { ok: true };
    } catch {
      return { ok: false, error: "network", message: "Connection problem. Try again." };
    } finally {
      fetch(`/api/quests/${id}`).then((r) => r.json()).then((qd) => qd?.quest && setQuest(qd.quest)).catch(() => {});
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const r = await submitCode(code);
    setBusy(false);
    if (r.ok) { await openCamera(true); return; }
    setError(r.message);
  }

  async function openCamera(startWon = false) {
    await requestMotionAccess();
    setHunt({ startWon });
  }

  if (missing) return <Shell><Card><h1 className="font-display text-2xl">No quest here</h1><p className="mt-2 text-muted">Check the link you were sent.</p></Card></Shell>;
  if (!quest || !modes) return <Shell><p className="text-muted">Loading quest…</p></Shell>;

  return (
    <Shell>
      <div className="rise">
        <Eyebrow>{claim ? "You won this quest" : ({ active: "Quest is live", paused: "Paused", exhausted: "Quest complete", cancelled: "Cancelled", awaiting_funding: "Not live yet" } as const)[quest.status]}</Eyebrow>
        <h1 className="mt-2 font-display text-4xl leading-tight tracking-tight">{quest.title}</h1>
        <p className="mt-2 text-muted">
          Reward: {quest.rewardCategory === "any" ? "a voucher of the winner’s choice" : CATEGORY_LABEL[quest.rewardCategory] ?? quest.rewardCategory}, worth up to {formatInr(quest.rewardCapInr)}
        </p>
      </div>

      <Card className="mt-6">
        <p className="text-[11px] uppercase tracking-[0.22em] text-muted">The clue</p>
        <p className="mt-3 font-display text-xl leading-8 text-fg">“{quest.clue}”</p>
      </Card>

      {claim ? (
        claim.claimStatus === "reserved"
          ? <RewardPicker questId={id} onChosen={(c) => { claimRef.current = c; setClaim(c); }} />
          : <Victory claim={claim} redemption={redemption} logoUrl={logoUrl} questCategory={quest.rewardCategory} />
      ) : quest.status === "active" ? (
        <div className="mt-4 space-y-3">
          <Card className="space-y-4 border-lantern/30">
            <p className="font-display text-xl">Found the checkpoint?</p>
            <p className="-mt-2 text-sm text-muted">Scan its QR code with your camera. First one to the chest wins.</p>
            <Button onClick={() => openCamera(false)} className="w-full">📷 Open camera &amp; scan</Button>
          </Card>
          <form onSubmit={submit}>
            <Card className="space-y-3">
              <label htmlFor="code" className="block text-sm text-muted">No camera? Type the six-digit code instead</label>
              <input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required
                value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                className="w-full rounded-xl border border-line bg-ink-2 px-4 py-3 text-center font-mono text-3xl tracking-[0.5em] text-lantern outline-none placeholder:text-line focus:border-lantern/70"
                placeholder="······" />
              {error && <ErrorNote>{error}</ErrorNote>}
              <Button type="submit" variant="ghost" disabled={busy || code.length !== 6} className="w-full">
                {busy ? <><Spinner /> Checking…</> : "Claim with code"}
              </Button>
            </Card>
          </form>
        </div>
      ) : quest.status === "paused" ? (
        <Card className="mt-4 text-center">
          <p className="font-display text-xl">Paused by the organiser</p>
          <p className="mt-2 text-sm text-muted">The hunt will be back soon. This page updates on its own.</p>
        </Card>
      ) : quest.status === "cancelled" ? (
        <Card className="mt-4 text-center">
          <p className="font-display text-xl">This quest was cancelled</p>
          <p className="mt-2 text-sm text-muted">The organiser called it off before anyone won.</p>
        </Card>
      ) : quest.status === "exhausted" ? (
        <Card className="mt-4 text-center">
          <p className="text-4xl" aria-hidden>🗝️</p>
          <p className="mt-2 font-display text-2xl">Someone got there first</p>
          <p className="mt-2 text-muted">This chest has already been opened. Better luck on the next hunt.</p>
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
      {hunt && (
        <HuntCamera questId={id} questTitle={quest.title} startWon={hunt.startWon} submitCode={submitCode}
          onClose={() => setHunt(null)} onDone={() => setHunt(null)} />
      )}
    </Shell>
  );
}

const REASONS: Record<string, string> = {
  no_eligible_product: "no in-stock product fits this quest’s budget",
  over_reward_cap: "the price is above the creator’s cap",
  insufficient_credit: "the reward budget is used up",
  category_mismatch: "the product didn’t match the reward type",
  quest_not_funded: "the quest isn’t funded",
  repriced_over_cap: "its price went above the creator’s cap just before buying",
  unavailable: "it went out of stock just before buying",
  no_approval: "the purchase wasn’t approved in time",
  spend_ceiling_reached: "today’s reward budget is used up",
  insufficient_balance: "the reward balance is empty",
};

function Victory({ claim, redemption, logoUrl, questCategory }: { claim: ClaimView; redemption: string | null; logoUrl: string | null; questCategory: string }) {
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
        <RewardCard productName={p.productName} category={questCategory === "any" ? null : questCategory} logoUrl={logoUrl}
          redemption={redemption} simulated={p.providerMode === "mock"} />
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

interface RewardOption { productId: string; name: string; category: string; priceCents: number; priceInr: number; faceInr: number; imageUrl: string | null }
interface Recommendation { productId: string; reason: string; source: "agent" | "rule" }

interface RewardsResponse {
  options?: RewardOption[]; recommendation?: Recommendation | null; error?: string; message?: string;
}

async function fetchRewards(questId: string): Promise<{ ok: boolean; data: RewardsResponse }> {
  try {
    const r = await fetch(`/api/quests/${questId}/rewards`);
    return { ok: r.ok, data: await r.json() };
  } catch {
    return { ok: false, data: { message: "Couldn’t load rewards. Check your connection." } };
  }
}

const CATEGORY_ICON: Record<string, string> = { food: "🍔", shopping: "🛍️", gaming: "🎮" };

const PICK_ERRORS: Record<string, string> = {
  reward_unavailable: "That one just went out of stock or changed price. Pick another.",
  reward_already_chosen: "Your reward is already on its way.",
};

function RewardPicker({ questId, onChosen }: { questId: string; onChosen: (c: ClaimView) => void }) {
  const [options, setOptions] = useState<RewardOption[] | null>(null);
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function apply(d: { ok: boolean; data: RewardsResponse }) {
    if (!d.ok) {
      if (d.data.error === "reward_already_chosen") { refreshClaim(); return; }
      setError(d.data.message ?? "Couldn’t load rewards");
      return;
    }
    setError(null); setOptions(d.data.options ?? []); setRec(d.data.recommendation ?? null);
    setSelected((s) => s ?? d.data.recommendation?.productId ?? d.data.options?.[0]?.productId ?? null);
  }

  async function loadOptions() {
    apply(await fetchRewards(questId));
  }

  async function refreshClaim() {
    const again = await fetch(`/api/quests/${questId}/claim`).then((r) => r.json()).catch(() => null);
    if (again?.claim) onChosen(again.claim);
  }

  useEffect(() => {
    let alive = true;
    fetchRewards(questId).then((d) => { if (alive) apply(d); });
    return () => { alive = false; };
  }, [questId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function confirm() {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/quests/${questId}/rewards`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ productId: selected }),
      });
      const d = await r.json();
      if (!r.ok) {
        if (d.error === "reward_unavailable") { setSelected(null); await loadOptions(); }
        throw new Error(PICK_ERRORS[d.error] ?? d.message ?? "Something went wrong");
      }
      onChosen(d);
      await refreshClaim();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-4 overflow-hidden border-lantern/40">
      <div className="-m-5 mb-5 bg-gradient-to-br from-lantern/25 via-lantern/5 to-transparent px-5 py-6">
        <p className="text-[11px] uppercase tracking-[0.22em] text-lantern">You found it</p>
        <p className="mt-1 font-display text-3xl">First to the checkpoint 🏆</p>
        <p className="mt-2 text-sm text-muted">Pick your reward. Nothing is bought until you confirm.</p>
      </div>
      {!options ? (
        error ? <ErrorNote>{error}</ErrorNote> : <p className="flex items-center gap-2 text-muted"><Spinner /> Finding rewards in stock…</p>
      ) : options.length === 0 ? (
        <p className="text-muted">No reward fits this quest’s budget right now. Your win is saved; check back in a bit.</p>
      ) : (
        <div className="space-y-3">
          <div className="space-y-2" role="radiogroup" aria-label="Rewards">
            {options.map((o) => {
              const on = selected === o.productId;
              const recommended = rec?.productId === o.productId;
              return (
                <button key={o.productId} type="button" role="radio" aria-checked={on} onClick={() => setSelected(o.productId)}
                  className={`w-full rounded-xl border px-4 py-3 text-left transition ${on ? "border-lantern bg-lantern/10" : "border-line hover:border-lantern/40"}`}>
                  <span className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-3">
                      {o.imageUrl
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={o.imageUrl} alt="" className="h-10 w-10 shrink-0 rounded-lg bg-white object-contain p-1" />
                        : <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-ink-2 text-lg">{CATEGORY_ICON[o.category] ?? "🎁"}</span>}
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-fg">{o.name}</span>
                        <span className="block text-xs text-muted">{CATEGORY_LABEL[o.category] ?? o.category} · worth {formatInr(o.faceInr)}</span>
                      </span>
                    </span>
                    {recommended && <span className="shrink-0 rounded-full bg-lantern/15 px-2 py-0.5 text-[11px] uppercase tracking-[0.14em] text-lantern">Suggested</span>}
                  </span>
                  {recommended && rec?.reason && <span className="mt-2 block text-sm text-muted">“{rec.reason}”</span>}
                </button>
              );
            })}
          </div>
          {error && <ErrorNote>{error}</ErrorNote>}
          <Button onClick={confirm} disabled={busy || !selected} className="w-full">
            {busy ? <><Spinner /> Getting your reward…</> : "Get this reward"}
          </Button>
        </div>
      )}
    </Card>
  );
}
