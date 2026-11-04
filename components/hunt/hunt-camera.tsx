"use client";

// Full-screen hunt camera: scan the checkpoint QR, then a chest appears over the live
// camera view. Tap it to open, then pick the reward. Works without true AR, so it runs
// on iPhone and Android alike; if the camera is unavailable a backdrop is drawn instead.
import { useCallback, useEffect, useState } from "react";
import { Chest } from "./chest";
import { parsePayload, useQrScanner } from "./scanner";
import { useCamera, useTilt } from "./use-camera";

export type SubmitResult = { ok: true } | { ok: false; error: string; message: string };

type Phase = "scanning" | "checking" | "appear" | "closed" | "opening" | "open" | "beaten" | "locked";

export function HuntCamera({
  questId, questTitle, startWon = false, submitCode, onClose, onDone,
}: {
  questId: string;
  questTitle: string;
  /** Opened after a typed code already won: skip scanning, go straight to the chest. */
  startWon?: boolean;
  submitCode: (code: string) => Promise<SubmitResult>;
  onClose: () => void;
  /** The chest is open: show the reward picker. */
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<Phase>(startWon ? "appear" : "scanning");
  const [toast, setToast] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [taps, setTaps] = useState(0);
  const { videoRef, state: cam } = useCamera(true);
  const tilt = useTilt(true);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600);
  }, []);

  const onScan = useCallback(async (text: string) => {
    if (phase !== "scanning" || Date.now() < cooldownUntil) return;
    const parsed = parsePayload(text, questId);
    if (parsed.kind !== "code") {
      setCooldownUntil(Date.now() + 2500);
      flash(parsed.kind === "other_quest" ? "That checkpoint belongs to a different quest." : "That’s not a zecHunt checkpoint.");
      return;
    }
    setPhase("checking");
    navigator.vibrate?.(30);
    const r = await submitCode(parsed.code);
    if (r.ok) { setPhase("appear"); return; }
    if (r.error === "quest_exhausted") { setPhase("beaten"); return; }
    if (r.error === "too_many_attempts") { setPhase("locked"); return; }
    setCooldownUntil(Date.now() + 2000);
    flash(r.message);
    setPhase("scanning");
  }, [phase, cooldownUntil, questId, submitCode, flash]);

  useQrScanner(videoRef, phase === "scanning" && cam === "on", onScan);

  // The chest lands, then waits for a tap.
  useEffect(() => {
    if (phase !== "appear") return;
    navigator.vibrate?.([40, 60, 40]);
    const t = window.setTimeout(() => setPhase("closed"), 900);
    return () => window.clearTimeout(t);
  }, [phase]);

  useEffect(() => {
    if (phase !== "opening") return;
    const t = window.setTimeout(() => { setPhase("open"); navigator.vibrate?.([60, 40, 120]); }, 450);
    return () => window.clearTimeout(t);
  }, [phase]);

  function tapChest() {
    if (phase !== "closed") return;
    // Two quick taps to "unlock" make it feel physical; the second one opens it.
    if (taps === 0) { setTaps(1); navigator.vibrate?.(20); return; }
    setPhase("opening");
  }

  const showChest = phase === "appear" || phase === "closed" || phase === "opening" || phase === "open" || phase === "beaten";
  const chestState = phase === "open" ? "open" : phase === "beaten" ? "empty" : "closed";
  const parallax = `translate(${tilt.x * 16}px, ${tilt.y * 10}px) rotateY(${tilt.x * 8}deg)`;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-ink text-fg" role="dialog" aria-modal aria-label="Hunt camera">
      {/* camera feed, or a backdrop when there is no camera */}
      <video ref={videoRef} playsInline muted className={`absolute inset-0 h-full w-full object-cover ${cam === "on" ? "" : "hidden"}`} />
      {cam !== "on" && (
        <div className="absolute inset-0" style={{ background: "radial-gradient(120% 80% at 50% 30%, #1f3a30 0%, #0a0f0d 70%)" }} />
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/50 via-transparent to-black/70" />

      {/* top bar */}
      <div className="absolute inset-x-0 top-0 flex items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <button onClick={onClose} aria-label="Close camera"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-black/45 text-xl backdrop-blur">‹</button>
        <p className="max-w-[60%] truncate rounded-full bg-black/45 px-3 py-1.5 text-sm backdrop-blur">{questTitle}</p>
        <span className="h-10 w-10" />
      </div>

      {/* scanning reticle */}
      {(phase === "scanning" || phase === "checking") && (
        <div className="absolute inset-0 flex flex-col items-center justify-center px-6">
          <div className="relative h-64 w-64">
            {["left-0 top-0 border-l-4 border-t-4 rounded-tl-2xl", "right-0 top-0 border-r-4 border-t-4 rounded-tr-2xl",
              "left-0 bottom-0 border-l-4 border-b-4 rounded-bl-2xl", "right-0 bottom-0 border-r-4 border-b-4 rounded-br-2xl"].map((c) => (
              <span key={c} className={`absolute h-12 w-12 border-lantern ${c}`} />
            ))}
            {phase === "scanning" && cam === "on" && <span className="scan-line absolute left-3 right-3 h-0.5 bg-lantern shadow-[0_0_14px_#f2b545]" />}
            {phase === "checking" && (
              <span className="absolute inset-0 flex items-center justify-center">
                <span className="h-12 w-12 animate-spin rounded-full border-4 border-lantern/30 border-t-lantern" />
              </span>
            )}
          </div>
          <p className="mt-8 rounded-2xl bg-black/50 px-4 py-3 text-center text-base backdrop-blur">
            {phase === "checking" ? "Checking the checkpoint…"
              : cam === "on" ? "Find the checkpoint and point your camera at its QR code"
              : cam === "starting" ? "Starting the camera…"
              : "Camera unavailable. Close this and type the six-digit code instead."}
          </p>
        </div>
      )}

      {/* the chest */}
      {showChest && (
        <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ perspective: 900 }}>
          <div style={{ transform: parallax, transition: "transform .15s ease-out" }}>
            <button type="button" onClick={tapChest} disabled={phase !== "closed"} aria-label="Open the treasure chest"
              className={`block ${phase === "appear" ? "chest-arrive" : phase === "closed" ? "chest-float" : ""}`}>
              <Chest state={chestState} shaking={phase === "opening" || (phase === "closed" && taps === 1)} />
            </button>
          </div>
          {phase === "closed" && (
            <p className="mt-6 rounded-full bg-black/55 px-4 py-2 text-base backdrop-blur">
              {taps === 0 ? "You found it! Tap the chest" : "Again! Open it"}
            </p>
          )}
        </div>
      )}

      {/* bottom sheets */}
      {phase === "open" && (
        <div className="sheet-up absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-lantern/40 bg-panel/95 px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-5 backdrop-blur">
          <p className="text-[11px] uppercase tracking-[0.22em] text-lantern">First to the checkpoint</p>
          <p className="mt-1 font-display text-3xl">The treasure is yours 🏆</p>
          <p className="mt-1 text-sm text-muted">Pick a real voucher. Nothing is bought until you confirm.</p>
          <button onClick={onDone} className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-lantern font-semibold text-ink">
            Choose my reward →
          </button>
        </div>
      )}
      {phase === "beaten" && (
        <div className="sheet-up absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-line bg-panel/95 px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-5 backdrop-blur">
          <p className="font-display text-3xl">So close!</p>
          <p className="mt-1 text-muted">Someone opened this chest moments before you. Your code was right; you were just second.</p>
          <button onClick={onClose} className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-line font-semibold">
            Back to the quest
          </button>
        </div>
      )}
      {phase === "locked" && (
        <div className="sheet-up absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-line bg-panel/95 px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-5 backdrop-blur">
          <p className="font-display text-2xl">Too many tries</p>
          <p className="mt-1 text-muted">Take a breather and try again in a few minutes.</p>
          <button onClick={onClose} className="mt-4 inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-line font-semibold">Close</button>
        </div>
      )}

      {toast && (
        <p role="status" className="absolute inset-x-6 top-20 rounded-xl bg-ember/90 px-4 py-3 text-center text-sm text-ink">{toast}</p>
      )}
    </div>
  );
}
