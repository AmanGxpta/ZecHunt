"use client";

import Link from "next/link";
import { useState } from "react";

const CATEGORIES = [
  { value: "food", label: "Food & groceries" },
  { value: "mobile-recharge", label: "Mobile recharge" },
  { value: "gaming", label: "Gaming & entertainment" },
];

interface CreateResponse {
  quest: { id: string; fundingAddress: string; status: string; expectedZatoshis: number; fundedZatoshis: number };
  creatorToken: string;
  checkpointCode: string;
  providerMode: string;
}

interface QuestView {
  status: string;
  fundingAddress: string;
  expectedZatoshis: number;
  fundedZatoshis: number;
}

export default function CreatePage() {
  const [title, setTitle] = useState("");
  const [clue, setClue] = useState("");
  const [category, setCategory] = useState("food");
  const [capDollars, setCapDollars] = useState("3");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateResponse | null>(null);
  const [funding, setFunding] = useState<QuestView | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/quests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          clue,
          rewardCategory: category,
          rewardCapCents: Math.round(Number(capDollars) * 100),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? data.error ?? "Could not create quest");
      setCreated(data);
      setFunding(data.quest);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function checkFunding(simulate: boolean) {
    if (!created) return;
    setBusy(true);
    setError(null);
    try {
      if (simulate) {
        const sim = await fetch("/api/dev/simulate-funding", {
          method: "POST",
          headers: { "content-type": "application/json", "x-creator-token": created.creatorToken },
          body: JSON.stringify({ questId: created.quest.id, amountZatoshis: created.quest.expectedZatoshis }),
        });
        if (!sim.ok) throw new Error("Simulation unavailable in this mode");
      }
      const res = await fetch(`/api/quests/${created.quest.id}/funding`, {
        method: "POST",
        headers: { "x-creator-token": created.creatorToken },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? data.error);
      setFunding(data.quest);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check funding");
    } finally {
      setBusy(false);
    }
  }

  const playUrl = created ? `${typeof window !== "undefined" ? window.location.origin : ""}/q/${created.quest.id}` : "";
  const isActive = funding?.status === "active";

  return (
    <main className="mx-auto w-full max-w-xl space-y-8 px-4 py-12">
      <Link href="/" className="text-sm text-zinc-400 hover:text-zinc-200">← Zechunt</Link>

      {!created ? (
        <form onSubmit={submit} className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold text-white">Create a quest</h1>
            <p className="mt-2 text-sm text-zinc-400">
              You will receive a shielded funding address and a checkpoint code. Share the code only in person.
            </p>
          </div>

          <label className="block space-y-2">
            <span className="text-sm text-zinc-300">Title</span>
            <input
              required minLength={3} maxLength={80} value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-white"
              placeholder="Find the hidden QR"
            />
          </label>

          <label className="block space-y-2">
            <span className="text-sm text-zinc-300">Clue</span>
            <textarea
              required maxLength={500} rows={3} value={clue}
              onChange={(e) => setClue(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-white"
              placeholder="Look where the coffee is"
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-2">
              <span className="text-sm text-zinc-300">Reward</span>
              <select
                value={category} onChange={(e) => setCategory(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-white"
              >
                {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </label>
            <label className="block space-y-2">
              <span className="text-sm text-zinc-300">Maximum value (USD, up to 5)</span>
              <input
                required type="number" min="0.01" max="5" step="0.01" value={capDollars}
                onChange={(e) => setCapDollars(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-white"
              />
            </label>
          </div>

          {error && <p role="alert" className="text-sm text-red-400">{error}</p>}

          <button
            type="submit" disabled={busy}
            className="w-full rounded-xl bg-amber-300 px-5 py-3 font-semibold text-zinc-950 disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create quest"}
          </button>
        </form>
      ) : (
        <section className="space-y-6">
          <div>
            <h1 className="text-2xl font-semibold text-white">{isActive ? "Quest is live" : "Fund your quest"}</h1>
            <p className="mt-2 text-sm text-zinc-400">
              Save the checkpoint code and creator token now. They are shown only once.
            </p>
          </div>

          <dl className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm">
            <div>
              <dt className="text-zinc-400">Checkpoint code (share in person)</dt>
              <dd className="mt-1 font-mono text-2xl tracking-widest text-amber-300">{created.checkpointCode}</dd>
            </div>
            <div>
              <dt className="text-zinc-400">Shielded funding address</dt>
              <dd className="mt-1 break-all font-mono text-zinc-200">{funding?.fundingAddress}</dd>
            </div>
            <div>
              <dt className="text-zinc-400">Funding</dt>
              <dd className="mt-1 text-zinc-200">
                {funding ? `${funding.fundedZatoshis} / ${funding.expectedZatoshis} zatoshis confirmed` : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-400">Creator token (keep private)</dt>
              <dd className="mt-1 break-all font-mono text-xs text-zinc-300">{created.creatorToken}</dd>
            </div>
            <div>
              <dt className="text-zinc-400">Player link</dt>
              <dd className="mt-1 break-all font-mono text-zinc-200">{playUrl}</dd>
            </div>
          </dl>

          <div className="rounded-lg border border-amber-300/30 bg-amber-300/5 p-3 text-xs text-amber-200">
            Provider mode: <strong>{created.providerMode}</strong>
            {created.providerMode === "mock" && " — funding and purchases are simulated, not real transactions."}
          </div>

          {error && <p role="alert" className="text-sm text-red-400">{error}</p>}

          {!isActive && (
            <div className="flex flex-col gap-3 sm:flex-row">
              <button
                type="button" disabled={busy} onClick={() => checkFunding(false)}
                className="flex-1 rounded-xl border border-zinc-600 px-4 py-3 text-zinc-100 disabled:opacity-50"
              >
                Check funding
              </button>
              {created.providerMode === "mock" && (
                <button
                  type="button" disabled={busy} onClick={() => checkFunding(true)}
                  className="flex-1 rounded-xl bg-zinc-100 px-4 py-3 font-semibold text-zinc-950 disabled:opacity-50"
                >
                  Simulate funding (mock)
                </button>
              )}
            </div>
          )}

          {isActive && (
            <Link href={`/q/${created.quest.id}`} className="block rounded-xl bg-amber-300 px-4 py-3 text-center font-semibold text-zinc-950">
              Open player view
            </Link>
          )}
        </section>
      )}
    </main>
  );
}
