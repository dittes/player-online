/** Resume positions (IndexedDB) and settings (localStorage). Only file name, size, date and a position are stored. */

const DB = 'webplayer';
const STORE = 'resume';
const MAX_ENTRIES = 300;

interface ResumeEntry {
  key: string;
  t: number;
  d: number;
  at: number;
}


function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains('bookmarks')) db.createObjectStore('bookmarks', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> => {
  try {
    const db = await open();
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined; // private mode or blocked storage: resume is a convenience only
  }
};

export async function getResume(key: string): Promise<number> {
  const e = (await run<ResumeEntry | undefined>('readonly', (s) => s.get(key as IDBValidKey) as IDBRequest<ResumeEntry | undefined>)) ?? undefined;
  return e && e.t > 5 ? e.t : 0;
}

export async function saveResume(key: string, t: number, d: number) {
  // Near the start or the end: forget it so the next play starts from the beginning.
  if (t < 5 || (d > 0 && t > d - 10)) {
    await run('readwrite', (s) => s.delete(key));
    return;
  }
  await run('readwrite', (s) => s.put({ key, t, d, at: Date.now() } satisfies ResumeEntry));
  const all = (await run<ResumeEntry[]>('readonly', (s) => s.getAll())) ?? [];
  if (all.length > MAX_ENTRIES) {
    for (const old of all.sort((a, b) => a.at - b.at).slice(0, all.length - MAX_ENTRIES)) await run('readwrite', (s) => s.delete(old.key));
  }
}

export interface Settings {
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  playlistOpen: boolean;
  theme: 'auto' | 'dark' | 'light' | 'oled' | 'contrast';
  accent: 'orange' | 'blue' | 'green' | 'pink' | 'purple';
}

const DEFAULTS: Settings = { volume: 1, muted: false, shuffle: false, repeat: 'off', playlistOpen: false, theme: 'oled', accent: 'orange' };

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('webplayer.settings') ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem('webplayer.settings', JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

// ------------------------------------------------------------------ bookmarks
export interface Bookmark {
  t: number;
  label: string;
}

/** Named positions per file (stored locally like resume positions). */
export async function getBookmarks(key: string): Promise<Bookmark[]> {
  try {
    const db = await open();
    return await new Promise<Bookmark[]>((resolve, reject) => {
      const req = db.transaction('bookmarks').objectStore('bookmarks').get(key);
      req.onsuccess = () => resolve((req.result?.marks as Bookmark[]) ?? []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function setBookmarks(key: string, marks: Bookmark[]) {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const store = db.transaction('bookmarks', 'readwrite').objectStore('bookmarks');
      const req = marks.length ? store.put({ key, marks }) : store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    /* storage unavailable */
  }
}
