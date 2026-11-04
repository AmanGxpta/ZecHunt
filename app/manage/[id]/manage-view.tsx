"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Qr } from "@/components/qr";
import {
  Button, Card, CATEGORY_LABEL, CopyField, ErrorNote, Eyebrow, formatInr, formatTaz, ModeBadge, Shell, Spinner,
} from "@/components/ui";
import { loadSecrets, type CreatorSecrets } from "@/lib/client/creator-store";

type Mode = "mock" | "live";
interface CreatorQuest {
  id: string; title: string; clue: string; rewardCategory: string; rewardCapCents: number; rewardCapInr: number;
  status: "awaiting_funding" | "active" | "paused" | "exhausted" | "cancelled"; fundingAddress: string;
  expectedZatoshis: number; fundedZatoshis: number; activatedAt: number | null; zcashMode: Mode;
  fundingEvents: { txid: string; amountZatoshis: number; confirmations: number }[];
  winner: { claimStatus: string; productName: string | null; purchaseState: string | null; providerMode: string | null } | null;
}
interface Resp { quest: CreatorQuest; modes: { zcash: Mode; bitrefill: Mode }; syncing: boolean }

export default function ManageView({ id }: { id: string }) {
  const [secrets, setSecrets] = useState<CreatorSecrets | null | undefined>(undefined);
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [origin, setOrigin] = useState("");
  const busy = useRef(false);
  const status = useRef<CreatorQuest["status"] | null>(null);

  useEffect(() => {
    // Secrets come from localStorage or the #fragment; both exist only in the browser.
    const s = loadSecrets(id);
    queueMicrotask(() => { setSecrets(s); setOrigin(window.location.origin); });
  }, [id]);

  useEffect(() => {
    if (!secrets) return;
    let alive = true;
    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        // POST scans the wallet while awaiting funding; GET just reads state.
        const res = await fetch(`/api/quests/${id}/funding`, {
          method: status.current === "awaiting_funding" || status.current === null ? "POST" : "GET",
          headers: { "x-creator-token": secrets.creatorToken },
        });
        const body = await res.json();
        if (!alive) return;
        if (!res.ok) setError(body.message ?? body.error);
        else { status.current = body.quest.status; setData(body); setError(null); }
      } catch {
        if (alive) setError("Lost connection, retrying…");
      } finally {
        busy.current = false;
      }
    };
    tick();
    const t = setInterval(tick, 5_000);
    return () => { alive = false; clearInterval(t); };
  }, [id, secrets]);

  async function simulate() {
    if (!secrets || !data) return;
    setSimulating(true);
    try {
      await fetch("/api/dev/simulate-funding", {
        method: "POST",
        headers: { "content-type": "application/json", "x-creator-token": secrets.creatorToken },
        body: JSON.stringify({ questId: id, amountZatoshis: data.quest.expectedZatoshis }),
      });
    } finally {
      setSimulating(false);
    }
  }

  if (secrets === undefined) return <Shell><p className="text-muted">Loading…</p></Shell>;
  if (secrets === null) {
    return (
      <Shell>
        <Card>
          <h1 className="font-display text-2xl">This browser can’t manage this quest</h1>
          <p className="mt-2 text-muted">Open the private manage link you saved when you created it.</p>
        </Card>
      </Shell>
    );
  }
  if (!data) return <Shell>{error ? <ErrorNote>{error}</ErrorNote> : <p className="text-muted">Loading quest…</p>}</Shell>;

  const q = data.quest;
  const playUrl = `${origin}/q/${q.id}`;
  const checkpointUrl = `${origin}/checkpoint/${q.id}#k=${encodeURIComponent(secrets.checkpointKey)}`;
  const manageUrl = `${origin}/manage/${q.id}#t=${encodeURIComponent(secrets.creatorToken)}&k=${encodeURIComponent(secrets.checkpointKey)}`;
  const taz = (q.expectedZatoshis / 1e8).toString();
  const zip321 = `zcash:${q.fundingAddress}?amount=${taz}&message=${encodeURIComponent(`zecHunt ${q.title}`)}`;
  const funded = q.status !== "awaiting_funding" && q.status !== "cancelled";

  return (
    <Shell wide>
      <div className="rise mb-6">
        <Eyebrow>Your quest</Eyebrow>
        <h1 className="mt-2 font-display text-4xl tracking-tight">{q.title}</h1>
        <p className="mt-2 text-muted">
          {CATEGORY_LABEL[q.rewardCategory]} · up to {formatInr(q.rewardCapInr)} · 1 winner
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <ModeBadge mode={q.zcashMode} what="Zcash funding" />
          {data.modes.bitrefill === "mock" && <ModeBadge mode={data.modes.bitrefill} what="Bitrefill reward" />}
        </div>
      </div>

      <Steps status={q.status} winner={!!q.winner} />

      {error && <div className="mb-4"><ErrorNote>{error}</ErrorNote></div>}

      <Controls quest={q} token={secrets.creatorToken} onChange={(next) => { status.current = next.quest.status; setData(next); }} />

      {q.status === "cancelled" ? (
        <Card>
          <h2 className="font-display text-2xl">Cancelled</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            Players see that this quest was called off, and the checkpoint code no longer works. No reward was bought.
            Testnet TAZ sent to fund it isn’t returned; it has no monetary value.
          </p>
        </Card>
      ) : !funded ? (
        <Card className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-display text-2xl">Fund it privately</h2>
              <p className="mt-1 text-sm leading-6 text-muted">
                Send <span className="font-mono text-fg">{formatTaz(q.expectedZatoshis)}</span> from any NU7 testnet
                wallet to this quest’s own shielded address. It goes live after one confirmation.
              </p>
            </div>
          </div>
          <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
            <Qr value={zip321} size={184} label="Zcash payment request QR code" />
            <div className="w-full min-w-0 space-y-4">
              <CopyField label="Shielded address (Ironwood, testnet)" value={q.fundingAddress} />
              <CopyField label="Amount" value={taz} />
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-xl border border-line bg-ink-2 px-4 py-3 text-sm">
            <span className="relative flex h-3 w-3 text-lantern"><span className="pulse-ring absolute inset-0" /><span className="relative h-3 w-3 rounded-full bg-lantern" /></span>
            <span className="text-muted">
              {q.fundingEvents.length
                ? `Payment seen: ${formatTaz(q.fundedZatoshis)} confirmed of ${formatTaz(q.expectedZatoshis)}. Waiting for confirmations…`
                : data.syncing ? "Scanning the shielded wallet for your payment…" : "Watching for your shielded payment…"}
            </span>
          </div>
          {q.zcashMode === "mock" && (
            <div className="rounded-xl border border-ember/30 bg-ember/5 p-4">
              <p className="text-sm text-ember">Zcash is in mock mode. No real wallet is connected.</p>
              <Button variant="ghost" onClick={simulate} disabled={simulating} className="mt-3 w-full">
                {simulating ? <Spinner /> : null} Simulate a shielded payment (mock)
              </Button>
            </div>
          )}
        </Card>
      ) : (
        <>
          <Card className="mb-4">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-moss/15 text-moss">✓</span>
              <div>
                <h2 className="font-display text-xl">Funded privately</h2>
                <p className="text-sm text-muted">{formatTaz(q.fundedZatoshis)} received in a shielded note.</p>
              </div>
            </div>
            {q.fundingEvents.map((e) => (
              <div key={e.txid} className="mt-3 rounded-lg border border-line bg-ink-2 px-3 py-2 font-mono text-xs text-muted">
                {q.zcashMode === "live" ? (
                  <a className="break-all hover:text-lantern" href={`https://zexplorer.app/testnet/tx/${e.txid}`} target="_blank" rel="noreferrer">
                    tx {e.txid}
                  </a>
                ) : <span className="break-all">tx {e.txid} (simulated)</span>}
                <span className="block">{e.confirmations} confirmation{e.confirmations === 1 ? "" : "s"}</span>
              </div>
            ))}
          </Card>

          <div className="grid gap-4 sm:grid-cols-2">
            <Card className="space-y-4">
              <h2 className="font-display text-xl">Share with players</h2>
              <div className="flex justify-center"><Qr value={playUrl} size={168} label="Quest link QR code" /></div>
              <CopyField label="Quest link (public)" value={playUrl} />
            </Card>
            <Card className="space-y-4">
              <h2 className="font-display text-xl">Staff the checkpoint</h2>
              <p className="text-sm leading-6 text-muted">
                Open this on the phone at the checkpoint. It shows a code that changes every minute, so a photo of
                it goes stale.
              </p>
              <Link href={checkpointUrl} target="_blank"
                className="inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-lantern font-semibold text-ink hover:brightness-110">
                Open checkpoint display
              </Link>
              <CopyField label="Checkpoint link (keep private)" value={checkpointUrl} />
            </Card>
          </div>

          <Card className="mt-4">
            <h2 className="font-display text-xl">Winner</h2>
            {!q.winner ? (
              <p className="mt-1 text-sm text-muted">Nobody has found it yet.</p>
            ) : (
              <div className="mt-2 space-y-1 text-sm">
                <p>Found! Claim status: <span className="font-mono text-lantern">{q.winner.claimStatus}</span></p>
                {q.winner.productName && (
                  <p className="text-muted">
                    Reward: {q.winner.productName} · <span className="font-mono">{q.winner.purchaseState}</span>
                    {q.winner.providerMode === "mock" && " · simulated"}
                  </p>
                )}
              </div>
            )}
          </Card>
        </>
      )}

      <details className="mt-6 rounded-2xl border border-line p-4 text-sm text-muted">
        <summary className="cursor-pointer text-fg">Private manage link</summary>
        <p className="my-3">Bookmark this to manage the quest from another device. Anyone with it controls the quest.</p>
        <CopyField label="Manage link" value={manageUrl} />
      </details>
    </Shell>
  );
}

