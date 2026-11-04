import { Suspense } from "react";
import ManageView from "./manage-view";

export default function Page({ params }: PageProps<"/manage/[id]">) {
  return (
    <Suspense fallback={null}>
      {params.then(({ id }) => <ManageView id={id} />)}
    </Suspense>
  );
}
