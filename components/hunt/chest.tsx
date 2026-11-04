"use client";

// Original treasure chest art: SVG body + a separate lid that swings open in 3D.
export type ChestState = "closed" | "open" | "empty";

const COINS = Array.from({ length: 16 }, (_, i) => {
  const a = (-90 + (i - 7.5) * 11) * (Math.PI / 180);
  const dist = 120 + ((i * 37) % 70);
  return { dx: Math.cos(a) * dist, dy: Math.sin(a) * dist - 40, delay: (i % 5) * 60, size: 16 + (i % 3) * 5 };
});

export function Chest({ state, shaking = false }: { state: ChestState; shaking?: boolean }) {
  const open = state !== "closed";
  const loot = state === "open";
  return (
    <div className={`relative h-[220px] w-[260px] ${shaking ? "chest-shake" : ""}`} style={{ perspective: 700 }}>
      {/* light rays + glow behind the chest */}
      {loot && <div className="rays pointer-events-none absolute -inset-40 rounded-full" aria-hidden />}
      <div aria-hidden className={`pointer-events-none absolute left-1/2 top-[38%] h-40 w-56 -translate-x-1/2 rounded-full blur-2xl transition-opacity duration-700 ${loot ? "opacity-100" : "opacity-30"}`}
        style={{ background: "radial-gradient(circle, #ffd77a 0%, #f2b54588 40%, transparent 70%)" }} />

      {/* treasure pile visible when the lid is up */}
      <svg viewBox="0 0 260 220" className="absolute inset-0" aria-hidden>
        <defs>
          <radialGradient id="gold" cx="50%" cy="40%" r="60%">
            <stop offset="0" stopColor="#fff2b8" /><stop offset=".45" stopColor="#ffd25e" /><stop offset="1" stopColor="#c9861c" />
          </radialGradient>
        </defs>
        {loot && (
          <g>
            <ellipse cx="130" cy="104" rx="88" ry="22" fill="url(#gold)" />
            {[[80, 96], [104, 90], [130, 88], [156, 91], [180, 97], [118, 98], [144, 99]].map(([x, y], i) => (
              <ellipse key={i} cx={x} cy={y} rx="11" ry="5" fill="#ffe08a" stroke="#c9861c" strokeWidth="1.5" />
            ))}
            <path d="M120 86 l6 -10 l8 0 l6 10 l-10 8 z" fill="#7fe0c0" stroke="#2f8f73" strokeWidth="1.5" />
          </g>
        )}
      </svg>

      {/* body */}
      <svg viewBox="0 0 260 220" className="absolute inset-0" aria-hidden>
        <defs>
          <linearGradient id="wood" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#9a5b2e" /><stop offset="1" stopColor="#5c321a" />
          </linearGradient>
          <linearGradient id="iron" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#c7c2b5" /><stop offset="1" stopColor="#6f6a60" />
          </linearGradient>
        </defs>
        <ellipse cx="130" cy="206" rx="100" ry="10" fill="#000" opacity=".35" />
        <rect x="30" y="100" width="200" height="100" rx="10" fill="url(#wood)" stroke="#3b200f" strokeWidth="3" />
        {[124, 150, 176].map((y) => <line key={y} x1="34" x2="226" y1={y} y2={y} stroke="#4a2814" strokeWidth="2" opacity=".55" />)}
        <rect x="48" y="100" width="18" height="100" fill="url(#iron)" stroke="#3d3a33" strokeWidth="2" />
        <rect x="194" y="100" width="18" height="100" fill="url(#iron)" stroke="#3d3a33" strokeWidth="2" />
        <rect x="30" y="100" width="200" height="12" fill="url(#iron)" stroke="#3d3a33" strokeWidth="2" />
        {[57, 203].flatMap((x) => [120, 160, 188].map((y) => <circle key={`${x}${y}`} cx={x} cy={y} r="2.6" fill="#2e2b26" />))}
        {/* lock */}
        <rect x="114" y="108" width="32" height="36" rx="6" fill="#e3b04b" stroke="#7a5414" strokeWidth="2.5" />
        <circle cx="130" cy="122" r="5" fill="#3b2508" />
        <rect x="128" y="124" width="4" height="11" fill="#3b2508" />
      </svg>

      {/* lid: hinged at the back edge, swings away from the viewer */}
      <div className="absolute left-0 right-0 top-0 h-[112px] transition-transform duration-[900ms]"
        style={{
          transformOrigin: "50% 100%",
          transformStyle: "preserve-3d",
          transform: open ? "rotateX(-118deg)" : "rotateX(0deg)",
          transitionTimingFunction: "cubic-bezier(.3, 1.6, .5, 1)",
        }}>
        <svg viewBox="0 0 260 112" className="h-full w-full" aria-hidden>
          <defs>
            <linearGradient id="lidwood" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#b06a37" /><stop offset="1" stopColor="#6e3c1e" />
            </linearGradient>
          </defs>
          <path d="M30 112 L30 62 Q30 22 130 18 Q230 22 230 62 L230 112 Z" fill="url(#lidwood)" stroke="#3b200f" strokeWidth="3" />
          <path d="M48 112 L48 44 Q52 34 66 30 L66 112 Z" fill="#a9a395" stroke="#3d3a33" strokeWidth="2" />
          <path d="M212 112 L212 44 Q208 34 194 30 L194 112 Z" fill="#a9a395" stroke="#3d3a33" strokeWidth="2" />
          <path d="M30 100 L230 100 L230 112 L30 112 Z" fill="#b9b3a5" stroke="#3d3a33" strokeWidth="2" />
          <path d="M70 52 Q130 36 190 52" stroke="#e9a868" strokeWidth="3" fill="none" opacity=".5" />
          <path d="M120 112 L120 96 Q130 88 140 96 L140 112 Z" fill="#e3b04b" stroke="#7a5414" strokeWidth="2" />
        </svg>
      </div>

      {/* coins burst out once */}
      {loot && COINS.map((c, i) => (
        <span key={i} className="coin pointer-events-none absolute left-1/2 top-[44%] rounded-full border-2 border-[#b07a12]"
          style={{
            width: c.size, height: c.size, marginLeft: -c.size / 2,
            background: "radial-gradient(circle at 35% 35%, #fff4c2, #f5c542 55%, #c98a17)",
            animationDelay: `${c.delay}ms`,
            ["--dx" as string]: `${c.dx}px`, ["--dy" as string]: `${c.dy}px`,
          }} />
      ))}
      {loot && [[-110, -30], [100, -60], [-60, -110], [70, 10]].map(([x, y], i) => (
        <span key={i} aria-hidden className="pointer-events-none absolute left-1/2 top-1/2"
          style={{ transform: `translate(${x}px, ${y}px)` }}>
          <span className="sparkle block text-2xl text-[#fff2b8]" style={{ animationDelay: `${i * 300}ms` }}>✦</span>
        </span>
      ))}
    </div>
  );
}
