"use client";

// Creator secrets live only in this browser (and in the manage link's #fragment,
// which browsers never send to the server).
const KEY = (id: string) => `zechunt:creator:${id}`;

export interface CreatorSecrets { creatorToken: string; checkpointKey: string }

export function saveSecrets(id: string, s: CreatorSecrets) {
  try {
    localStorage.setItem(KEY(id), JSON.stringify(s));
    if (!localStorage.getItem(`zechunt:created:${id}`)) localStorage.setItem(`zechunt:created:${id}`, String(Date.now()));
  } catch {}
}

export function loadSecrets(id: string): CreatorSecrets | null {
  try {
    const frag = new URLSearchParams(window.location.hash.slice(1));
    const t = frag.get("t"), k = frag.get("k");
    if (t && k) { const s = { creatorToken: t, checkpointKey: k }; saveSecrets(id, s); return s; }
    const raw = localStorage.getItem(KEY(id));
    return raw ? (JSON.parse(raw) as CreatorSecrets) : null;
  } catch {
    return null;
  }
}

/** Quest ids this browser can manage, newest first (by when they were saved here). */
export function listManagedQuests(): string[] {
  try {
    const out: { id: string; at: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const m = key && /^zechunt:creator:(.+)$/.exec(key);
      if (!m) continue;
      const at = Number(localStorage.getItem(`zechunt:created:${m[1]}`) ?? 0);
      out.push({ id: m[1], at });
    }
    return out.sort((a, b) => b.at - a.at).map((x) => x.id);
  } catch {
    return [];
  }
}

export function forgetQuest(id: string) {
  try { localStorage.removeItem(KEY(id)); localStorage.removeItem(`zechunt:created:${id}`); } catch {}
}
