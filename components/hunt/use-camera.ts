"use client";

import { useEffect, useRef, useState } from "react";

export type CameraState = "starting" | "on" | "denied" | "unavailable";

/** Rear camera into a <video>. Stops every track on unmount. */
export function useCamera(enabled: boolean) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<CameraState>("starting");

  useEffect(() => {
    if (!enabled) return;
    let stream: MediaStream | null = null;
    let alive = true;
    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) { setState("unavailable"); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (!alive) { stream.getTracks().forEach((t) => t.stop()); return; }
        const v = videoRef.current;
        if (v) { v.srcObject = stream; await v.play().catch(() => {}); }
        setState("on");
      } catch (e) {
        if (alive) setState(e instanceof DOMException && e.name === "NotAllowedError" ? "denied" : "unavailable");
      }
    };
    start();
    return () => { alive = false; stream?.getTracks().forEach((t) => t.stop()); };
  }, [enabled]);

  return { videoRef, state };
}

/** Gentle parallax from the phone's tilt. Returns -1..1 on each axis. */
export function useTilt(enabled: boolean) {
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (!enabled) return;
    const onTilt = (e: DeviceOrientationEvent) => {
      const x = Math.max(-1, Math.min(1, (e.gamma ?? 0) / 25));
      const y = Math.max(-1, Math.min(1, ((e.beta ?? 60) - 60) / 25));
      setTilt({ x, y });
    };
    window.addEventListener("deviceorientation", onTilt);
    return () => window.removeEventListener("deviceorientation", onTilt);
  }, [enabled]);
  return tilt;
}

/** iOS asks for motion access, and only inside a tap. Call from a click handler. */
export async function requestMotionAccess(): Promise<void> {
  const D = (globalThis as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
  try { await D?.requestPermission?.(); } catch { /* parallax is optional */ }
}
