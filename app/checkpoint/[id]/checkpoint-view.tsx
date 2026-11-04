"use client";

import { useEffect, useState } from "react";
import { ErrorNote, Mark } from "@/components/ui";
import { loadSecrets } from "@/lib/client/creator-store";

interface CodeResp { code: string; expiresAt: number; title: string; status: string }

/** Full-screen rotating code for whoever staffs the checkpoint. */
export default function CheckpointView({ id }: { id: string }) {
  const [code, setCode] = useState<CodeResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const frag = new URLSearchParams(window.location.hash.slice(1));
    const key = frag.get("k") ?? loadSecrets(id)?.checkpointKey ?? null;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const res = await fetch(`/api/quests/${id}/checkpoint/code`, {
          headers: key ? { "x-checkpoint-key": key } : {}, cache: "no-store",
        });
        const body = await res.json();
        if (!alive) return;
        if (!res.ok) { setError(body.message ?? "This checkpoint link is not valid."); return; }
        setCode(body); setError(null);
        timer = setTimeout(load, Math.max(500, body.expiresAt - Date.now() + 250));
      } catch {
        if (alive) { setError("Offline, retrying…"); timer = setTimeout(load, 3_000); }
      }
    };
    load();
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => { alive = false; clearTimeout(timer); clearInterval(tick); };
  }, [id]);

  const left = code ? Math.max(0, code.expiresAt - now) : 0;
  const pct = code ? left / 60_000 : 0;

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-4 py-10 text-center">
      <div className="flex items-center gap-2 text-muted"><Mark size={22} /> <span className="text-sm">Checkpoint</span></div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {code && (
        <>
          <h1 className="font-display text-2xl">{code.title}</h1>
          {code.status === "exhausted" ? (
            <p className="max-w-sm text-lg text-muted">This quest has been won. You can stop showing the code.</p>
          ) : code.status !== "active" ? (
            <p className="max-w-sm text-lg text-muted">Waiting for the quest to be funded. The code will work once it’s live.</p>
          ) : null}
          {code.status === "active" && (<>
          <div className="relative">
            <svg width="300" height="300" viewBox="0 0 100 100" className="-rotate-90" aria-hidden>
              <circle cx="50" cy="50" r="46" fill="none" stroke="var(--line)" strokeWidth="2" />
              <circle cx="50" cy="50" r="46" fill="none" stroke="var(--lantern)" strokeWidth="2.5" strokeLinecap="round"
                strokeDasharray={`${pct * 289} 289`} style={{ transition: "stroke-dasharray .25s linear" }} />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <p aria-live="polite" className="whitespace-nowrap font-mono text-5xl font-semibold tracking-[0.08em] text-lantern">
                {code.code.slice(0, 3)}<span className="text-lantern/40"> </span>{code.code.slice(3)}
              </p>
              <p className="mt-3 font-mono text-sm text-muted">changes in {Math.ceil(left / 1000)}s</p>
            </div>
          </div>
          <p className="max-w-sm text-sm leading-6 text-muted">
            Show this to players who reach you. They type it into the quest page. The first one to do it wins.
          </p>
          </>)}
        </>
      )}
    </main>
  );
}
