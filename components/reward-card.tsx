"use client";

// The winner's delivered reward: brand, code and PIN as separate copyable fields,
// expiry, how to redeem, and ways to keep it. The code is hidden until the winner
// taps Reveal, so showing the screen to a room doesn't leak it. SECRET: the
// redemption text is never logged, stored or sent anywhere by this component.
import { useMemo, useState } from "react";

interface Field { label: string; value: string }
interface Parsed { fields: Field[]; link: string | null; expires: string | null }

const LABELS: Record<string, string> = { "pin code": "PIN", pin: "PIN", code: "Code" };
const CATEGORY_ICON: Record<string, string> = { food: "🍔", shopping: "🛍️", gaming: "🎮" };

/** "Code: X\nPIN: Y\nValid until: 2027-03-30" → structured fields. Unknown shapes become one field. */
export function parseRedemption(text: string): Parsed {
  const fields: Field[] = [];
  let link: string | null = null, expires: string | null = null;
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = /^([^:]{1,40}):\s*(.+)$/.exec(line);
    if (!m) { fields.push({ label: "Code", value: line }); continue; }
    const key = m[1].trim().toLowerCase();
    if (key === "valid until") expires = m[2].trim();
    else if (key === "link" && /^https:\/\//.test(m[2].trim())) link = m[2].trim();
    else {
      const label = LABELS[key] ?? m[1].trim();
      if (!fields.some((f) => f.label === label && f.value === m[2].trim())) fields.push({ label, value: m[2].trim() });
    }
  }
  if (!fields.length && !link) fields.push({ label: "Code", value: text.trim() });
  return { fields, link, expires };
}

