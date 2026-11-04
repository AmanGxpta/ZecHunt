"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Card, CATEGORY_LABEL, ErrorNote, Eyebrow, Shell, Spinner } from "@/components/ui";
import { saveSecrets } from "@/lib/client/creator-store";

const CATEGORIES = ["any", "food", "shopping", "gaming"] as const;
const CAPS = [50, 100, 250, 400];

export default function CreatePage() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [clue, setClue] = useState("");
  const [category, setCategory] = useState<string>("any");
  const [cap, setCap] = useState(50);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedFrom, setCopiedFrom] = useState<string | null>(null);

  // "Run it again": prefill from an earlier quest (public fields only).
  useEffect(() => {
    const from = new URLSearchParams(window.location.search).get("from");
    if (!from) return;
    let alive = true;
    fetch(`/api/quests/${encodeURIComponent(from)}`).then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!alive || !d?.quest) return;
      setTitle(d.quest.title); setClue(d.quest.clue);
      if ((CATEGORIES as readonly string[]).includes(d.quest.rewardCategory)) setCategory(d.quest.rewardCategory);
      if (CAPS.includes(d.quest.rewardCapInr)) setCap(d.quest.rewardCapInr);
      setCopiedFrom(d.quest.title);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/quests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, clue, rewardCategory: category, rewardCapInr: cap }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? data.error ?? "Could not create quest");
      saveSecrets(data.quest.id, { creatorToken: data.creatorToken, checkpointKey: data.checkpointKey });
      router.push(`/manage/${data.quest.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  const input = "w-full rounded-xl border border-line bg-ink-2 px-4 py-3 text-fg placeholder:text-muted/60 outline-none transition focus:border-lantern/70";

  return (
    <Shell>
      <form onSubmit={submit} className="space-y-6">
        <div className="rise">
          <Eyebrow>New quest</Eyebrow>
          <h1 className="mt-2 font-display text-4xl tracking-tight">Hide a reward</h1>
          <p className="mt-2 text-muted">
            {copiedFrom ? `Copied from “${copiedFrom}”. Change anything, then publish. It gets a new code and funding address.` : "One checkpoint and one winner. Takes about a minute."}
          </p>
        </div>

        <Card className="space-y-5">
          <label className="block space-y-2">
            <span className="text-sm font-medium">Quest name</span>
            <input required minLength={3} maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)}
              className={input} placeholder="The Lantern at Hall B" />
          </label>
          <label className="block space-y-2">
            <span className="text-sm font-medium">The clue</span>
            <textarea required maxLength={500} rows={4} value={clue} onChange={(e) => setClue(e.target.value)}
              className={`${input} resize-none`}
              placeholder="Where the coffee never stops and the badges are printed, ask the one wearing the gold scarf for the code." />
            <span className="block text-right text-xs text-muted">{clue.length}/500</span>
          </label>
        </Card>

        <Card className="space-y-5">
          <div>
            <p className="text-sm font-medium">Reward</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {CATEGORIES.map((c) => (
                <button key={c} type="button" onClick={() => setCategory(c)} aria-pressed={category === c}
                  className={`rounded-xl border px-3 py-3 text-left text-sm transition ${category === c ? "border-lantern bg-lantern/10 text-fg" : "border-line text-muted hover:border-lantern/40"}`}>
                  {CATEGORY_LABEL[c]}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">
              {category === "any"
                ? "The winner picks a food, shopping or gaming voucher. Our agent suggests one; they confirm."
                : "The winner picks from vouchers in this category. Our agent suggests one; they confirm."}
            </p>
          </div>
          <div>
            <p className="text-sm font-medium">Most the agent may spend</p>
            <div className="mt-3 flex gap-2">
              {CAPS.map((c) => (
                <button key={c} type="button" onClick={() => setCap(c)} aria-pressed={cap === c}
                  className={`flex-1 rounded-xl border py-3 font-mono text-sm transition ${cap === c ? "border-lantern bg-lantern/10 text-lantern" : "border-line text-muted hover:border-lantern/40"}`}>
                  ₹{c}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs leading-5 text-muted">
              An agent picks a real product from the live catalog. The server enforces this cap and refuses anything over it.
              Paid from a capped event-credit budget; rupee amounts are approximate.
            </p>
          </div>
        </Card>

        {error && <ErrorNote>{error}</ErrorNote>}

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? <><Spinner /> Creating a shielded address…</> : "Create quest & get funding address"}
        </Button>
      </form>
    </Shell>
  );
}
