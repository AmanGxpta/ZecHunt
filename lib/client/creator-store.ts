"use client";

// Creator secrets live only in this browser (and in the manage link's #fragment,
// which browsers never send to the server).
const KEY = (id: string) => `zechunt:creator:${id}`;

export interface CreatorSecrets { creatorToken: string; checkpointKey: string }

export function saveSecrets(id: string, s: CreatorSecrets) {
  try { localStorage.setItem(KEY(id), JSON.stringify(s)); } catch {}
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
