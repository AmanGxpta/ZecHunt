import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-10 px-4 py-16">
      <header className="space-y-4">
        <p className="text-xs uppercase tracking-[0.25em] text-amber-300/80">Zechunt · Testnet demo</p>
        <h1 className="text-4xl font-semibold leading-tight text-white">
          Hide a real reward behind a real-world challenge.
        </h1>
        <p className="text-base leading-7 text-zinc-300">
          Fund a quest privately with shielded Zcash testnet funds, share the link, and let the first person
          who solves the challenge win a real Bitrefill reward. No wallet is needed to play.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <Link
          href="/create"
          className="rounded-xl bg-amber-300 px-5 py-4 text-center font-semibold text-zinc-950 transition hover:bg-amber-200"
        >
          Create a quest
        </Link>
        <p className="self-center text-sm text-zinc-400">
          Got a link? Open it to see the clue and enter the checkpoint code.
        </p>
      </div>

      <p className="text-xs leading-5 text-zinc-500">
        Testnet only. TAZ has no value. Mock providers are labelled wherever they are used.
      </p>
    </main>
  );
}
