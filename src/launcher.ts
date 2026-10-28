import './page';

/** The start page: whatever is dropped or opened is sent to the player that fits its type. Nothing is uploaded. */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const lang = document.documentElement.lang || 'en';

const VIDEO = /\.(mp4|m4v|mov|qt|3gp|3g2|webm|mkv|avi|wmv|asf|flv|f4v|mpg|mpeg|mpe|m1v|m2v|divx|vob|ts|m2ts|mts|m2t|ogv|ogm|ogx)$/i;
const AUDIO = /\.(mp2|mp3|mpga|m4a|m4b|m4r|aac|flac|wav|ogg|oga|opus|spx|wma|weba|mka|aiff?|caf|amr|tta|ac3|dts)$/i;
const SUBS = /\.(srt|vtt|ass|ssa)$/i;
const DOCS = /\.(pdf|docx?|odt|rtf|txt|md|xlsx?|ods|csv|pptx?|odp|epub|pages|numbers|key)$/i;
const GAMES = /\.(nes|smc|sfc|gb|gbc|gba|nds|n64|z64|v64|md|gen|smd|sms|gg|a26|a78|pce|swf|d64|adf|rom|iso|cue|cso|chd)$/i;

type Kind = 'video' | 'audio' | 'subs' | 'doc' | 'game' | 'other';
const kindOf = (f: File): Kind =>
  f.type.startsWith('video/') || VIDEO.test(f.name) ? 'video'
  : f.type.startsWith('audio/') || AUDIO.test(f.name) ? 'audio'
  : SUBS.test(f.name) ? 'subs'
  : DOCS.test(f.name) ? 'doc'
  : GAMES.test(f.name) ? 'game'
  : 'other';

const msg = $('msg');
const text = (k: string) => $('texts').dataset[k] ?? '';

function say(kind: 'doc' | 'game' | 'other') {
  msg.replaceChildren();
  msg.hidden = false;
  const p = document.createElement('p');
  p.textContent = text(kind);
  msg.append(p);
  if (kind !== 'other') {
    const a = document.createElement('a');
    a.className = 'btn btn--primary';
    a.href = kind === 'doc' ? 'https://open-online.com' : 'https://biuno.com';
    a.rel = 'noopener';
    a.textContent = text(kind + 'Link');
    msg.append(a);
  }
}

/** Parks the files where the player page picks them up (same mechanism as the installed app's share target). */
async function handOver(files: File[], target: 'video' | 'music') {
  try {
    const cache = await caches.open('webplayer-share');
    await Promise.all((await cache.keys()).map((k) => cache.delete(k)));
    await Promise.all(
      files.map((f, i) =>
        cache.put('/shared/' + i, new Response(f, { headers: { 'X-Name': encodeURIComponent(f.name), 'X-Modified': String(f.lastModified), 'Content-Type': f.type || 'application/octet-stream' } })),
      ),
    );
    location.href = `/${lang}/${target}/?shared=${files.length}`;
  } catch {
    say('other');
  }
}

function route(files: File[]) {
  msg.hidden = true;
  if (!files.length) return;
  const kinds = files.map(kindOf);
  const has = (k: Kind) => kinds.includes(k);
  if (has('video') || has('audio')) {
    const playable = files.filter((_, i) => ['video', 'audio', 'subs'].includes(kinds[i]));
    void handOver(playable, has('video') ? 'video' : 'music');
  } else if (has('doc')) say('doc');
  else if (has('game')) say('game');
  else say('other');
}

// ---- opening
const fileInput = $<HTMLInputElement>('file-input');
const dirInput = $<HTMLInputElement>('dir-input');
$('open-file').addEventListener('click', () => fileInput.click());
$('open-folder').addEventListener('click', () => dirInput.click());
for (const input of [fileInput, dirInput]) {
  input.addEventListener('change', () => {
    route([...(input.files ?? [])]);
    input.value = '';
  });
}
if (!('webkitdirectory' in dirInput)) $('open-folder').hidden = true;

// ---- drag and drop (files and whole folders)
async function readEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    out.push(await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)));
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await readEntry(e, out);
    }
  }
}
const zone = $('drop');
let depth = 0;
const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files');
addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; zone.classList.add('over'); } });
addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; zone.classList.remove('over'); } });
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  depth = 0;
  zone.classList.remove('over');
  const items = [...(e.dataTransfer?.items ?? [])];
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
  const files: File[] = [];
  try {
    if (entries.length) for (const en of entries) await readEntry(en, files);
    else files.push(...(e.dataTransfer?.files ?? []));
  } catch {
    files.push(...(e.dataTransfer?.files ?? []));
  }
  route(files);
});
