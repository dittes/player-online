import './style.css';
import { icons } from './ui/icons';
import { Player, type Engine } from './engine/player';
import { Playlist, itemKey } from './playlist';
import { extractSubtitles } from './engine/probe';
import { cuesAt, isSubtitleName, parseSubtitles, renderCueText, type SubtitleTrack } from './subtitles';
import { applyVideo, ASPECTS, defaultVideo, type Aspect } from './engine/vfx';
import { EQ_FREQS, EQ_PRESETS, type FxSettings } from './engine/fx';
import { getBookmarks, getResume, loadSettings, saveResume, saveSettings, setBookmarks, type Bookmark } from './store';

// ------------------------------------------------------------------ helpers
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $('app');
const stage = $('stage');

const fmt = (t: number) => {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const s = Math.floor(t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const fmtSize = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const baseName = (n: string) => n.replace(/\.[^.]+$/, '');
const MEDIA_EXT = /\.(mp4|m4v|mov|qt|3gp|3g2|webm|mkv|mka|avi|wmv|asf|flv|f4v|mpg|mpeg|mpe|vob|ts|m2ts|mts|m2t|ogv|mp3|m4a|m4b|aac|flac|wav|ogg|oga|opus|wma|weba|aiff?|ac3|dts)$/i;
const isMedia = (f: File) => f.type.startsWith('video/') || f.type.startsWith('audio/') || MEDIA_EXT.test(f.name);
const isSub = (f: File) => isSubtitleName(f.name);
const ENGINE_LABEL: Record<Engine, string> = {
  native: 'Browser',
  'native+sound': 'Browser + built-in sound decoder',
  builtin: 'Built-in player (FFmpeg / WebAssembly)',
};

// ------------------------------------------------------------------- state
const settings = loadSettings();
const list = new Playlist();
list.shuffle = settings.shuffle;
list.repeat = settings.repeat;
let tracks: SubtitleTrack[] = [];
let subIdx = -1;
let subDelay = 0;
let scrubbing = false;
let playToken = 0;
let loop: { a: number | null; b: number | null } = { a: null, b: null };
let lastSave = 0;
let lastCueKey = '';
let lastClock = '';
let lastPosState = 0;
let bookmarks: Bookmark[] = [];
const embeddedLoaded = new Map<number, number>();
const vs = defaultVideo();

// ------------------------------------------------------------------ player
const player = new Player(stage, {
  time: () => undefined,
  state: (playing) => {
    $('b-play').innerHTML = playing ? icons.pause : icons.play;
    $('b-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    void keepAwake(playing);
    if (!playing) persistPosition();
    wake();
  },
  ended: () => {
    const cur = list.current;
    if (cur) void saveResume(itemKey(cur), 0, 0);
    const next = list.next(true);
    if (next) void playIndex(list.index);
    else osd('End of playlist');
  },
  buffering: (on) => ($('spinner').hidden = !on),
  error: (m) => toast(m),
  notice: (m) => toast(m),
  tracks: () => refreshTrackUI(),
});
player.setVolume(settings.volume, settings.muted);

// ---------------------------------------------------------------- icon init
const setIcon = (id: string, svg: string) => ($(id).innerHTML = svg);
const labelled = (id: string, svg: string, text: string) => ($(id).innerHTML = `${svg}<span>${text}</span>`);
labelled('btn-open', icons.file, 'Open');
labelled('btn-folder', icons.folder, 'Folder');
setIcon('btn-info', icons.info);
setIcon('btn-list', icons.list);
labelled('empty-open', icons.file, 'Open files');
labelled('empty-folder', icons.folder, 'Open folder');
setIcon('b-prev', icons.prev);
setIcon('b-play', icons.play);
setIcon('b-next', icons.next);
setIcon('b-speed', icons.gauge);
setIcon('b-subs', icons.captions);
setIcon('b-snap', icons.camera);
setIcon('b-pip', icons.pip);
setIcon('b-chap', icons.chapters);
setIcon('b-audio', icons.audioTrack);
setIcon('b-cast', icons.cast);
setIcon('b-fx', icons.sliders);
setIcon('fx-close', icons.close);
labelled('btn-url', icons.link, 'URL');
setIcon('b-full', icons.maximize);
setIcon('pl-shuffle', icons.shuffle);
setIcon('pl-add', icons.plus);
setIcon('pl-clear', icons.trash);
setIcon('pl-close', icons.close);

// ------------------------------------------------------------------- toasts
let toastTimer = 0;
function toast(msg: string, ms = 4500) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), ms);
}
let osdTimer = 0;
function osd(msg: string) {
  const el = $('osd');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(osdTimer);
  osdTimer = window.setTimeout(() => el.classList.remove('show'), 1100);
}

// ------------------------------------------------------------ open & queue
function openFiles(files: File[], append = false) {
  const usable = files.filter((f) => isMedia(f) || isSub(f));
  if (!usable.length) {
    toast('No audio or video files found.');
    return;
  }
  if (!append && usable.some(isMedia)) list.clear();
  const first = list.add(usable, isSub);
  if (first >= 0 && (!append || list.index < 0)) void playIndex(first);
  else if (first < 0) attachSubs();
  if (append && first >= 0) toast(`Added ${list.items.length - first} to the playlist.`);
  persistSettings();
}

async function playIndex(i: number) {
  const item = list.select(i);
  if (!item) return;
  const token = ++playToken;
  $('empty').hidden = true;
  $('spinner').hidden = false;
  $('title').textContent = item.name;
  document.title = `${baseName(item.name)} – Web Player`;
  loop = { a: null, b: null };
  updateAB();
  lastCueKey = '';
  try {
    persistPosition();
    const resume = await getResume(itemKey(item));
    if (token !== playToken) return;
    const info = await player.load({ file: item.file, url: item.url }, resume);
    if (token !== playToken) return;
    $('audioart').hidden = info.hasVideo;
    $('audioname').textContent = baseName(item.name);
    $('t-dur').textContent = info.live ? 'LIVE' : fmt(info.duration);
    $<HTMLInputElement>('seek').disabled = info.live;
    $('b-speed').toggleAttribute('disabled', !player.canChangeRate);
    $('b-pip').toggleAttribute('disabled', !player.canPip);
    $('b-snap').toggleAttribute('disabled', !info.hasVideo);
    player.setRate(1);
    updateSpeedIcon();
    await loadItemSubs();
    bookmarks = await getBookmarks(itemKey(item));
    refreshTrackUI();
    updateMediaSession();
    if (resume > 1) osd(`Resumed at ${fmt(resume)}`);
    await player.play();
  } catch (e) {
    if (token !== playToken || (e as Error).message === 'superseded') return;
    $('spinner').hidden = true;
    toast(`Can’t play “${item.name}”: ${(e as Error).message}`, 7000);
  } finally {
    if (token === playToken) $('spinner').hidden = true;
  }
}

// ---------------------------------------------------------------- subtitles
async function loadItemSubs() {
  embeddedLoaded.clear();
  tracks = [];
  subIdx = -1;
  subDelay = 0;
  const cur = list.current;
  for (const f of cur?.subs ?? []) tracks.push(parseSubtitles(f.name, await f.arrayBuffer()));
  if (tracks.length) subIdx = 0;
  renderSubs();
}
async function attachSubs() {
  await loadItemSubs();
  if (tracks.length) osd(`Subtitles: ${tracks[0].name}`);
}
function renderSubs() {
  const t = subIdx >= 0 ? tracks[subIdx] : null;
  const cues = cuesAt(t, player.time, subDelay);
  const key = `${subIdx}|${subDelay}|${cues.map((c) => c.start).join(',')}`;
  if (key === lastCueKey) return;
  lastCueKey = key;
  renderCueText($('subs'), cues);
}

