/** Subtitle parsing (SRT, WebVTT, ASS/SSA text) and a cue lookup by time. No DOM or network. */

export interface Cue {
  start: number;
  end: number;
  /** Plain text with line breaks; <i>, <b> and <u> are kept as simple markers. */
  text: string;
}

export interface SubtitleTrack {
  name: string;
  cues: Cue[];
}

/** Decode bytes as UTF-8 (with BOM handling), falling back to Windows-1252 for old files. */
export function decodeText(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8);
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8);
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(u8).replace(/^﻿/, '');
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(u8) : utf8;
}

const clean = (s: string) => s.replace(/\r/g, '').trim();

function clock(s: string): number {
  // 00:01:02,500 | 01:02.500 | 1:02:03.45 (ASS)
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(s.trim());
  if (!m) return NaN;
  const frac = Number(m[4].padEnd(3, '0').slice(0, 3)) / 1000;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

function parseSrtOrVtt(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = clean(text).replace(/^WEBVTT[^\n]*\n/, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = clock(a);
    const end = clock(b.trim().split(/\s+/)[0]);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    cues.push({ start, end, text: lines.slice(i + 1).join('\n').trim() });
  }
  return cues;
}

function parseAss(text: string): Cue[] {
  const cues: Cue[] = [];
  let fields: string[] = [];
  for (const raw of clean(text).split('\n')) {
    const line = raw.trim();
    if (/^Format:/i.test(line) && /Start/i.test(line)) fields = line.slice(7).split(',').map((f) => f.trim().toLowerCase());
    else if (/^Dialogue:/i.test(line)) {
      const parts = line.slice(9).trim().split(',');
      const idx = (n: string, d: number) => (fields.includes(n) ? fields.indexOf(n) : d);
      const iText = idx('text', 9);
      const start = clock(parts[idx('start', 1)]);
      const end = clock(parts[idx('end', 2)]);
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      const body = parts
        .slice(iText)
        .join(',')
        .replace(/\{[^}]*\}/g, '')
        .replace(/\\N/gi, '\n')
        .replace(/\\h/g, ' ')
        .trim();
      if (body) cues.push({ start, end, text: body });
    }
  }
  return cues;
}

export function parseSubtitles(name: string, bytes: ArrayBuffer): SubtitleTrack {
  const text = decodeText(bytes);
  const isAss = /\.(ass|ssa)$/i.test(name) || /^\[Script Info\]/m.test(text);
  const cues = (isAss ? parseAss(text) : parseSrtOrVtt(text)).sort((x, y) => x.start - y.start);
  return { name, cues };
}

export const isSubtitleName = (name: string) => /\.(srt|vtt|ass|ssa)$/i.test(name);

/** Cues that are visible at time t (after applying the user's delay in seconds). */
export function cuesAt(track: SubtitleTrack | null, t: number, delay = 0): Cue[] {
  if (!track) return [];
  const x = t - delay;
  const c = track.cues;
  // binary search for the last cue starting at or before x, then scan back a little for overlaps
  let lo = 0;
  let hi = c.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c[mid].start <= x) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const out: Cue[] = [];
  for (let i = at; i >= 0 && i > at - 6; i--) if (c[i].end > x) out.unshift(c[i]);
  return out;
}

/** Render cue text into an element: only <i>, <b> and <u> survive, everything else is plain text. */
export function renderCueText(el: HTMLElement, cues: Cue[]) {
  el.replaceChildren();
  cues.forEach((cue, n) => {
    if (n) el.append(document.createElement('br'));
    const root = document.createElement('span');
    let cur: HTMLElement = root;
    for (const part of cue.text.split(/(<\/?[ibu]>)/i)) {
      const tag = /^<(\/?)([ibu])>$/i.exec(part);
      if (tag) {
        if (tag[1]) cur = (cur.parentElement as HTMLElement | null) ?? root;
        else {
          const child = document.createElement(tag[2].toLowerCase());
          cur.append(child);
          cur = child;
        }
      } else {
        // strip any other markup the file might contain, keep the words
        const textOnly = part.replace(/<[^>]*>/g, '');
        textOnly.split('\n').forEach((line, i) => {
          if (i) cur.append(document.createElement('br'));
          cur.append(document.createTextNode(line));
        });
      }
    }
    el.append(root);
  });
}
