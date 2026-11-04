"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";

export function Qr({ value, size = 200, label }: { value: string; size?: number; label: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toString(value, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0a0f0d", light: "#e9e4d6" } })
      .then((s) => { if (alive) setSvg(s); })
      .catch(() => {});
    return () => { alive = false; };
  }, [value]);
  return (
    <div
      role="img"
      aria-label={label}
      style={{ width: size, height: size }}
      className="overflow-hidden rounded-xl bg-fg p-1.5 [&>svg]:h-full [&>svg]:w-full"
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}
