"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Card, CATEGORY_LABEL, Eyebrow, formatInr, Shell } from "@/components/ui";
import { forgetQuest, listManagedQuests, loadSecrets } from "@/lib/client/creator-store";

interface Row {
  id: string; title: string; status: string; rewardCategory: string; rewardCapInr: number;
  winner: { claimStatus: string; productName: string | null } | null;
}

const STATUS: Record<string, { label: string; tone: string }> = {
  awaiting_funding: { label: "Needs funding", tone: "border-line text-muted" },
  active: { label: "Live", tone: "border-moss/50 text-moss" },
  paused: { label: "Paused", tone: "border-lantern/50 text-lantern" },
  exhausted: { label: "Won", tone: "border-lantern/50 text-lantern" },
  cancelled: { label: "Cancelled", tone: "border-line text-muted" },
};

function winnerLine(w: Row["winner"]): string | null {
  if (!w) return null;
  if (w.claimStatus === "delivered") return `Reward delivered${w.productName ? `: ${w.productName}` : ""}`;
  if (w.claimStatus === "reserved") return "Winner is choosing a reward";
  if (w.claimStatus === "purchase_pending") return "Buying the winner’s reward…";
  if (w.claimStatus === "needs_reconciliation") return "Reward purchase being checked";
  return "Reward couldn’t be bought";
}

export default function MyQuests() {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    let alive = true;
    const ids = listManagedQuests();
    Promise.all(ids.map(async (id) => {
      const s = loadSecrets(id);
      if (!s) return null;
      const r = await fetch(`/api/quests/${id}/funding`, { headers: { "x-creator-token": s.creatorToken } }).catch(() => null);
      if (!r) return null;
      if (r.status === 404) { forgetQuest(id); return null; }
      return r.ok ? ((await r.json()).quest as Row) : null;
    })).then((list) => { if (alive) setRows(list.filter((x): x is Row => !!x)); });
    return () => { alive = false; };
  }, []);

  return (
    <Shell>
      <div className="rise mb-6 flex items-end justify-between gap-4">
        <div>
          <Eyebrow>Creator</Eyebrow>
          <h1 className="mt-2 font-display text-4xl tracking-tight">My quests</h1>
        </div>
        <Link href="/create" className="inline-flex min-h-11 items-center rounded-xl bg-lantern px-4 font-semibold text-ink hover:brightness-110">
          New quest
        </Link>
      </div>
      {rows === null ? (
        <p className="text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <Card>
          <p className="font-display text-xl">No quests in this browser yet</p>
          <p className="mt-2 text-sm text-muted">Quests you create here show up on this page. On another device, open your private manage link once.</p>
        </Card>
      ) : (
        <ul className="space-y-3">
          {rows.map((q) => {
            const st = STATUS[q.status] ?? { label: q.status, tone: "border-line text-muted" };
            const w = winnerLine(q.winner);
            return (
              <li key={q.id}>
                <Link href={`/manage/${q.id}`} className="block rounded-2xl border border-line bg-panel/80 p-4 transition hover:border-lantern/50">
                  <span className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate font-display text-xl text-fg">{q.title}</span>
                      <span className="mt-0.5 block text-sm text-muted">
                        {CATEGORY_LABEL[q.rewardCategory] ?? q.rewardCategory} · up to {formatInr(q.rewardCapInr)}
                      </span>
                    </span>
                    <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs ${st.tone}`}>{st.label}</span>
                  </span>
                  {w && <span className="mt-2 block text-sm text-fg/80">{w}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Shell>
  );
}
