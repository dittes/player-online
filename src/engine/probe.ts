/**
 * Looks inside a media file with FFmpeg (WebAssembly) without playing it: lists audio, video and subtitle
 * tracks and chapters, and pulls text subtitles out of the container. Uses its own libav instance, so playback
 * is never disturbed. Only the first reading of the headers is needed for the track list; extracting subtitles
 * reads the whole file once (they are spread through it).
 */
import { decodeText, type Cue, type SubtitleTrack } from '../subtitles';

type LibAV = any;
const BASE = `${import.meta.env.BASE_URL ?? '/'}vendor/libav`.replace(/\/{2,}/g, '/');

export interface TrackInfo {
  index: number;
  kind: 'video' | 'audio' | 'subtitle';
  codec: string;
  lang?: string;
  title?: string;
  channels?: number;
  sampleRate?: number;
  /** Subtitles only: the text can be extracted (bitmap subtitles such as PGS and VobSub can't). */
  text?: boolean;
}

export interface Chapter {
  start: number;
  end: number;
  title: string;
}

export interface ProbeResult {
  tracks: TrackInfo[];
  chapters: Chapter[];
}

const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
const NOPTS_HI = -2147483648;
const TWO32 = 4294967296;

async function openLibav(): Promise<LibAV> {
  const mod = await import(/* @vite-ignore */ `${BASE}/libav-lite.mjs`);
  return mod.default.LibAV({ base: BASE, nothreads: true });
}

const ts = (lo?: number, hi?: number, tb = 1): number | null => {
  if (lo === undefined) return null;
  const h = hi ?? 0;
  if (h === NOPTS_HI && lo === 0) return null;
  return ((lo >>> 0) + h * TWO32) * tb;
};

async function withDemuxer<T>(file: File, fn: (L: LibAV, fmt: number, streams: any[]) => Promise<T>): Promise<T> {
  const L = await openLibav();
  const name = `probe_${Math.random().toString(36).slice(2)}`;
  try {
    await L.mkreadaheadfile(name, file);
    const [fmt, streams] = await L.ff_init_demuxer_file(name);
    return await fn(L, fmt, streams);
  } finally {
    try {
      await L.unlinkreadaheadfile(name);
    } catch {
      /* ignore */
    }
    try {
      L.terminate?.();
    } catch {
      /* ignore */
    }
  }
}

export function probeFile(file: File): Promise<ProbeResult> {
  return withDemuxer(file, async (L, fmt, streams) => {
    const tracks: TrackInfo[] = [];
    for (const s of streams) {
      const kind = s.codec_type === L.AVMEDIA_TYPE_VIDEO ? 'video' : s.codec_type === L.AVMEDIA_TYPE_AUDIO ? 'audio' : s.codec_type === L.AVMEDIA_TYPE_SUBTITLE ? 'subtitle' : null;
      if (!kind) continue;
      const codec: string = await L.avcodec_get_name(s.codec_id);
      const t: TrackInfo = {
        index: s.index,
        kind,
        codec,
        lang: s.metadata?.language && s.metadata.language !== 'und' ? s.metadata.language : undefined,
        title: s.metadata?.title || undefined,
      };
      if (kind === 'audio') {
        t.sampleRate = await L.AVCodecParameters_sample_rate(s.codecpar);
        t.channels = (await L.AVCodecParameters_ch_layout_nb_channels?.(s.codecpar)) || (await L.AVCodecParameters_channels?.(s.codecpar)) || undefined;
      }
      if (kind === 'subtitle') t.text = TEXT_SUBS.has(codec);
      tracks.push(t);
    }
    let chapters: Chapter[] = [];
    try {
      const raw: any[] = await L.ff_get_demuxer_chapters(fmt);
      // libav.js folds 64-bit chapter times into 32 bits in its summary object; read low and high words ourselves.
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        const tb = c.time_base_num / c.time_base_den;
        const start = ts(await L.AVChapter_start(c.ptr), await L.AVChapter_starthi(c.ptr), tb);
        const end = ts(await L.AVChapter_end(c.ptr), await L.AVChapter_endhi(c.ptr), tb);
        if (start !== null && Number.isFinite(start)) chapters.push({ start, end: end ?? start, title: c.metadata?.title || `Chapter ${i + 1}` });
      }
    } catch {
      /* container has no chapters */
    }
    return { tracks, chapters };
  });
}

/** Text of one subtitle packet, by codec. */
function packetText(codec: string, data: Uint8Array): string {
  if (codec === 'mov_text') {
    const len = (data[0] << 8) | data[1];
    return new TextDecoder().decode(data.subarray(2, 2 + len));
  }
  const text = decodeText(data.slice().buffer);
  if (codec === 'ass' || codec === 'ssa') {
    // Matroska stores "ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text"
    const parts = text.split(',');
    return parts
      .slice(8)
      .join(',')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/gi, '\n')
      .replace(/\\h/g, ' ')
      .trim();
  }
  return text.replace(/\r/g, '').trim();
}

/** Read every packet of one text-subtitle track and turn it into cues. `onProgress` gets the cue count so far. */
export function extractSubtitles(file: File, track: TrackInfo, onProgress?: (cues: number) => void): Promise<SubtitleTrack> {
  return withDemuxer(file, async (L, fmt, streams) => {
    const stream = streams.find((s) => s.index === track.index);
    if (!stream) throw new Error('track not found');
    // Ask the demuxer to skip everything else.
    for (const s of streams) if (s.index !== track.index) await L.AVStream_discard_s?.(s.ptr, L.AVDISCARD_ALL ?? 48);
    const pkt = await L.av_packet_alloc();
    const tb = stream.time_base_num / stream.time_base_den;
    const cues: Cue[] = [];
    for (;;) {
      const [res, packets] = await L.ff_read_frame_multi(fmt, pkt, { limit: 512 * 1024 });
      for (const p of (packets[track.index] ?? []) as any[]) {
        const start = ts(p.pts ?? p.dts, p.ptshi ?? p.dtshi, tb);
        const dur = ts(p.duration, p.durationhi, tb) ?? 0;
        if (start === null) continue;
        const text = packetText(track.codec, p.data);
        if (text) cues.push({ start, end: start + (dur > 0 ? dur : 3), text });
      }
      onProgress?.(cues.length);
      if (res === L.AVERROR_EOF || (res !== 0 && res !== -L.EAGAIN)) break;
    }
    cues.sort((a, b) => a.start - b.start);
    const label = [track.title, track.lang?.toUpperCase(), track.codec].filter(Boolean).join(' · ');
    return { name: `Embedded: ${label}`, cues };
  });
}

/** Browser-decodable audio codecs (by the names FFmpeg uses); others need the built-in sound decoder. */
export function browserCanDecodeAudio(codec: string): boolean {
  const a = document.createElement('audio');
  const map: Record<string, string> = {
    ac3: 'audio/mp4; codecs="ac-3"',
    eac3: 'audio/mp4; codecs="ec-3"',
    dts: '', dca: '', truehd: '', mlp: '', wmav1: '', wmav2: '', wmapro: '', wmalossless: '', mp2: 'audio/mpeg',
  };
  if (!(codec in map)) return true; // aac, mp3, opus, vorbis, flac, pcm …
  const mime = map[codec];
  return mime !== '' && a.canPlayType(mime) !== '';
}
