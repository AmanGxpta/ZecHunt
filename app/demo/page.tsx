import type { Metadata } from "next";
import Link from "next/link";
import { Shell } from "@/components/ui";

export const metadata: Metadata = { title: "zecHunt · Product demo" };

// The demo video lives in public/demo.mp4 (H.264 MP4, ideally under 50 MB).
export default function DemoPage() {
  return (
    <Shell wide>
      <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-lantern/80">Product demo</p>
      <h1 className="mt-2 font-display text-4xl leading-tight tracking-tight">See a hunt from start to finish</h1>
      <p className="mt-3 text-muted">
        A creator funds a quest with shielded ZEC, a player scans the checkpoint and opens the chest,
        and an agent buys a real Bitrefill gift card for the winner.
      </p>
      <div className="mt-6 overflow-hidden rounded-2xl border border-line bg-black">
        <video src="/demo.mp4" controls playsInline preload="metadata" className="aspect-video w-full">
          Your browser can’t play this video. <a href="/demo.mp4">Download it</a> instead.
        </video>
      </div>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Link href="/create" className="inline-flex min-h-12 items-center justify-center rounded-xl bg-lantern px-6 font-semibold text-ink hover:brightness-110">
          Try it: hide a reward →
        </Link>
        <a href="https://github.com/AmanGxpta/ZecHunt" className="inline-flex min-h-12 items-center justify-center rounded-xl border border-line px-6 font-semibold hover:border-lantern/60">
          Source on GitHub
        </a>
      </div>
    </Shell>
  );
}