// -------------------------------------------------------------- tick (UI sync)
function persistPosition() {
  const cur = list.current;
  if (cur && player.info && !player.info.live) void saveResume(itemKey(cur), player.time, player.duration);
}

function tick() {
  requestAnimationFrame(tick);
  if (!player.info) return;
  const t = player.time;
  const d = player.duration;
  if (!scrubbing) {
    const seek = $<HTMLInputElement>('seek');
    seek.value = d ? String(Math.round((t / d) * 1000)) : '0';
    seek.style.setProperty('--p', `${d ? (t / d) * 100 : 0}%`);
    const clock = fmt(t);
    if (clock !== lastClock) {
      lastClock = clock;
      $('t-cur').textContent = clock;
      $('seek').setAttribute('aria-valuetext', `${clock} of ${fmt(d)}`);
    }
  }
  renderSubs();
  if (loop.a !== null && loop.b !== null && t >= loop.b) void player.seek(loop.a);
  const now = performance.now();
  if (player.playing && now - lastSave > 5000) {
    lastSave = now;
    persistPosition();
  }
  if (now - lastPosState > 1000 && 'mediaSession' in navigator && d > 0) {
    lastPosState = now;
    try {
      navigator.mediaSession.setPositionState({ duration: d, position: Math.min(t, d), playbackRate: player.rate });
    } catch {
      /* unsupported values */
    }
  }
}
requestAnimationFrame(tick);

// --------------------------------------------------------------- controls
const volEl = $<HTMLInputElement>('vol');
function syncVolumeUI() {
  const eff = player.muted ? 0 : player.volume;
  volEl.value = String(Math.round(eff * 100));
  volEl.style.setProperty('--p', `${(eff / 2) * 100}%`);
  $('volval').textContent = `${Math.round(eff * 100)}%`;
  setIcon('b-mute', eff === 0 ? icons.muted : icons.volume);
}
function setVolume(v: number, muted = false, show = true) {
  player.setVolume(v, muted);
  syncVolumeUI();
  settings.volume = player.volume;
  settings.muted = player.muted;
  persistSettings();
  if (show) osd(player.muted ? 'Muted' : `Volume ${Math.round(player.volume * 100)}%`);
}
volEl.addEventListener('input', () => setVolume(Number(volEl.value) / 100, false, false));
$('b-mute').addEventListener('click', () => setVolume(player.volume || 1, !player.muted));
syncVolumeUI();

$('b-play').addEventListener('click', () => void player.toggle());
$('b-next').addEventListener('click', () => {
  if (list.next(false)) void playIndex(list.index);
});
$('b-prev').addEventListener('click', () => {
  if (player.time > 3 || list.items.length < 2) void player.seek(0);
  else if (list.prev()) void playIndex(list.index);
});

const seekEl = $<HTMLInputElement>('seek');
seekEl.addEventListener('input', () => {
  scrubbing = true;
  const t = (Number(seekEl.value) / 1000) * player.duration;
  seekEl.style.setProperty('--p', `${Number(seekEl.value) / 10}%`);
  $('t-cur').textContent = fmt(t);
});
seekEl.addEventListener('change', () => {
  void player.seek((Number(seekEl.value) / 1000) * player.duration).then(() => (scrubbing = false));
});

function seekBy(d: number) {
  void player.seekBy(d);
  osd(`${d > 0 ? '+' : '−'}${Math.abs(d)} s  ·  ${fmt(Math.max(0, player.time + d))}`);
}

// A–B loop
function updateAB() {
  const btn = $('b-ab');
  btn.setAttribute('aria-pressed', String(loop.a !== null));
  btn.textContent = loop.a === null ? 'A–B' : loop.b === null ? 'A–' : 'A–B';
}
function cycleAB() {
  if (loop.a === null) {
    loop.a = player.time;
    osd(`Loop start ${fmt(loop.a)}`);
  } else if (loop.b === null) {
    if (player.time - loop.a < 0.5) return;
    loop.b = player.time;
    osd(`Looping ${fmt(loop.a)} – ${fmt(loop.b)}`);
  } else {
    loop = { a: null, b: null };
    osd('Loop off');
  }
  updateAB();
}
$('b-ab').addEventListener('click', cycleAB);

// speed
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];
function updateSpeedIcon() {
  $('b-speed').title = `Speed ${player.rate}× ([ and ])`;
}
function setSpeed(r: number) {
  if (!player.canChangeRate) {
    osd('Speed can’t be changed with the built-in player');
    return;
  }
  player.setRate(r);
  updateSpeedIcon();
  osd(`Speed ${r}×`);
}
function stepSpeed(dir: 1 | -1) {
  const i = SPEEDS.indexOf(player.rate);
  const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? SPEEDS.indexOf(1) : i) + dir))];
  setSpeed(next);
}

// menus
const menus = ['menu-speed', 'menu-subs', 'menu-audio', 'menu-chap', 'menu-quality'];
const MENU_OPENER: Record<string, string> = {
  'menu-speed': 'b-speed', 'menu-subs': 'b-subs', 'menu-audio': 'b-audio', 'menu-chap': 'b-chap', 'menu-quality': 'b-quality', 'menu-theme': 'btn-theme',
};
function closeMenus(returnFocus = false) {
  for (const m of menus) {
    const el = $(m);
    if (!el.hidden && returnFocus) $(MENU_OPENER[m]).focus();
    el.hidden = true;
    $(MENU_OPENER[m])?.setAttribute('aria-expanded', 'false');
  }
}
function toggleMenu(id: string, build: (el: HTMLElement) => void) {
  const el = $(id);
  const wasHidden = el.hidden;
  closeMenus();
  if (wasHidden) {
    el.setAttribute('role', 'menu');
    build(el);
    el.hidden = false;
    $(MENU_OPENER[id])?.setAttribute('aria-expanded', 'true');
    (el.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus({ preventScroll: true });
  }
}
// keyboard use of the menus: arrows, Home/End, Escape
document.addEventListener('keydown', (e) => {
  const open = menus.map($).find((m) => !m.hidden);
  if (!open) return;
  const items = [...open.querySelectorAll<HTMLElement>('button:not(:disabled)')];
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeMenus(true);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    e.stopPropagation();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
}, true);
function menuItem(parent: HTMLElement, text: string, checked: boolean | null, onClick: () => void, keepOpen = false) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.setAttribute('role', checked === null ? 'menuitem' : 'menuitemradio');
  if (checked !== null) b.setAttribute('aria-checked', String(checked));
  b.addEventListener('click', () => {
    onClick();
    if (!keepOpen) closeMenus();
  });
  parent.append(b);
}
$('b-speed').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu('menu-speed', (el) => {
    el.replaceChildren();
    SPEEDS.forEach((s) => menuItem(el, `${s}×`, s === player.rate, () => setSpeed(s)));
  });
});
$('b-subs').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu('menu-subs', buildSubsMenu);
});
function buildSubsMenu(el: HTMLElement) {
  el.replaceChildren();
  menuItem(el, 'Off', subIdx < 0, () => ((subIdx = -1), renderSubs()));
  tracks.forEach((t, i) => menuItem(el, t.name, subIdx === i, () => ((subIdx = i), renderSubs())));
  menuItem(el, 'Load subtitle file…', null, () => $('sub-input').click());
  const embedded = player.subtitleTracks;
  if (embedded.length) {
    el.append(document.createElement('hr'));
    const lab = document.createElement('div');
    lab.className = 'label';
    lab.textContent = 'Inside the file';
    el.append(lab);
    for (const t of embedded) {
      const name = [t.title, langNameOf(t.lang), t.codec].filter(Boolean).join(' · ');
      if (!t.text) {
        menuItem(el, `${name} (image-based, not supported)`, null, () => undefined);
        (el.lastElementChild as HTMLButtonElement).disabled = true;
      } else menuItem(el, name, embeddedLoaded.has(t.index) && subIdx === embeddedLoaded.get(t.index), () => void useEmbedded(t.index));
    }
  }
  if (tracks.length) {
    el.append(document.createElement('hr'));
    const lab = document.createElement('div');
    lab.className = 'label';
    lab.textContent = `Delay ${subDelay >= 0 ? '+' : ''}${subDelay.toFixed(1)} s`;
    el.append(lab);
    menuItem(el, 'Later  (+0.1 s)', null, () => ((subDelay += 0.1), (lab.textContent = `Delay +${subDelay.toFixed(1)} s`)), true);
    menuItem(el, 'Earlier  (−0.1 s)', null, () => ((subDelay -= 0.1), (lab.textContent = `Delay ${subDelay.toFixed(1)} s`)), true);
    menuItem(el, 'Reset delay', null, () => (subDelay = 0));
  }
  if (!tracks.length) {
    const hint = document.createElement('div');
    hint.className = 'label';
    hint.textContent = 'Tip: drop .srt/.vtt/.ass files, or name them like the video.';
    el.append(hint);
  }
}
document.addEventListener('click', () => closeMenus());

