/** a pane of a saved iTerm layout, as /api/iterm-layout serves it */
export type LayoutPane =
  | { kind: "claude"; sessionId: string; cwd: string; title: string | null; landed: boolean; live: boolean }
  | { kind: "shell"; cwd: string; live: false };

export interface SavedLayout {
  at: number;
  /** from an iTerm run that has since ended (the restore offer), not the one running now */
  previousRun: boolean;
  windows: { bounds: [number, number, number, number]; tabs: LayoutPane[][] }[];
}

export const paneKey = (w: number, t: number, p: number) => `${w}.${t}.${p}`;

/** what a restore brings back unless you untick it: Claude sessions that aren't landed or already
 *  running again, and shells only when the whole run is being brought back */
export const restoredByDefault = (l: SavedLayout, p: LayoutPane) =>
  p.kind === "claude" ? !p.live && !p.landed : l.previousRun;

export async function fetchLayout(): Promise<SavedLayout | null> {
  try {
    return ((await (await fetch("/api/iterm-layout")).json()) as { layout: SavedLayout | null }).layout;
  } catch {
    return null;
  }
}

/** reopen the layout without the panes in `skip`; true if iTerm ran it */
export async function restoreLayout(at: number, skip: string[]): Promise<boolean> {
  try {
    const r = await fetch("/api/iterm-layout/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ at, skip }) });
    return !!((await r.json()) as { ok?: boolean }).ok;
  } catch {
    return false;
  }
}

export function defaultSkip(l: SavedLayout): string[] {
  const skip: string[] = [];
  l.windows.forEach((w, wi) => w.tabs.forEach((panes, ti) => panes.forEach((p, pi) => restoredByDefault(l, p) || skip.push(paneKey(wi, ti, pi)))));
  return skip;
}

/** "today 18:42", "yesterday 18:42", else the date */
export function savedWhen(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86_400_000);
  return diff === 0 ? `today ${time}` : diff === 1 ? `yesterday ${time}` : `${d.toLocaleDateString()} ${time}`;
}
