import { describe, expect, it } from 'vitest';
import { Playlist, itemKey } from '../src/playlist';

const file = (name: string, size = 10) => new File([new Uint8Array(size)], name, { lastModified: 1 });
const isSub = (f: File) => /\.(srt|vtt|ass)$/i.test(f.name);

describe('Playlist', () => {
  it('adds files in natural order and attaches subtitles with the same base name', () => {
    const p = new Playlist();
    const first = p.add([file('ep10.mkv'), file('ep2.mkv'), file('ep2.en.srt'), file('ep10.srt')], isSub);
    expect(first).toBe(0);
    expect(p.items.map((i) => i.name)).toEqual(['ep2.mkv', 'ep10.mkv']);
    expect(p.items[0].subs.map((s) => s.name)).toEqual(['ep2.en.srt']);
    expect(p.items[1].subs.map((s) => s.name)).toEqual(['ep10.srt']);
  });

  it('gives subtitles dropped alone to the current item', () => {
    const p = new Playlist();
    p.add([file('a.mp4')], isSub);
    p.select(0);
    expect(p.add([file('x.srt')], isSub)).toBe(-1);
    expect(p.current?.subs).toHaveLength(1);
  });

  it('moves through the list and stops at the end unless repeat is on', () => {
    const p = new Playlist();
    p.add([file('a.mp4'), file('b.mp4'), file('c.mp4')], isSub);
    p.select(0);
    expect(p.next(true)?.name).toBe('b.mp4');
    expect(p.next(true)?.name).toBe('c.mp4');
    expect(p.next(true)).toBeUndefined();
    p.repeat = 'all';
    expect(p.next(true)?.name).toBe('a.mp4');
    p.repeat = 'one';
    expect(p.next(true)?.name).toBe('a.mp4'); // auto-advance repeats the same item
    expect(p.next(false)?.name).toBe('b.mp4'); // pressing "next" still moves on
  });

  it('goes back, wrapping only with repeat all', () => {
    const p = new Playlist();
    p.add([file('a.mp4'), file('b.mp4')], isSub);
    p.select(0);
    expect(p.prev()?.name).toBe('a.mp4');
    p.repeat = 'all';
    expect(p.prev()?.name).toBe('b.mp4');
  });

  it('shuffle plays every item once before ending', () => {
    const p = new Playlist();
    p.add([file('a.mp4'), file('b.mp4'), file('c.mp4'), file('d.mp4')], isSub);
    p.shuffle = true;
    p.select(2);
    const seen = new Set([p.current!.name]);
    for (let i = 0; i < 3; i++) seen.add(p.next(true)!.name);
    expect(seen.size).toBe(4);
    expect(p.next(true)).toBeUndefined();
  });

  it('keeps the current item when reordering or removing others', () => {
    const p = new Playlist();
    p.add([file('a.mp4'), file('b.mp4'), file('c.mp4')], isSub);
    p.select(1);
    p.move(0, 2);
    expect(p.items.map((i) => i.name)).toEqual(['b.mp4', 'c.mp4', 'a.mp4']);
    expect(p.current?.name).toBe('b.mp4');
    p.remove(2);
    expect(p.current?.name).toBe('b.mp4');
    p.remove(0);
    expect(p.index).toBeLessThanOrEqual(p.items.length - 1);
  });

  it('adds network addresses and keys items by file identity or URL', () => {
    const p = new Playlist();
    const i = p.addUrl('https://example.com/media/My%20Show.m3u8?token=1');
    expect(p.items[i].name).toBe('My Show.m3u8');
    expect(itemKey(p.items[i])).toBe('https://example.com/media/My%20Show.m3u8?token=1');
    p.add([file('a.mp4', 5)], isSub);
    expect(itemKey(p.items[1])).toBe('a.mp4|5|1');
  });

  it('notifies listeners', () => {
    const p = new Playlist();
    let n = 0;
    p.onChange = () => n++;
    p.add([file('a.mp4')], isSub);
    p.select(0);
    p.clear();
    expect(n).toBe(3);
  });
});