$<HTMLInputElement>('sub-input').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  for (const f of Array.from(input.files ?? [])) {
    tracks.push(parseSubtitles(f.name, await f.arrayBuffer()));
    list.current?.subs.push(f);
    subIdx = tracks.length - 1;
    osd(`Subtitles: ${f.name}`);
  }
  input.value = '';
  lastCueKey = '';
  renderSubs();
});
function cycleSubs() {
  if (!tracks.length) {
    $('sub-input').click();
    return;
  }
  subIdx = subIdx + 1 >= tracks.length ? -1 : subIdx + 1;
  lastCueKey = '';
  renderSubs();
  osd(subIdx < 0 ? 'Subtitles off' : `Subtitles: ${tracks[subIdx].name}`);
}

// snapshot, pip, fullscreen
async function snapshot() {
  const blob = await player.snapshot();
  const cur = list.current;
  if (!blob || !cur) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${baseName(cur.name)}-${fmt(player.time).replace(/:/g, '-')}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  osd('Snapshot saved');
}
$('b-snap').addEventListener('click', () => void snapshot());
$('b-pip').addEventListener('click', () => void player.pip().catch(() => toast('Picture-in-picture isn’t available here.')));

const isFullscreen = () => !!document.fullscreenElement || app.classList.contains('pseudo-fs');
function updateFsIcon() {
  setIcon('b-full', isFullscreen() ? icons.minimize : icons.maximize);
  setTimeout(applyVideoNow, 60);
}
/** Landscape lock while a wide video is full screen (Android Chrome and installed apps; ignored elsewhere). */
function lockLandscape() {
  const info = player.info;
  if (!info?.hasVideo || !info.width || !info.height || info.width <= info.height) return;
  void (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => undefined);
}
function unlockOrientation() {
  try {
    screen.orientation.unlock();
  } catch {
    /* not locked or unsupported */
  }
}
/** iPhone Safari has no Fullscreen API for elements: fill the screen with the player instead. */
function setPseudoFs(on: boolean) {
  app.classList.toggle('pseudo-fs', on);
  if (on) lockLandscape();
  else unlockOrientation();
  updateFsIcon();
}
function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else if (app.classList.contains('pseudo-fs')) setPseudoFs(false);
  else if (stage.requestFullscreen) void stage.requestFullscreen().then(lockLandscape).catch(() => setPseudoFs(true));
  else setPseudoFs(true);
}
$('b-full').addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) unlockOrientation();
  updateFsIcon();
});

// --------------------------------------------------------------- playlist UI
function renderList() {
  const ol = $('list');
  ol.replaceChildren();
  $('pl-empty').hidden = list.items.length > 0;
  list.items.forEach((item, i) => {
    const li = document.createElement('li');
    li.draggable = true;
    li.className = i === list.index ? 'current' : '';
    li.innerHTML = `<span class="n"></span><span class="nm"></span><span class="sz"></span><button class="rm" title="Remove" aria-label="Remove"></button>`;
    (li.querySelector('.n') as HTMLElement).textContent = String(i + 1);
    (li.querySelector('.nm') as HTMLElement).textContent = baseName(item.name);
    (li.querySelector('.sz') as HTMLElement).textContent = item.size ? fmtSize(item.size) : 'URL';
    (li.querySelector('.rm') as HTMLElement).innerHTML = icons.close;
    li.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.rm')) {
        const wasCurrent = i === list.index;
        list.remove(i);
        if (wasCurrent) {
          if (list.items.length) void playIndex(list.index);
          else stopAll();
        }
        return;
      }
      void playIndex(i);
    });
    li.addEventListener('dragstart', (e) => e.dataTransfer?.setData('application/x-wp-index', String(i)));
    li.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('application/x-wp-index')) {
        e.preventDefault();
        li.classList.add('dragover');
      }
    });
    li.addEventListener('dragleave', () => li.classList.remove('dragover'));
    li.addEventListener('drop', (e) => {
      const from = e.dataTransfer?.getData('application/x-wp-index');
      li.classList.remove('dragover');
      if (from !== undefined && from !== '') {
        e.preventDefault();
        e.stopPropagation();
        list.move(Number(from), i);
      }
    });
    ol.append(li);
  });
  ol.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  $('b-prev').toggleAttribute('disabled', list.items.length === 0);
  $('b-next').toggleAttribute('disabled', list.items.length < 2 && list.repeat === 'off');
}
list.onChange = renderList;
renderList();

function stopAll() {
  playToken++;
  player.unload();
  $('empty').hidden = false;
  $('audioart').hidden = true;
  $('title').textContent = '';
  document.title = 'Web Player';
  renderCueText($('subs'), []);
}