function formatExpiry(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T23:59:00`);
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : iso;
}

export function RewardCard({
  productName, category, logoUrl, redemption, simulated,
}: {
  productName: string;
  category: string | null;
  logoUrl: string | null;
  redemption: string | null;
  simulated: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const parsed = useMemo(() => (redemption ? parseRedemption(redemption) : null), [redemption]);
  const brand = productName.replace(/\s*₹\s*\d+.*$/, "").trim() || productName;
  const expiry = formatExpiry(parsed?.expires ?? null);
  const hasPin = parsed?.fields.some((f) => f.label === "PIN");

  async function copy(label: string, value: string) {
    try { await navigator.clipboard.writeText(value); setCopied(label); setTimeout(() => setCopied(null), 1500); } catch {}
  }

  async function saveCard() {
    if (!parsed) return;
    setSaving(true);
    try {
      const blob = await drawCard({ productName, fields: parsed.fields, expiry, simulated });
      const file = new File([blob], `${brand.replace(/\W+/g, "-").toLowerCase()}-voucher.png`, { type: "image/png" });
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
      if (nav.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: productName }); return; } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") return;
        }
      }
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: file.name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } finally {
      setSaving(false);
    }
  }

  async function shareToSelf() {
    if (!parsed) return;
    const text = [
      `${productName}${simulated ? " (SIMULATED, not a real code)" : ""}`,
      ...parsed.fields.map((f) => `${f.label}: ${f.value}`),
      ...(parsed.link ? [`Link: ${parsed.link}`] : []),
      ...(expiry ? [`Expires: ${expiry}`] : []),
      "Won on zecHunt",
    ].join("\n");
    try { await navigator.share({ title: productName, text }); } catch {}
  }

  const canShare = typeof navigator !== "undefined" && "share" in navigator;

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-moss text-moss">✓</span>
        <div>
          <p className="font-display text-2xl leading-tight">Your reward is ready</p>
          <p className="mt-1 text-sm text-muted">
            {simulated ? "Simulated purchase: this is not a real code." : `Add it in the ${brand} app or website to use it.`}
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-ink-2/80 p-4">
        <div className="flex items-center gap-3">
          {logoUrl
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={logoUrl} alt="" className="h-12 w-12 shrink-0 rounded-xl bg-white object-contain p-1" />
            : <span aria-hidden className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-panel text-2xl">{CATEGORY_ICON[category ?? ""] ?? "🎁"}</span>}
          <div className="min-w-0">
            <p className="truncate font-display text-xl">{productName}</p>
            {simulated && <p className="text-xs uppercase tracking-[0.18em] text-ember">Simulated</p>}
          </div>
        </div>

        {!parsed ? (
          <p className="mt-4 text-sm text-muted">Delivered. Fetching your code…</p>
        ) : (
          <div className="relative mt-4 space-y-2">
            {parsed.fields.map((f) => (
              <div key={f.label + f.value} className="flex items-center gap-3">
                <span className="w-12 shrink-0 text-sm text-muted">{f.label}</span>
                <div className="flex min-w-0 flex-1 items-center rounded-xl border border-line bg-ink px-3 py-2.5">
                  <span className={`min-w-0 flex-1 break-all font-mono text-lg tracking-[0.12em] ${revealed ? "text-fg" : "select-none text-muted blur-[6px]"}`}>
                    {revealed ? f.value : f.value.replace(/\S/g, "•")}
                  </span>
                  {revealed && (
                    <button onClick={() => copy(f.label, f.value)} aria-label={`Copy ${f.label}`}
                      className="ml-2 shrink-0 rounded-lg px-2 py-1 text-sm text-lantern hover:bg-lantern/10">
                      {copied === f.label ? "Copied ✓" : "Copy"}
                    </button>
                  )}
                </div>
              </div>
            ))}
            {!revealed && (
              <button onClick={() => setRevealed(true)}
                className="absolute inset-0 flex items-center justify-center rounded-xl bg-ink/30 font-semibold text-lantern backdrop-blur-[1px]">
                <span className="rounded-full border border-lantern/50 bg-ink/80 px-4 py-2">👁 Tap to reveal</span>
              </button>
            )}
            {parsed.link && revealed && (
              <a href={parsed.link} target="_blank" rel="noreferrer noopener"
                className="mt-1 inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-line text-sm font-semibold hover:border-lantern/60">
                Open voucher link ↗
              </a>
            )}
          </div>
        )}

        {expiry && <p className="mt-4 text-sm text-muted">📅 Expires on {expiry}</p>}
      </div>

      {parsed && (
        <div className="grid grid-cols-2 gap-2">
          <button onClick={saveCard} disabled={saving}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-lantern font-semibold text-ink hover:brightness-110 disabled:opacity-60">
            ⤓ {saving ? "Saving…" : "Save card"}
          </button>
          {canShare ? (
            <button onClick={shareToSelf}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-line font-semibold hover:border-lantern/60">
              ↗ Send to myself
            </button>
          ) : (
            <button onClick={() => copy("all", parsed.fields.map((f) => `${f.label}: ${f.value}`).join("\n"))}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-line font-semibold hover:border-lantern/60">
              {copied === "all" ? "Copied ✓" : "Copy all"}
            </button>
          )}
        </div>
      )}

      {parsed && !simulated && (
        <p className="text-xs leading-5 text-muted">
          How to use it: open {brand}, look for gift cards or vouchers, and enter the code{hasPin ? " and PIN" : ""}.
          Save it now; only this browser can show it again.
        </p>
      )}
    </div>
  );
}

/** A shareable image of the voucher, drawn locally. Nothing leaves the device unless the winner shares it. */
async function drawCard(input: { productName: string; fields: Field[]; expiry: string | null; simulated: boolean }): Promise<Blob> {
  const W = 1080, H = 600 + input.fields.length * 40;
  const c = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const g = c.getContext("2d")!;
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#1a1608"); bg.addColorStop(1, "#0a0f0d");
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.strokeStyle = "#f2b545"; g.lineWidth = 4;
  g.beginPath(); g.roundRect(24, 24, W - 48, H - 48, 36); g.stroke();
  g.fillStyle = "#f2b545"; g.font = "600 30px ui-sans-serif, system-ui";
  g.fillText("zecHunt · YOU FOUND IT 🏆", 72, 104);
  g.fillStyle = "#e9e4d6"; g.font = "700 60px Georgia, serif";
  g.fillText(input.productName, 72, 190);
  let y = 290;
  for (const f of input.fields) {
    g.fillStyle = "#9aa69f"; g.font = "500 30px ui-sans-serif, system-ui";
    g.fillText(f.label, 72, y);
    g.fillStyle = "#e9e4d6"; g.font = "600 46px ui-monospace, Menlo, monospace";
    g.fillText(f.value, 220, y + 4);
    y += 90;
  }
  if (input.expiry) {
    g.fillStyle = "#9aa69f"; g.font = "500 30px ui-sans-serif, system-ui";
    g.fillText(`Expires on ${input.expiry}`, 72, y + 10);
  }
  if (input.simulated) {
    g.fillStyle = "#ef6b4a"; g.font = "700 30px ui-sans-serif, system-ui";
    g.fillText("SIMULATED — NOT A REAL CODE", 72, H - 64);
  }
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas"))), "image/png"));
}
