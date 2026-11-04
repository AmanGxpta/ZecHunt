import { Suspense } from "react";
import PlayerView from "./player-view";

export default function Page({ params }: PageProps<"/q/[id]">) {
  return <Suspense fallback={null}>{params.then(({ id }) => <PlayerView id={id} />)}</Suspense>;
}
