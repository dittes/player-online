export type Repeat = 'off' | 'all' | 'one';

export interface Item {
  id: number;
  /** Display name (file name, or the last part of the URL). */
  name: string;
  size?: number;
  /** A local file ... */
  file?: File;
  /** ... or a network address (direct media file, HLS .m3u8 or DASH .mpd). */
  url?: string;
  /** External subtitle files that came with the video (same name). */
  subs: File[];
}

export const itemKey = (it: Item): string => (it.file ? `${it.file.name}|${it.file.size}|${it.file.lastModified}` : (it.url ?? ''));

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export class Playlist {
  items: Item[] = [];
  index = -1;
  shuffle = false;
  repeat: Repeat = 'off';
  private nextId = 1;
  private played = new Set<number>();
  onChange: () => void = () => undefined;

  get current(): Item | undefined {
    return this.items[this.index];
  }

  /** Add files in natural name order; subtitle files are attached to the video with the same base name. */
  add(files: File[], isSub: (f: File) => boolean): number {
    const base = (n: string) => n.replace(/\.[^.]+$/, '').replace(/\.[a-z]{2,3}$/i, '').toLowerCase();
    const sorted = [...files].sort((a, b) => collator.compare(a.name, b.name));
    const subs = sorted.filter(isSub);
    const media = sorted.filter((f) => !isSub(f));
    const first = this.items.length;
    for (const file of media) {
      const mine = subs.filter((s) => base(s.name) === base(file.name));
      this.items.push({ id: this.nextId++, name: file.name, size: file.size, file, subs: mine });
    }
    // Subtitles dropped alone while something plays belong to the current item.
    if (!media.length && subs.length && this.current) this.current.subs.push(...subs);
    this.onChange();
    return media.length ? first : -1;
  }

  addUrl(url: string): number {
    let name = url;
    try {
      const u = new URL(url);
      name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? u.hostname) || u.hostname;
    } catch {
      /* keep the raw text */
    }
    this.items.push({ id: this.nextId++, name, url, subs: [] });
    this.onChange();
    return this.items.length - 1;
  }

  remove(i: number) {
    if (i < 0 || i >= this.items.length) return;
    this.items.splice(i, 1);
    if (i < this.index) this.index--;
    else if (i === this.index) this.index = Math.min(this.index, this.items.length - 1);
    this.onChange();
  }

  clear() {
    this.items = [];
    this.index = -1;
    this.played.clear();
    this.onChange();
  }

  move(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= this.items.length || to >= this.items.length) return;
    const cur = this.current;
    const [it] = this.items.splice(from, 1);
    this.items.splice(to, 0, it);
    if (cur) this.index = this.items.indexOf(cur);
    this.onChange();
  }

  select(i: number): Item | undefined {
    if (i < 0 || i >= this.items.length) return undefined;
    this.index = i;
    this.played.add(this.items[i].id);
    this.onChange();
    return this.items[i];
  }

  /** Next item for "next" (user) or when a file ends (auto). Returns undefined at the end of the list. */
  next(auto: boolean): Item | undefined {
    if (!this.items.length) return undefined;
    if (auto && this.repeat === 'one') return this.select(this.index);
    if (this.shuffle) {
      let pool = this.items.map((it, i) => ({ it, i })).filter(({ it }) => !this.played.has(it.id));
      if (!pool.length) {
        if (this.repeat === 'off' && auto) return undefined;
        this.played.clear();
        pool = this.items.map((it, i) => ({ it, i })).filter(({ i }) => i !== this.index || this.items.length === 1);
      }
      return this.select(pool[Math.floor(Math.random() * pool.length)].i);
    }
    if (this.index + 1 < this.items.length) return this.select(this.index + 1);
    if (this.repeat === 'all') return this.select(0);
    return undefined;
  }

  prev(): Item | undefined {
    if (!this.items.length) return undefined;
    return this.select(this.index > 0 ? this.index - 1 : this.repeat === 'all' ? this.items.length - 1 : 0);
  }
}
