"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { listManagedQuests } from "@/lib/client/creator-store";

export function Shell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className={`mx-auto flex w-full ${wide ? "max-w-3xl" : "max-w-xl"} flex-1 flex-col px-4 pb-16 pt-6`}>
      <header className="mb-8 flex items-center justify-between">
        <Link href="/" className="group flex items-center gap-2" aria-label="zecHunt home">
          <Mark />
          <span className="font-display text-lg tracking-tight text-fg">
            zec<span className="text-lantern">Hunt</span>
          </span>
        </Link>
        <span className="flex items-center gap-3">
          <MyQuestsLink />
          <span className="rounded-full border border-line px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-muted">
            Testnet
          </span>
        </span>
      </header>
      {children}
    </div>
  );
}

/** Shown only in browsers that created (or opened the manage link of) a quest. */
export function MyQuestsLink() {
  const [show, setShow] = useState(false);
  useEffect(() => { const has = listManagedQuests().length > 0; queueMicrotask(() => setShow(has)); }, []);
  return show ? <Link href="/quests" className="text-sm text-muted hover:text-lantern">My quests</Link> : null;
}

export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <circle cx="16" cy="16" r="14.5" fill="none" stroke="var(--lantern)" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="9" fill="none" stroke="var(--lantern)" strokeOpacity=".45" strokeWidth="1" strokeDasharray="2 3" />
      <path d="M16 6 L19 16 L16 26 L13 16 Z" fill="var(--lantern)" />
      <circle cx="16" cy="16" r="1.8" fill="var(--ink)" />
    </svg>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rise rounded-2xl border border-line bg-panel/80 p-5 backdrop-blur ${className}`}>{children}</section>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-lantern/80">{children}</p>;
}

export function Button({
  children, onClick, disabled, type = "button", variant = "primary", className = "",
}: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; type?: "button" | "submit";
  variant?: "primary" | "ghost"; className?: string;
}) {
  const base = "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-5 font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";
  const styles = variant === "primary"
    ? "bg-lantern text-ink hover:brightness-110 active:brightness-95"
    : "border border-line text-fg hover:border-lantern/60 hover:text-lantern";
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${styles} ${className}`}>
      {children}
    </button>
  );
}

export function CopyField({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <p className="mb-1.5 text-xs text-muted">{label}</p>
      <div className="flex items-stretch gap-2">
        <code className={`min-w-0 flex-1 break-all rounded-lg border border-line bg-ink-2 px-3 py-2 text-[13px] leading-5 text-fg ${mono ? "font-mono" : ""}`}>
          {value}
        </code>
        <button
          type="button"
          onClick={async () => {
            try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
          }}
          className="shrink-0 rounded-lg border border-line px-3 text-xs text-muted transition hover:border-lantern/60 hover:text-lantern"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/** Honest labelling: every simulated result says so. */
export function ModeBadge({ mode, what }: { mode: "mock" | "live"; what: string }) {
  return mode === "live" ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-moss/40 bg-moss/10 px-2.5 py-1 text-[11px] font-medium text-moss">
      <span className="h-1.5 w-1.5 rounded-full bg-moss" /> Live {what}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-ember/40 bg-ember/10 px-2.5 py-1 text-[11px] font-medium text-ember">
      <span className="h-1.5 w-1.5 rounded-full bg-ember" /> Simulated {what}
    </span>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <p role="alert" className="rounded-lg border border-ember/40 bg-ember/10 px-3 py-2 text-sm text-ember">{children}</p>;
}

export function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden />;
}

export function formatUsd(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatInr(inr: number) {
  return `₹${inr.toLocaleString("en-IN")}`;
}

export function formatTaz(zatoshis: number) {
  return `${(zatoshis / 1e8).toFixed(zatoshis % 1e6 === 0 ? 2 : 8)} TAZ`;
}

export const CATEGORY_LABEL: Record<string, string> = {
  any: "Winner’s choice",
  food: "Food & drink voucher",
  shopping: "Shopping voucher",
  "mobile-recharge": "Mobile recharge",
  gaming: "Gaming credit",
};
