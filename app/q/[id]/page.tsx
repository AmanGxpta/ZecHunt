import { Suspense } from "react";
import PlayerView from "./player-view";

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<main className="mx-auto max-w-xl px-4 py-16 text-zinc-400">Loading…</main>}>
      <QuestPage params={params} />
    </Suspense>
  );
}

async function QuestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlayerView id={id} />;
}
