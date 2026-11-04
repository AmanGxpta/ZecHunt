import { Suspense } from "react";
import CheckpointView from "./checkpoint-view";

export default function Page({ params }: PageProps<"/checkpoint/[id]">) {
  return <Suspense fallback={null}>{params.then(({ id }) => <CheckpointView id={id} />)}</Suspense>;
}