function updateListButtons() {
  $('pl-shuffle').setAttribute('aria-pressed', String(list.shuffle));
  setIcon('pl-repeat', list.repeat === 'one' ? icons.repeatOne : icons.repeat);
  $('pl-repeat').setAttribute('aria-pressed', String(list.repeat !== 'off'));
  $('pl-repeat').title = `Repeat: ${list.repeat}`;
  app.classList.toggle('list-open', settings.playlistOpen);
  $('btn-list').setAttribute('aria-pressed', String(settings.playlistOpen));
}
function persistSettings() {
  settings.shuffle = list.shuffle;
  settings.repeat = list.repeat;
  saveSettings(settings);
}
$('pl-shuffle').addEventListener('click', () => {
  list.shuffle = !list.shuffle;
  persistSettings();
  updateListButtons();
  osd(list.shuffle ? 'Shuffle on' : 'Shuffle off');
});
$('pl-repeat').addEventListener('click', () => {
  list.repeat = list.repeat === 'off' ? 'all' : list.repeat === 'all' ? 'one' : 'off';
  persistSettings();
  updateListButtons();
  osd(`Repeat ${list.repeat}`);
});
$('pl-clear').addEventListener('click', () => {
  list.clear();
  stopAll();
});
function togglePlaylist(force?: boolean) {
  settings.playlistOpen = force ?? !settings.playlistOpen;
  saveSettings(settings);
  updateListButtons();
}
$('btn-list').addEventListener('click', () => togglePlaylist());
$('pl-close').addEventListener('click', () => togglePlaylist(false));
updateListButtons();

// ---------------------------------------------------------- opening files UI
const fileInput = $<HTMLInputElement>('file-input');
const dirInput = $<HTMLInputElement>('dir-input');
let appendNext = false;
const pick = (append = false) => {
  appendNext = append;
  fileInput.click();
};
$('btn-open').addEventListener('click', () => pick());
$('empty-open').addEventListener('click', () => pick());
$('pl-add').addEventListener('click', () => pick(true));
$('btn-folder').addEventListener('click', () => dirInput.click());
$('empty-folder').addEventListener('click', () => dirInput.click());
fileInput.addEventListener('change', () => {
  openFiles(Array.from(fileInput.files ?? []), appendNext);
  fileInput.value = '';
});
dirInput.addEventListener('change', () => {
  openFiles(Array.from(dirInput.files ?? []));
  dirInput.value = '';
});

// drag and drop
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (e.dataTransfer?.types.includes('Files')) {
    dragDepth++;
    app.classList.add('dragging');
  }
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) app.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  app.classList.remove('dragging');
  if (!e.dataTransfer?.files.length) return;
  openFiles(await collectDropped(e.dataTransfer), e.shiftKey);
});

/** Files from a drop, including the contents of dropped folders. */
async function collectDropped(dt: DataTransfer): Promise<File[]> {
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry | null): Promise<void> => {
    if (!entry) return;
    if (entry.isFile) out.push(await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)));
    else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  const entries = Array.from(dt.items).map((i) => i.webkitGetAsEntry?.() ?? null);
  if (entries.some(Boolean)) for (const en of entries) await walk(en);
  else out.push(...Array.from(dt.files));
  return out;
}

// installed app: "Open with…" and file associations
const lq = (window as unknown as { launchQueue?: { setConsumer: (cb: (p: { files: Array<{ getFile(): Promise<File> }> }) => void) => void } }).launchQueue;
lq?.setConsumer(async (params) => {
  const files = await Promise.all((params.files ?? []).map((h) => h.getFile()));
  if (files.length) openFiles(files);
});

// ------------------------------------------------------------------- info
$('btn-info').addEventListener('click', showInfo);
function showInfo() {
  const cur = list.current;
  const i = player.info;
  const dl = $('info-body');
  dl.replaceChildren();
  const rows: Array<[string, string | undefined]> = cur && i
    ? [
        [cur.url ? 'Address' : 'File', cur.url ?? cur.name],
        ['Size', cur.file ? fmtSize(cur.file.size) : undefined],
        ['Type', cur.file ? cur.file.type || cur.file.name.split('.').pop()?.toUpperCase() : i.stream ? i.stream.toUpperCase() : undefined],
        ['Duration', i.live ? 'Live stream' : fmt(i.duration)],
        ['Resolution', i.width ? `${i.width} × ${i.height}` : undefined],
        ['Video codec', i.videoCodec],
        ['Audio codec', i.audioCodec],
        ['Played by', ENGINE_LABEL[i.engine]],
        ['Why', i.reason],
        ['Subtitles', tracks.length ? tracks.map((t) => `${t.name} (${t.cues.length})`).join(', ') : undefined],
        ['Audio tracks', player.audioChoices().length > 1 ? player.audioChoices().map((a) => a.label).join(' | ') : undefined],
        ['Chapters', player.chapters.length ? String(player.chapters.length) : undefined],
      ]
    : [['Nothing is playing', 'Open a file to see its details.']];
  for (const [k, v] of rows) {
    if (!v) continue;
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  $<HTMLDialogElement>('info').showModal();
}

// ---------------------------------------------------- media session & wake lock
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const cur = list.current;
  navigator.mediaSession.metadata = new MediaMetadata({ title: cur ? baseName(cur.name) : '', artist: 'Web Player', artwork: [{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }] });
  const set = (a: MediaSessionAction, fn: MediaSessionActionHandler) => {
    try {
      navigator.mediaSession.setActionHandler(a, fn);
    } catch {
      /* action not supported */
    }
  };
  set('play', () => void player.play());
  set('pause', () => void player.pause());
  set('previoustrack', () => $('b-prev').click());
  set('nexttrack', () => $('b-next').click());
  set('seekbackward', (d) => void player.seekBy(-(d.seekOffset ?? 10)));
  set('seekforward', (d) => void player.seekBy(d.seekOffset ?? 10));
  set('seekto', (d) => void player.seek(d.seekTime ?? 0));
}

let lock: WakeLockSentinel | null = null;
async function keepAwake(on: boolean) {
  try {
    if (on && !lock && 'wakeLock' in navigator) {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => (lock = null));
    } else if (!on && lock) {
      await lock.release();
      lock = null;
    }
  } catch {
    /* denied (battery saver, hidden tab) */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && player.playing) void keepAwake(true);
  if (document.visibilityState === 'hidden') persistPosition();
});
window.addEventListener('pagehide', persistPosition);

// ------------------------------------------------------- idle controls, gestures
let idleTimer = 0;
function wake() {
  app.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    const over = $('controls').matches(':hover') || menus.some((m) => !$(m).hidden);
    if (player.playing && !over) app.classList.add('idle');
  }, 2800);
}
['pointermove', 'pointerdown', 'keydown'].forEach((t) => stage.addEventListener(t, wake));

let lastTap = 0;
let lastZone = '';
let singleTimer = 0;
let suppressTap = false;
stage.addEventListener('pointerup', (e) => {
  const target = e.target as HTMLElement;
  if (suppressTap) {
    suppressTap = false;
    return;
  }
  if (target.closest('.controls, .menu, .empty') || e.button !== 0) return;
  const rect = stage.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const zone = x < 0.33 ? 'left' : x > 0.67 ? 'right' : 'mid';
  const now = performance.now();
  const dbl = now - lastTap < 300 && zone === lastZone;
  lastTap = now;
  lastZone = zone;
  clearTimeout(singleTimer);
  if (dbl) {
    lastTap = 0;
    if (e.pointerType === 'mouse' || zone === 'mid') toggleFullscreen();
    else seekBy(zone === 'left' ? -10 : 10);
    return;
  }
  singleTimer = window.setTimeout(() => {
    if (e.pointerType === 'mouse') void player.toggle();
    else if (app.classList.contains('idle') || !player.playing) void player.toggle(), wake();
    else app.classList.add('idle');
  }, 260);
});

