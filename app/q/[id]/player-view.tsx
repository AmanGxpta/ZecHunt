"use client";


import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface PublicQuest {
  id: string;
  title: string;
  clue: string;
  rewardCategory: string;
  rewardCapCents: number;
  status: string;
  winnersRemaining: number;
}

interface ClaimView {
  claimStatus: string;
  reason?: string;
  purchase: { productName: string; priceCents: number; state: string } | null;
}

export default function PlayerView({ id }: { id: string }) {
  const [quest, setQuest] = useState<PublicQuest | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [code, setCode] = useState("");
  const [claimToken, setClaimToken] = useState<string | null>(null);
  const [claim, setClaim] = useState<ClaimView | null>(null);
  const [redemption, setRedemption] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadQuest = useCallback(async () => {
    const res = await fetch(`/api/quests/${id}`);
    if (res.status === 404) return setNotFound(true);
    const data = await res.json();
    setQuest(data.quest);
  }, [id]);

  const loadClaim = useCallback(async () => {
    const res = await fetch(`/api/quests/${id}/claim`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.claim) setClaim(data.claim);
    if (data.redemptionData) setRedemption(data.redemptionData);
  }, [id]);

  useEffect(() => {
    loadQuest();
    loadClaim();
  }, [loadQuest, loadClaim]);

  async function checkIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/quests/${id}/checkpoint`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(messageFor(data.error));
      setClaimToken(data.claimToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function claimReward() {
    if (!claimToken) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/quests/${id}/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claimToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(messageFor(data.error));
      setClaimToken(null);
      setClaim(data);
      await loadClaim();
      await loadQuest();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  if (notFound) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16">
        <h1 className="text-2xl font-semibold text-white">Quest not found</h1>
        <Link href="/" className="mt-4 inline-block text-amber-300">Back home</Link>
      </main>
    );
  }
  if (!quest) return <main className="mx-auto max-w-xl px-4 py-16 text-zinc-400">Loading…</main>;

  const isWinner = claim && claim.claimStatus !== "failed";
  const amount = `$${(quest.rewardCapCents / 100).toFixed(2)}`;

  return (
    <main className="mx-auto w-full max-w-xl space-y-8 px-4 py-12">
      <Link href="/" className="text-sm text-zinc-400 hover:text-zinc-200">← Zechunt</Link>

      <header className="space-y-3">
        <p className="text-xs uppercase tracking-[0.25em] text-amber-300/80">
          {quest.winnersRemaining > 0 ? "Open quest" : "Quest closed"}
        </p>
        <h1 className="text-3xl font-semibold text-white">{quest.title}</h1>
        <p className="text-base leading-7 text-zinc-200">{quest.clue}</p>
        <p className="text-sm text-zinc-400">Reward up to {amount} in {categoryLabel(quest.rewardCategory)}.</p>
      </header>

      {claim && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 text-sm">
          {isWinner ? (
            <>
              <h2 className="text-lg font-semibold text-amber-300">You found it.</h2>
              <p className="mt-2 text-zinc-200">
                {claim.purchase ? `${claim.purchase.productName} · status ${claim.purchase.state}` : "Preparing your reward…"}
              </p>
              {redemption && (
                <p className="mt-3 break-all rounded bg-black/40 p-3 font-mono text-zinc-100">{redemption}</p>
              )}
            </>
          ) : (
            <p className="text-zinc-300">
              This reward could not be issued{claim.reason ? ` (${claim.reason.replaceAll("_", " ")})` : ""}.
              The creator has been notified in principle; this demo does not send notifications yet.
            </p>
          )}
        </section>
      )}

      {!claim && quest.status !== "exhausted" && quest.status === "active" && !claimToken && (
        <form onSubmit={checkIn} className="space-y-4">
          <label className="block space-y-2">
            <span className="text-sm text-zinc-300">Checkpoint code</span>
            <input
              inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-3 text-center font-mono text-2xl tracking-[0.4em] text-white"
              placeholder="000000"
            />
          </label>
          <button type="submit" disabled={busy || code.length !== 6}
            className="w-full rounded-xl bg-amber-300 px-5 py-3 font-semibold text-zinc-950 disabled:opacity-50">
            {busy ? "Checking…" : "Check in"}
          </button>
        </form>
      )}

      {claimToken && !claim && (
        <section className="space-y-4">
          <p className="text-zinc-200">Checkpoint accepted. You have ten minutes to claim, and only the first claim wins.</p>
          <button type="button" disabled={busy} onClick={claimReward}
            className="w-full rounded-xl bg-amber-300 px-5 py-3 font-semibold text-zinc-950 disabled:opacity-50">
            {busy ? "Claiming…" : "Claim reward"}
          </button>
        </section>
      )}

      {quest.status !== "active" && !claim && (
        <p className="text-zinc-400">
          {quest.status === "exhausted" ? "Someone has already won this quest." : "This quest is not open yet."}
        </p>
      )}

      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    </main>
  );
}

function categoryLabel(value: string): string {
  return ({ food: "food & groceries", "mobile-recharge": "mobile recharge", gaming: "gaming & entertainment" } as Record<string, string>)[value] ?? value;
}

function messageFor(code: string | undefined): string {
  switch (code) {
    case "invalid_code": return "That code is not right.";
    case "too_many_attempts": return "Too many wrong codes. This quest is locked for entries.";
    case "already_claimed": return "You have already checked in to this quest.";
    case "quest_exhausted": return "Someone else found it first.";
    case "quest_not_active": return "This quest is not open right now.";
    case "invalid_token": return "Your check-in expired. Enter the code again.";
    default: return "Something went wrong. Please try again.";
  }
}
