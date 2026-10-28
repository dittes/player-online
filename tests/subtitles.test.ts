import { describe, expect, it } from 'vitest';
import { cuesAt, decodeText, isSubtitleName, parseSubtitles } from '../src/subtitles';

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe('subtitle parsing', () => {
  it('parses SRT with tags, multi-line text and comma milliseconds', () => {
    const t = parseSubtitles('a.srt', enc('1\n00:00:01,500 --> 00:00:03,000\nHello <i>there</i>\nsecond line\n\n2\n00:01:00,000 --> 00:01:02,250\nBye\n'));
    expect(t.cues).toHaveLength(2);
    expect(t.cues[0]).toEqual({ start: 1.5, end: 3, text: 'Hello <i>there</i>\nsecond line' });
    expect(t.cues[1].start).toBe(60);
    expect(t.cues[1].end).toBe(62.25);
  });

  it('parses WebVTT with header, cue ids, settings and short timestamps', () => {
    const t = parseSubtitles('a.vtt', enc('WEBVTT - title\n\nintro\n00:01.000 --> 00:02.500 line:90% align:center\nFirst\n\n01:00:00.000 --> 01:00:01.000\nHour mark\n'));
    expect(t.cues.map((c) => [c.start, c.end, c.text])).toEqual([
      [1, 2.5, 'First'],
      [3600, 3601, 'Hour mark'],
    ]);
  });

  it('parses ASS dialogue lines, stripping override tags and honouring the Format order', () => {
    const ass = [
      '[Script Info]',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\i1}Hallo{\\i0}, Welt\\Nzweite Zeile',
      'Comment: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,not a dialogue',
    ].join('\n');
    const t = parseSubtitles('a.ass', enc(ass));
    expect(t.cues).toEqual([{ start: 1, end: 3.5, text: 'Hallo, Welt\nzweite Zeile' }]);
  });

  it('sorts cues and ignores broken blocks', () => {
    const t = parseSubtitles('a.srt', enc('2\n00:00:09,000 --> 00:00:10,000\nlate\n\ngarbage\n\n1\n00:00:01,000 --> 00:00:02,000\nearly\n'));
    expect(t.cues.map((c) => c.text)).toEqual(['early', 'late']);
  });

  it('falls back to Windows-1252 when the bytes are not valid UTF-8', () => {
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in latin1
    expect(decodeText(bytes.buffer)).toBe('café');
    expect(decodeText(enc('﻿naïve'))).toBe('naïve');
  });

  it('reads UTF-16 files with a byte order mark', () => {
    const s = 'Grüße';
    const buf = new Uint8Array(2 + s.length * 2);
    buf.set([0xff, 0xfe]);
    for (let i = 0; i < s.length; i++) new DataView(buf.buffer).setUint16(2 + i * 2, s.charCodeAt(i), true);
    expect(decodeText(buf.buffer)).toBe(s);
  });

  it('recognises subtitle file names', () => {
    expect(['a.srt', 'B.VTT', 'c.ass', 'd.ssa'].every(isSubtitleName)).toBe(true);
    expect(isSubtitleName('movie.mkv')).toBe(false);
  });
});

describe('cue lookup', () => {
  const track = parseSubtitles('a.srt', enc('1\n00:00:01,000 --> 00:00:04,000\nlong\n\n2\n00:00:02,000 --> 00:00:03,000\noverlap\n\n3\n00:00:10,000 --> 00:00:11,000\nlater\n'));
  it('finds the visible cues, including overlaps', () => {
    expect(cuesAt(track, 0.5)).toHaveLength(0);
    expect(cuesAt(track, 2.5).map((c) => c.text)).toEqual(['long', 'overlap']);
    expect(cuesAt(track, 3.5).map((c) => c.text)).toEqual(['long']);
    expect(cuesAt(track, 10.5).map((c) => c.text)).toEqual(['later']);
    expect(cuesAt(null, 1)).toEqual([]);
  });
  it('applies the user delay', () => {
    expect(cuesAt(track, 11.5, 1).map((c) => c.text)).toEqual(['later']);
    expect(cuesAt(track, 1.5, 1)).toHaveLength(0);
  });
});