// --------------------------------------------------------------- keyboard
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const el = e.target as HTMLElement;
  if (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range') return;
  if ($<HTMLDialogElement>('info').open) return;
  const onRange = el.tagName === 'INPUT';
  const k = e.key;
  const handled = (fn: () => void) => {
    e.preventDefault();
    fn();
    wake();
  };
  switch (k) {
    case ' ':
    case 'k':
      if (el.tagName === 'BUTTON') return;
      return handled(() => void player.toggle());
    case 'ArrowRight':
      if (onRange) return;
      return handled(() => seekBy(e.shiftKey ? 30 : 5));
    case 'ArrowLeft':
      if (onRange) return;
      return handled(() => seekBy(e.shiftKey ? -30 : -5));
    case 'l':
      return handled(() => seekBy(10));
    case 'j':
      return handled(() => seekBy(-10));
    case 'ArrowUp':
      if (onRange) return;
      return handled(() => setVolume(Math.min(2, player.volume + 0.05), false));
    case 'ArrowDown':
      if (onRange) return;
      return handled(() => setVolume(Math.max(0, player.volume - 0.05), false));
    case 'm':
      return handled(() => setVolume(player.volume || 1, !player.muted));
    case 'f':
      return handled(toggleFullscreen);
    case 'Escape':
      if (app.classList.contains('pseudo-fs')) return handled(() => setPseudoFs(false));
      return;
    case 'c':
      return handled(cycleSubs);
    case 's':
      return handled(() => void snapshot());
    case 'a':
      return handled(cycleAB);
    case 'i':
      return handled(showInfo);
    case 'o':
      return handled(() => pick());
    case 'L':
      return handled(() => togglePlaylist());
    case 'n':
    case 'N':
      return handled(() => $('b-next').click());
    case 'p':
    case 'P':
      return handled(() => $('b-prev').click());
    case '[':
      return handled(() => stepSpeed(-1));
    case ']':
      return handled(() => stepSpeed(1));
    case '.':
      return handled(() => void player.step(1));
    case ',':
      return handled(() => void player.step(-1));
    case 'Home':
      return handled(() => void player.seek(0));
    case 'End':
      return handled(() => void player.seek(player.duration - 0.1));
    default:
      if (/^[0-9]$/.test(k) && player.duration) return handled(() => void player.seek((Number(k) / 10) * player.duration));
  }
});

// ------------------------------------------------------------------- PWA
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined));
}

if (import.meta.env.DEV) (window as unknown as { __wp: unknown }).__wp = { player, list, openFiles };

// ===================================================================== more features
function langNameOf(code?: string) {
  if (!code) return '';
  try {
    return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Show or hide track-dependent buttons; called whenever the probe, audio track or engine changes. */
function refreshTrackUI() {
  const loaded = !!player.info;
  $('b-audio').hidden = player.audioChoices().length < 2;
  $('b-chap').hidden = !loaded;
  $('b-quality').hidden = player.qualities().length === 0;
  $('b-cast').hidden = !player.canCast;
  $('b-pip').toggleAttribute('disabled', !player.canPip);
  $('b-speed').toggleAttribute('disabled', !player.canChangeRate);
}

// ------------------------------------------------------------- embedded subtitles
async function useEmbedded(index: number) {
  const have = embeddedLoaded.get(index);
  if (have !== undefined) {
    subIdx = have;
    lastCueKey = '';
    renderSubs();
    osd(`Subtitles: ${tracks[have].name}`);
    return;
  }
  const file = player.currentFile;
  const info = player.subtitleTracks.find((t) => t.index === index);
  if (!file || !info) return;
  osd('Reading subtitles…');
  try {
    const track = await extractSubtitles(file, info, (n) => n && n % 400 === 0 && osd(`Reading subtitles… ${n} lines`));
    if (player.currentFile !== file) return; // another file was opened meanwhile
    if (!track.cues.length) {
      toast('That subtitle track is empty.');
      return;
    }
    tracks.push(track);
    embeddedLoaded.set(index, tracks.length - 1);
    subIdx = tracks.length - 1;
    lastCueKey = '';
    renderSubs();
    osd(`Subtitles: ${track.name}`);
  } catch {
    toast('Could not read that subtitle track.');
  }
}

// ----------------------------------------------------------- audio / chapters / quality menus
$('b-audio').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu('menu-audio', (el) => {
    el.replaceChildren();
    for (const a of player.audioChoices()) menuItem(el, a.label, a.current, () => void player.setAudioTrack(a.id).then(() => osd(`Audio: ${a.label}`)));
  });
});
function cycleAudio() {
  const list2 = player.audioChoices();
  if (list2.length < 2) return osd('Only one audio track');
  const i = list2.findIndex((a) => a.current);
  const next = list2[(i + 1) % list2.length];
  void player.setAudioTrack(next.id).then(() => osd(`Audio: ${next.label}`));
}

$('b-quality').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu('menu-quality', (el) => {
    el.replaceChildren();
    for (const q of player.qualities()) menuItem(el, q.label, q.current, () => (player.setQuality(q.id), osd(`Quality: ${q.label}`)));
  });
});

function currentChapterIndex(t: number) {
  const ch = player.chapters;
  let at = -1;
  ch.forEach((c, i) => {
    if (c.start <= t + 0.25) at = i;
  });
  return at;
}
$('b-chap').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu('menu-chap', buildChapMenu);
});
function buildChapMenu(el: HTMLElement) {
  el.replaceChildren();
  const ch = player.chapters;
  if (ch.length) {
    const lab = document.createElement('div');
    lab.className = 'label';
    lab.textContent = 'Chapters';
    el.append(lab);
    const cur = currentChapterIndex(player.time);
    ch.forEach((c, i) => menuItem(el, `${fmt(c.start)}   ${c.title}`, i === cur, () => void player.seek(c.start)));
    el.append(document.createElement('hr'));
  }
  const lab = document.createElement('div');
  lab.className = 'label';
  lab.textContent = 'Bookmarks';
  el.append(lab);
  bookmarks.forEach((b, i) => {
    const row = document.createElement('div');
    row.className = 'mrow';
    menuItem(row, `${fmt(b.t)}   ${b.label}`, null, () => void player.seek(b.t));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'del';
    del.title = 'Remove bookmark';
    del.innerHTML = icons.close;
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      bookmarks.splice(i, 1);
      void saveBookmarks();
      buildChapMenu(el);
    });
    row.append(del);
    el.append(row);
  });
  menuItem(el, `Add bookmark at ${fmt(player.time)}`, null, () => addBookmark(), false);
}
async function saveBookmarks() {
  const cur = list.current;
  if (cur) await setBookmarks(itemKey(cur), bookmarks);
}
function addBookmark() {
  if (!player.info || !list.current) return;
  const t = Math.floor(player.time);
  if (bookmarks.some((b) => Math.abs(b.t - t) < 2)) return osd('Already bookmarked');
  bookmarks.push({ t, label: `Bookmark ${bookmarks.length + 1}` });
  bookmarks.sort((a, b) => a.t - b.t);
  void saveBookmarks();
  osd(`Bookmark added at ${fmt(t)}`);
}
function jumpChapter(dir: 1 | -1) {
  const ch = player.chapters;
  if (!ch.length) return;
  const t = player.time;
  const cur = currentChapterIndex(t);
  const target = dir > 0 ? ch[cur + 1] : t - (ch[cur]?.start ?? 0) > 3 ? ch[cur] : ch[cur - 1];
  if (target) {
    void player.seek(target.start);
    osd(target.title);
  } else if (dir < 0) void player.seek(0);
}