function Controls({ quest, token, onChange }: { quest: CreatorQuest; token: string; onChange: (r: Resp) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "pause" | "resume" | "cancel") {
    setBusy(action); setError(null);
    try {
      const r = await fetch(`/api/quests/${quest.id}/control`, {
        method: "POST", headers: { "content-type": "application/json", "x-creator-token": token }, body: JSON.stringify({ action }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message ?? "That didn’t work");
      onChange(d); setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn’t work");
    } finally {
      setBusy(null);
    }
  }

  const canCancel = !quest.winner && quest.status !== "cancelled" && quest.status !== "exhausted";
  return (
    <div className="mb-4 space-y-2">
      {quest.status === "paused" && (
        <div className="rounded-xl border border-lantern/40 bg-lantern/5 px-4 py-3 text-sm text-fg">
          Paused. Players can’t claim and the checkpoint shows a pause notice.
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {quest.status === "active" && (
          <Button variant="ghost" onClick={() => act("pause")} disabled={!!busy}>{busy === "pause" ? <Spinner /> : "Pause"}</Button>
        )}
        {quest.status === "paused" && (
          <Button onClick={() => act("resume")} disabled={!!busy}>{busy === "resume" ? <Spinner /> : "Resume"}</Button>
        )}
        <Link href={`/create?from=${quest.id}`}
          className="inline-flex min-h-12 items-center justify-center rounded-xl border border-line px-5 font-semibold text-fg hover:border-lantern/60 hover:text-lantern">
          Run it again
        </Link>
        {canCancel && !confirming && (
          <Button variant="ghost" onClick={() => setConfirming(true)} disabled={!!busy}>Cancel quest</Button>
        )}
      </div>
      {confirming && (
        <div className="rounded-xl border border-ember/40 bg-ember/5 p-4 text-sm">
          <p className="text-fg">Cancel “{quest.title}”? Players will see it was called off. This can’t be undone.</p>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => act("cancel")} disabled={!!busy}>{busy === "cancel" ? <Spinner /> : "Yes, cancel it"}</Button>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={!!busy}>Keep it</Button>
          </div>
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

function Steps({ status, winner }: { status: CreatorQuest["status"]; winner: boolean }) {
  const idx = status === "awaiting_funding" ? 0 : winner ? 2 : 1;
  const labels = ["Fund", "Live", "Found"];
  return (
    <ol className="mb-5 flex items-center gap-2 text-xs">
      {labels.map((l, i) => (
        <li key={l} className="flex flex-1 items-center gap-2">
          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono ${i < idx ? "border-moss bg-moss/15 text-moss" : i === idx ? "border-lantern text-lantern" : "border-line text-muted"}`}>
            {i < idx ? "✓" : i + 1}
          </span>
          <span className={i <= idx ? "text-fg" : "text-muted"}>{l}</span>
          {i < labels.length - 1 && <span className={`h-px flex-1 ${i < idx ? "bg-moss/50" : "bg-line"}`} />}
        </li>
      ))}
    </ol>
  );
}
