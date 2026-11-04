import type { Metadata } from "next";
import MyQuests from "./my-quests";

export const metadata: Metadata = { title: "My quests · zecHunt" };

export default function Page() {
  return <MyQuests />;
}