$('b-cast').addEventListener('click', () => void player.cast().catch(() => toast('No cast or AirPlay devices were found.')));

// ------------------------------------------------------------------------ URLs
const urlDialog = $<HTMLDialogElement>('url-dialog');
const urlInput = $<HTMLInputElement>('url-input');
function openUrlDialog() {
  urlInput.value = '';
  urlDialog.showModal();
  urlInput.focus();
}
$('btn-url').addEventListener('click', openUrlDialog);
urlDialog.addEventListener('close', () => {
  if (urlDialog.returnValue !== 'play') return;
  openUrl(urlInput.value.trim());
});
function openUrl(url: string) {
  if (!/^https?:\/\//i.test(url)) {
    toast('Enter a web address starting with http:// or https://.');
    return;
  }
  list.clear();
  void playIndex(list.addUrl(url));
}
window.addEventListener('paste', (e) => {
  const el = e.target as HTMLElement;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
  const text = e.clipboardData?.getData('text')?.trim() ?? '';
  if (/^https?:\/\/\S+$/i.test(text)) openUrl(text);
});
const startUrl = new URLSearchParams(location.search).get('url');
if (startUrl) openUrl(startUrl);

// ------------------------------------------------------------- effects panel
const fxTabs = { audio: $('tab-audio'), video: $('tab-video') };
function showFxTab(which: 'audio' | 'video') {
  $('fx-audio').hidden = which !== 'audio';
  $('fx-video').hidden = which !== 'video';
  fxTabs.audio.setAttribute('aria-selected', String(which === 'audio'));
  fxTabs.video.setAttribute('aria-selected', String(which === 'video'));
}
fxTabs.audio.addEventListener('click', () => showFxTab('audio'));
fxTabs.video.addEventListener('click', () => showFxTab('video'));
function toggleFx(force?: boolean) {
  const open = force ?? !app.classList.contains('fx-open');
  app.classList.toggle('fx-open', open);
  $('b-fx').setAttribute('aria-pressed', String(open));
}
$('b-fx').addEventListener('click', () => toggleFx());
$('fx-close').addEventListener('click', () => toggleFx(false));

function fxRow(label: string, min: number, max: number, step: number, value: number, show: (v: number) => string, onInput: (v: number) => void) {
  const row = document.createElement('div');
  row.className = 'fx-row';
  const l = document.createElement('label');
  l.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  Object.assign(input, { min: String(min), max: String(max), step: String(step), value: String(value) });
  const out = document.createElement('output');
  out.textContent = show(value);
  input.addEventListener('input', () => {
    out.textContent = show(Number(input.value));
    onInput(Number(input.value));
  });
  input.addEventListener('dblclick', () => {
    input.value = String(label === 'Zoom' ? 1 : min <= 0 && max >= 0 ? 0 : value);
    input.dispatchEvent(new Event('input'));
  });
  l.htmlFor = input.id = `fx-${label.replace(/\W/g, '')}-${Math.random().toString(36).slice(2, 6)}`;
  row.append(l, input, out);
  return { row, input, out };
}
function fxCheck(label: string, checked: boolean, onChange: (v: boolean) => void) {
  const l = document.createElement('label');
  l.className = 'check';
  const c = document.createElement('input');
  c.type = 'checkbox';
  c.checked = checked;
  c.addEventListener('change', () => onChange(c.checked));
  l.append(c, document.createTextNode(label));
  return { el: l, input: c };
}
const fxButton = (label: string, onClick: () => void) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
};
const heading = (t: string) => Object.assign(document.createElement('h3'), { textContent: t });
const dbFmt = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(v % 1 ? 1 : 0)} dB`;

function buildAudioFx() {
  const root = $('fx-audio');
  root.replaceChildren();
  const fx: FxSettings = { ...player.fx, bands: [...player.fx.bands] };
  const push = () => player.setFx({ ...fx, bands: [...fx.bands] });

  root.append(fxCheck('Equalizer and effects on', fx.enabled, (v) => ((fx.enabled = v), push())).el);

  const preset = document.createElement('select');
  preset.setAttribute('aria-label', 'Equalizer preset');
  const names = [...Object.keys(EQ_PRESETS), 'Custom'];
  names.forEach((n) => preset.append(new Option(n, n)));
  const matching = Object.entries(EQ_PRESETS).find(([, b]) => b.every((x, i) => x === fx.bands[i]));
  preset.value = matching ? matching[0] : 'Custom';
  root.append(preset);

  const sliders: Array<ReturnType<typeof fxRow>> = [];
  const pre = fxRow('Preamp', -12, 12, 0.5, fx.preamp, dbFmt, (v) => ((fx.preamp = v), (fx.enabled = true), syncEnabled(), push()));
  root.append(pre.row);
  EQ_FREQS.forEach((f, i) => {
    const r = fxRow(f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`, -12, 12, 0.5, fx.bands[i], dbFmt, (v) => {
      fx.bands[i] = v;
      fx.enabled = true;
      preset.value = 'Custom';
      syncEnabled();
      push();
    });
    sliders.push(r);
    root.append(r.row);
  });
  preset.addEventListener('change', () => {
    const b = EQ_PRESETS[preset.value];
    if (!b) return;
    fx.bands = [...b];
    fx.enabled = true;
    sliders.forEach((r, i) => {
      r.input.value = String(b[i]);
      r.out.textContent = dbFmt(b[i]);
    });
    syncEnabled();
    push();
  });
  const enabledBox = root.querySelector('input[type=checkbox]') as HTMLInputElement;
  const syncEnabled = () => (enabledBox.checked = fx.enabled);

  root.append(heading('Sound'));
  root.append(fxCheck('Night mode (even out loud and quiet parts)', fx.normalize, (v) => ((fx.normalize = v), (fx.enabled = true), syncEnabled(), push())).el);
  root.append(fxCheck('Play as mono', fx.mono, (v) => ((fx.mono = v), (fx.enabled = true), syncEnabled(), push())).el);
  root.append(fxRow('Balance', -1, 1, 0.05, fx.balance, (v) => (v === 0 ? 'Centre' : `${v < 0 ? 'L' : 'R'} ${Math.round(Math.abs(v) * 100)}%`), (v) => ((fx.balance = v), (fx.enabled = true), syncEnabled(), push())).row);
  const actions = document.createElement('div');
  actions.className = 'fx-actions';
  actions.append(fxButton('Reset audio', () => (player.setFx({ enabled: false, preamp: 0, bands: EQ_PRESETS.Flat.slice(), normalize: false, mono: false, balance: 0 }), buildAudioFx())));
  root.append(actions);
}

