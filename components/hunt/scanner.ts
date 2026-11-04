"use client";

import jsQR from "jsqr";
import { useEffect, useRef } from "react";

/** Checkpoint QR payload: zechunt:<questId>:<six-digit code>. */
export function checkpointPayload(questId: string, code: string): string {
  return `zechunt:${questId}:${code}`;
}

export type ScanResult = { kind: "code"; code: string } | { kind: "other_quest" } | { kind: "not_checkpoint" };

export function parsePayload(text: string, questId: string): ScanResult {
  const m = /^zechunt:([A-Za-z0-9_-]{4,64}):(\d{6})$/.exec(text.trim());
  if (!m) return { kind: "not_checkpoint" };
  return m[1] === questId ? { kind: "code", code: m[2] } : { kind: "other_quest" };
}

/** Reads QR codes from the video a few times a second while active. */
export function useQrScanner(videoRef: React.RefObject<HTMLVideoElement | null>, active: boolean, onText: (text: string) => void) {
  const cb = useRef(onText);
  useEffect(() => { cb.current = onText; }, [onText]);

  useEffect(() => {
    if (!active) return;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let raf = 0, last = 0, alive = true;
    const loop = (t: number) => {
      if (!alive) return;
      raf = requestAnimationFrame(loop);
      const v = videoRef.current;
      if (!ctx || !v || v.readyState < 2 || t - last < 160) return;
      last = t;
      const w = 480, h = Math.round((v.videoHeight / Math.max(1, v.videoWidth)) * w) || 360;
      canvas.width = w; canvas.height = h;
      ctx.drawImage(v, 0, 0, w, h);
      const hit = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" });
      if (hit?.data) cb.current(hit.data);
    };
    raf = requestAnimationFrame(loop);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [active, videoRef]);
}
