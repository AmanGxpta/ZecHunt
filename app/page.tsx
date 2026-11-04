import Link from "next/link";
import { Mark, MyQuestsLink } from "@/components/ui";

const steps = [
  { n: "01", t: "Fund it privately", d: "Activate your quest with a shielded Zcash testnet payment. The chain hides who paid, and how much." },
  { n: "02", t: "Hide the checkpoint", d: "Put a rotating six-digit code somewhere real: a person, a poster, a phone at the venue." },
  { n: "03", t: "First finder wins", d: "Players need only a link. The first verified finder gets a real Bitrefill reward, bought by an agent inside hard limits." },
];

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pb-16 pt-6">
      <header className="mb-14 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Mark />
          <span className="font-display text-lg tracking-tight">zec<span className="text-lantern">Hunt</span></span>
        </div>
        <span className="flex items-center gap-3">
          <MyQuestsLink />
          <span className="rounded-full border border-line px-2.5 py-1 text-[11px] uppercase tracking-[0.18em] text-muted">Testnet</span>
        </span>
      </header>

      <section className="rise space-y-6">
        <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-lantern/80">A treasure hunt with real loot</p>
        <h1 className="font-display text-[2.6rem] leading-[1.05] tracking-tight sm:text-6xl">
          Hide a real reward <br className="hidden sm:block" />
          <span className="italic text-lantern">somewhere in the world.</span>
        </h1>
        <p className="max-w-xl text-lg leading-8 text-muted">
          Write a clue, fund it with shielded Zcash, and share a link. Whoever reaches your checkpoint first wins a
          real digital reward. No wallet or sign-up needed to play.
        </p>
        <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center">
          <Link href="/create" className="inline-flex min-h-12 items-center justify-center rounded-xl bg-lantern px-6 font-semibold text-ink transition hover:brightness-110">
            Hide a reward →
          </Link>
          <Link href="/demo" className="inline-flex min-h-12 items-center justify-center rounded-xl border border-line px-6 font-semibold transition hover:border-lantern/60">
            ▶ Watch the demo
          </Link>
        </div>
      </section>

      <ol className="mt-16 grid gap-3 sm:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.n} className="rise rounded-2xl border border-line bg-panel/70 p-5" style={{ animationDelay: `${120 + i * 90}ms` }}>
            <p className="font-mono text-xs text-lantern">{s.n}</p>
            <h2 className="mt-3 font-display text-xl">{s.t}</h2>
            <p className="mt-2 text-sm leading-6 text-muted">{s.d}</p>
          </li>
        ))}
      </ol>

      <p className="mt-12 text-xs leading-5 text-muted/80">
        Zcash testnet only. TAZ has no monetary value and does not pay for the reward. Rewards come from a capped
        Bitrefill budget. Anything simulated is labelled as simulated.
      </p>
    </main>
  );
}