function applyVideoNow() {
  applyVideo(stage, [player.video, player.canvas], vs);
}
function buildVideoFx() {
  const root = $('fx-video');
  root.replaceChildren();
  const pct = (v: number) => `${v}%`;
  const rows: Array<ReturnType<typeof fxRow>> = [];
  const add = (label: string, min: number, max: number, step: number, value: number, show: (v: number) => string, set: (v: number) => void) => {
    const r = fxRow(label, min, max, step, value, show, (v) => (set(v), applyVideoNow()));
    rows.push(r);
    root.append(r.row);
  };
  root.append(heading('Colour'));
  add('Brightness', 0, 200, 1, vs.brightness, pct, (v) => (vs.brightness = v));
  add('Contrast', 0, 200, 1, vs.contrast, pct, (v) => (vs.contrast = v));
  add('Saturation', 0, 200, 1, vs.saturation, pct, (v) => (vs.saturation = v));
  add('Hue', -180, 180, 1, vs.hue, (v) => `${v}°`, (v) => (vs.hue = v));
  add('Gamma', 0.5, 2.5, 0.05, vs.gamma, (v) => v.toFixed(2), (v) => (vs.gamma = v));
  add('Sharpen', 0, 1, 0.05, vs.sharpen, (v) => `${Math.round(v * 100)}%`, (v) => (vs.sharpen = v));
  root.append(fxCheck('Black and white', vs.grayscale, (v) => ((vs.grayscale = v), applyVideoNow())).el);
  root.append(fxCheck('Invert colours', vs.invert, (v) => ((vs.invert = v), applyVideoNow())).el);

  root.append(heading('Picture'));
  const aspect = document.createElement('select');
  aspect.setAttribute('aria-label', 'Aspect ratio');
  ASPECTS.forEach(([v, n]) => aspect.append(new Option(n, v)));
  aspect.value = vs.aspect;
  aspect.addEventListener('change', () => ((vs.aspect = aspect.value as Aspect), applyVideoNow()));
  root.append(aspect);
  add('Zoom', 1, 4, 0.05, vs.zoom, (v) => `${v.toFixed(2)}×`, (v) => ((vs.zoom = v), v === 1 && ((vs.panX = 0), (vs.panY = 0))));
  const actions = document.createElement('div');
  actions.className = 'fx-actions';
  actions.append(
    fxButton('Rotate ⟲', () => ((vs.rotate = ((vs.rotate + 270) % 360) as typeof vs.rotate), applyVideoNow())),
    fxButton('Rotate ⟳', () => ((vs.rotate = ((vs.rotate + 90) % 360) as typeof vs.rotate), applyVideoNow())),
    fxButton('Flip ↔', () => ((vs.flipH = !vs.flipH), applyVideoNow())),
    fxButton('Flip ↕', () => ((vs.flipV = !vs.flipV), applyVideoNow())),
    fxButton('Reset video', () => (Object.assign(vs, defaultVideo()), applyVideoNow(), buildVideoFx())),
  );
  root.append(actions);
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = 'Drag the picture to move it when zoomed in. Double-click a slider to reset it.';
  root.append(note);
}
buildAudioFx();
buildVideoFx();
window.addEventListener('resize', applyVideoNow);
document.addEventListener('fullscreenchange', () => setTimeout(applyVideoNow, 60));

// drag to pan when zoomed in; wheel changes volume (pinch / Ctrl+wheel zooms)
let pan: { x: number; y: number; px: number; py: number; moved: boolean } | null = null;
let justPanned = false;
stage.addEventListener('pointerdown', (e) => {
  if (vs.zoom <= 1 || (e.target as HTMLElement).closest('.controls, .menu, .empty') || e.button !== 0) return;
  pan = { x: e.clientX, y: e.clientY, px: vs.panX, py: vs.panY, moved: false };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', (e) => {
  if (!pan) return;
  const dx = e.clientX - pan.x;
  const dy = e.clientY - pan.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) pan.moved = true;
  if (pan.moved) {
    vs.panX = pan.px + dx;
    vs.panY = pan.py + dy;
    applyVideoNow();
  }
});
stage.addEventListener('pointerup', () => {
  justPanned = !!pan?.moved;
  pan = null;
  if (justPanned) setTimeout(() => (justPanned = false), 50);
});
stage.addEventListener(
  'wheel',
  (e) => {
    if ((e.target as HTMLElement).closest('.controls, .menu, .empty, .playlist')) return;
    e.preventDefault();
    if (e.ctrlKey) {
      vs.zoom = Math.min(4, Math.max(1, vs.zoom * (e.deltaY < 0 ? 1.06 : 0.94)));
      if (vs.zoom === 1) vs.panX = vs.panY = 0;
      applyVideoNow();
      buildVideoFx();
    } else setVolume(Math.min(2, Math.max(0, player.volume + (e.deltaY < 0 ? 0.05 : -0.05))), false);
  },
  { passive: false },
);
// swallow the click that ends a pan so it doesn't toggle playback
stage.addEventListener('click', (e) => justPanned && e.stopImmediatePropagation(), true);

// ----------------------------------------------------------------- visualizer
const viz = $<HTMLCanvasElement>('viz');
const vctx = viz.getContext('2d')!;
const vbuf = new Uint8Array(128);
function drawViz() {
  if (!player.info || player.info.hasVideo || $('audioart').hidden) return;
  const an = player.analyser;
  vctx.clearRect(0, 0, viz.width, viz.height);
  if (!an || !player.playing) return;
  an.getByteFrequencyData(vbuf);
  const bars = 48;
  const w = viz.width / bars;
  const grad = vctx.createLinearGradient(0, viz.height, 0, 0);
  grad.addColorStop(0, '#ff8a24');
  grad.addColorStop(1, '#ffd2a1');
  vctx.fillStyle = grad;
  for (let i = 0; i < bars; i++) {
    const v = vbuf[Math.floor((i / bars) * 90)] / 255;
    const h = Math.max(3, v * viz.height);
    vctx.fillRect(i * w + 2, viz.height - h, w - 4, h);
  }
}
(function vizLoop() {
  requestAnimationFrame(vizLoop);
  drawViz();
})();

// ---------------------------------------------------------- extra keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const el = e.target as HTMLElement;
  if (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range' && (el as HTMLInputElement).type !== 'checkbox') return;
  if (el.tagName === 'SELECT' || urlDialog.open || $<HTMLDialogElement>('info').open) return;
  const run = (fn: () => void) => {
    e.preventDefault();
    fn();
    wake();
  };
  switch (e.key) {
    case 'u':
      return run(openUrlDialog);
    case 'e':
      return run(() => toggleFx());
    case 'b':
      return run(addBookmark);
    case 't':
      return run(cycleAudio);
    case 'v':
      return run(() => {
        const order = ASPECTS.map(([a]) => a);
        vs.aspect = order[(order.indexOf(vs.aspect) + 1) % order.length];
        applyVideoNow();
        buildVideoFx();
        osd(`Aspect: ${ASPECTS.find(([a]) => a === vs.aspect)?.[1]}`);
      });
    case 'PageDown':
      return run(() => jumpChapter(1));
    case 'PageUp':
      return run(() => jumpChapter(-1));
  }
});

// keep the track buttons right when the picture engine changes or a new file is loaded
refreshTrackUI();

// ======================================================================= themes
const THEMES: Array<[typeof settings.theme, string]> = [
  ['auto', 'Automatic (follow system)'],
  ['dark', 'Dark'],
  ['light', 'Light'],
  ['oled', 'OLED black'],
  ['contrast', 'High contrast'],
];
const ACCENTS: Array<[typeof settings.accent, string]> = [
  ['orange', '#ff8a24'],
  ['blue', '#4c9aff'],
  ['green', '#35c27a'],
  ['pink', '#ff5c9a'],
  ['purple', '#a06bff'],
];
function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === 'auto') root.removeAttribute('data-theme');
  else root.dataset.theme = settings.theme;
  if (settings.accent === 'orange') root.removeAttribute('data-accent');
  else root.dataset.accent = settings.accent;
  // keep the browser / installed-app chrome in the same colour as the top bar
  requestAnimationFrame(() => {
    const c = getComputedStyle(root).getPropertyValue('--panel').trim();
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', c || '#0f1115');
  });
}
applyTheme();
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => settings.theme === 'auto' && applyTheme());
setIcon('btn-theme', icons.palette);
$('btn-theme').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu('menu-theme', buildThemeMenu);
});
function buildThemeMenu(el: HTMLElement) {
  el.replaceChildren();
  THEMES.forEach(([id, label]) =>
    menuItem(el, label, settings.theme === id, () => {
      settings.theme = id;
      saveSettings(settings);
      applyTheme();
    }),
  );
  el.append(document.createElement('hr'));
  const lab = document.createElement('div');
  lab.className = 'label';
  lab.textContent = 'Accent colour';
  el.append(lab);
  const row = document.createElement('div');
  row.className = 'swatches';
  ACCENTS.forEach(([id, color]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = id;
    b.setAttribute('aria-label', `Accent ${id}`);
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(settings.accent === id));
    b.style.background = color;
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      settings.accent = id;
      saveSettings(settings);
      applyTheme();
      row.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    });
    row.append(b);
  });
  el.append(row);
}
menus.push('menu-theme');

// ================================================================ mobile app (PWA)
const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// install button (Chrome, Edge, Samsung Internet …) and the iOS "Add to Home Screen" hint
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let installEvent: InstallEvent | null = null;
labelled('btn-install', icons.download, 'Install');
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e as InstallEvent;
  $('btn-install').hidden = false;
});
$('btn-install').addEventListener('click', async () => {
  if (!installEvent) return;
  await installEvent.prompt();
  const { outcome } = await installEvent.userChoice;
  if (outcome === 'accepted') $('btn-install').hidden = true;
  installEvent = null;
});
window.addEventListener('appinstalled', () => {
  $('btn-install').hidden = true;
  toast('Installed. Open it from your home screen or app list.');
});
if (isIos && !standalone && !localStorage.getItem('webplayer.iosHint')) {
  $('ios-hint').hidden = false;
  $('ios-hint-close').addEventListener('click', () => {
    $('ios-hint').hidden = true;
    try {
      localStorage.setItem('webplayer.iosHint', '1');
    } catch {
      /* storage unavailable */
    }
  });
}
// iOS has no folder picker
if (isIos) {
  $('btn-folder').hidden = true;
  $('empty-folder').hidden = true;
}

// files shared to the app from the system share sheet (see the service worker)
async function takeSharedFiles() {
  if (!new URLSearchParams(location.search).has('shared')) return;
  history.replaceState(null, '', '/');
  try {
    const cache = await caches.open('webplayer-share');
    const files: File[] = [];
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      if (!res) continue;
      files.push(new File([await res.blob()], decodeURIComponent(res.headers.get('X-Name') ?? 'shared'), { type: res.headers.get('Content-Type') ?? '', lastModified: Number(res.headers.get('X-Modified')) || Date.now() }));
      await cache.delete(req);
    }
    if (files.length) openFiles(files);
  } catch {
    toast('Could not open the shared file.');
  }
}
void takeSharedFiles();
if (new URLSearchParams(location.search).get('dialog') === 'url') {
  history.replaceState(null, '', '/');
  openUrlDialog();
}

// updates: the new service worker waits until you choose to reload
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.ready.then(() => {
    if (!localStorage.getItem('webplayer.offlineNote')) {
      toast('Ready to work offline.');
      try {
        localStorage.setItem('webplayer.offlineNote', '1');
      } catch {
        /* storage unavailable */
      }
    }
  });
  navigator.serviceWorker.getRegistration().then((reg) => {
    if (!reg) return;
    const offer = (worker: ServiceWorker) => {
      $('update-bar').hidden = false;
      $('update-reload').onclick = () => worker.postMessage('SKIP_WAITING');
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => w.state === 'installed' && navigator.serviceWorker.controller && offer(w));
    });
    // check for a new version whenever the app comes back to the foreground
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void reg.update().catch(() => undefined));
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

// ================================================================ touch gestures
// swipe sideways = seek, swipe up/down on the right = volume, on the left = picture brightness, hold = 2× speed
interface Gesture { id: number; x: number; y: number; mode: '' | 'seek' | 'vol' | 'bright'; t0: number; vol0: number; br0: number; hold: number; held: boolean; target: number }
let gesture: Gesture | null = null;
stage.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || vs.zoom > 1 || !player.info || (e.target as HTMLElement).closest('.controls, .menu, .empty')) return;
  const g: Gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, mode: '', t0: player.time, vol0: player.volume, br0: vs.brightness, hold: 0, held: false, target: 0 };
  g.hold = window.setTimeout(() => {
    if (gesture === g && !g.mode && player.canChangeRate && player.playing) {
      g.held = true;
      player.setRate(2);
      osd('2× speed');
    }
  }, 500);
  gesture = g;
});
stage.addEventListener('pointermove', (e) => {
  const g = gesture;
  if (!g || e.pointerId !== g.id) return;
  const dx = e.clientX - g.x;
  const dy = e.clientY - g.y;
  const rect = stage.getBoundingClientRect();
  if (!g.mode) {
    if (Math.abs(dx) < 14 && Math.abs(dy) < 14) return;
    clearTimeout(g.hold);
    if (Math.abs(dx) > Math.abs(dy)) {
      if (!player.duration) return void (gesture = null);
      g.mode = 'seek';
    } else g.mode = e.clientX - rect.left > rect.width / 2 ? 'vol' : 'bright';
  }
  if (g.mode === 'seek') {
    g.target = Math.max(0, Math.min(player.duration, g.t0 + (dx / rect.width) * 120));
    osd(`${fmt(g.target)}  (${g.target >= g.t0 ? '+' : '−'}${Math.abs(Math.round(g.target - g.t0))} s)`);
  } else if (g.mode === 'vol') {
    setVolume(Math.max(0, Math.min(2, g.vol0 - (dy / rect.height) * 1.4)), false);
  } else {
    vs.brightness = Math.round(Math.max(40, Math.min(180, g.br0 - (dy / rect.height) * 140)));
    applyVideoNow();
    osd(`Brightness ${vs.brightness}%`);
  }
});
const endGesture = (e: PointerEvent) => {
  const g = gesture;
  if (!g || e.pointerId !== g.id) return;
  gesture = null;
  clearTimeout(g.hold);
  if (g.held) {
    player.setRate(1);
    suppressTap = true;
  }
  if (g.mode) {
    suppressTap = true;
    if (g.mode === 'seek' && e.type === 'pointerup') void player.seek(g.target);
    if (g.mode === 'bright') buildVideoFx();
  }
};
stage.addEventListener('pointerup', endGesture, true);
stage.addEventListener('pointercancel', endGesture, true);

// every icon button gets an accessible name from its tooltip
document.querySelectorAll<HTMLElement>('button[title]:not([aria-label])').forEach((b) => b.setAttribute('aria-label', b.title));
