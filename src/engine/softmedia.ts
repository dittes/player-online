/**
 * Software media engine for formats the browser cannot play on its own
 * (AVI, WMV/ASF, FLV, MPEG-PS/TS, and MKV/MP4 files with AC-3, DTS or WMA sound).
 *
 * FFmpeg runs as WebAssembly (libav.js, custom build in public/vendor/libav, see
 * scripts/libav/README.md). Everything happens in this tab: the file is read in
 * slices through a Blob, frames are drawn to a canvas and sound goes through
 * Web Audio. Nothing is uploaded and no network request is made besides loading
 * the engine from this site.
 *
 * Two modes:
 *  - full:    decode video and audio; the audio clock is the master clock.
 *  - sidecar: the browser plays the picture in a muted <video>, this engine only
 *             decodes the audio track and keeps it in sync with that element
 *             (the usual case for MKV/MP4 with AC-3 or DTS sound).
 */

import { audioStreamToConfig, videoStreamToConfig } from 'libavjs-webcodecs-bridge';

type LibAV = any; // libav.js has no usable bundled types for the custom variant

/**
 * Who decodes what. Codecs that are patent-licensed to browser vendors (H.264, HEVC, AAC …) are decoded by the
 * browser through WebCodecs, never by this app's own WebAssembly code: libav.js only demuxes them. The WebAssembly
 * decoders cover older codecs that browsers don't have (MPEG-1/2/4, Windows Media, Sorenson, AC-3, DTS …).
 */
const WC_VIDEO = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']);
const WC_AUDIO = new Set(['aac', 'opus', 'vorbis']);

const startsWithStartCode = (d?: Uint8Array) => !!d && d.length > 4 && d[0] === 0 && d[1] === 0 && (d[2] === 1 || (d[2] === 0 && d[3] === 1));

async function wcVideoConfig(L: LibAV, s: any, codec: string): Promise<VideoDecoderConfig | null> {
  if (typeof VideoDecoder === 'undefined' || !WC_VIDEO.has(codec)) return null;
  try {
    const cp = await L.ff_copyout_codecpar(s.codecpar);
    let cfg = await videoStreamToConfig(L, s);
    if (!cfg || cfg.codec === 'unknown') return null;
    // Transport streams and similar carry Annex B with parameter sets in the stream: no description, and the codec
    // string comes from the probed profile and level (the bridge only understands MP4-style extradata for HEVC).
    if (startsWithStartCode(cp.extradata)) {
      cfg = { ...cfg, description: undefined };
      if (codec === 'hevc') cfg.codec = `hvc1.${cp.profile > 0 ? cp.profile : 1}.${cp.profile === 2 ? '4' : '6'}.L${cp.level > 0 ? cp.level : 120}.B0`;
    }
    if (!cfg.description && codec === 'h264') (cfg as any).avc = { format: 'annexb' };
    if (!cfg.description && codec === 'hevc') (cfg as any).hevc = { format: 'annexb' };
    const r = await VideoDecoder.isConfigSupported(cfg);
    return r.supported ? (r.config ?? cfg) : null;
  } catch {
    return null;
  }
}

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** AAC in ADTS (transport streams, .aac): no extradata and often no probed sample rate, so read it from the first frame header. */
function adtsConfig(d: Uint8Array | null): { cfg: AudioDecoderConfig; header: number } | null {
  if (!d || d.length < 7 || d[0] !== 0xff || (d[1] & 0xf0) !== 0xf0) return null;
  const aot = ((d[2] >> 6) & 3) + 1;
  const idx = (d[2] >> 2) & 15;
  const channels = ((d[2] & 1) << 2) | (d[3] >> 6);
  if (idx >= ADTS_RATES.length || !channels) return null;
  // AudioSpecificConfig: object type (5 bits), frequency index (4), channel configuration (4)
  const asc = new Uint8Array([(aot << 3) | (idx >> 1), ((idx & 1) << 7) | (channels << 3)]);
  return { cfg: { codec: `mp4a.40.${aot}`, sampleRate: ADTS_RATES[idx], numberOfChannels: channels, description: asc }, header: (d[1] & 1) === 1 ? 7 : 9 };
}

async function wcAudioConfig(L: LibAV, s: any, codec: string, peek?: () => Promise<Uint8Array | null>): Promise<{ cfg: AudioDecoderConfig; adts?: boolean } | null> {
  if (typeof AudioDecoder === 'undefined' || !WC_AUDIO.has(codec)) return null;
  try {
    let cfg = await audioStreamToConfig(L, s);
    let adts = false;
    if (codec === 'aac' && (!cfg || !cfg.sampleRate || !cfg.numberOfChannels)) {
      const parsed = adtsConfig(peek ? await peek() : null);
      if (!parsed) return null;
      cfg = parsed.cfg;
      adts = true;
    }
    if (!cfg || cfg.codec === 'unknown') return null;
    const r = await AudioDecoder.isConfigSupported(cfg);
    return r.supported ? { cfg: r.config ?? cfg, adts } : null;
  } catch {
    return null;
  }
}

interface VPath { s: any; c: number; pkt: number; frame: number; tb: number; stream: SoftStream; wc?: VideoDecoderConfig }
interface APath { s: any; c: number; pkt: number; frame: number; tb: number; fmt: number; channels: number; stream: SoftStream; wc?: AudioDecoderConfig; adts?: boolean }

/** Read ahead until one packet of the given stream turns up (the pump seeks back to the start afterwards). */
async function peekPacket(L: LibAV, fmt: number, pkt: number, index: number): Promise<Uint8Array | null> {
  for (let i = 0; i < 8; i++) {
    const [res, packets] = await L.ff_read_frame_multi(fmt, pkt, { limit: 256 * 1024 });
    const list = packets[index];
    if (list?.length) return list[0].data;
    if (res === L.AVERROR_EOF) break;
  }
  return null;
}

/** Presentation time of a packet in seconds, falling back to the decode time when the container has none (AVI). */
function pktTime(p: any, tb: number): number | null {
  return tsOf(p.pts, p.ptshi, tb) ?? tsOf(p.dts, p.dtshi, tb);
}

/** Is this video packet a key frame? Containers usually say so; transport streams and AVI often don't, so look at the NAL units. */
function isKeyPacket(codec: string, p: any): boolean {
  if (((p.flags ?? 0) & 1) === 1) return true;
  const d: Uint8Array = p.data;
  if (codec !== 'h264' && codec !== 'hevc') return false;
  const isKeyNal = (b: number) => (codec === 'h264' ? (b & 0x1f) === 5 || (b & 0x1f) === 7 : ((b >> 1) & 0x3f) >= 16 && ((b >> 1) & 0x3f) <= 21) || (codec === 'hevc' && ((b >> 1) & 0x3f) === 32);
  const limit = Math.min(d.length - 4, 4096);
  if (startsWithStartCode(d)) {
    for (let i = 0; i < limit; i++) if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1 && isKeyNal(d[i + 3])) return true;
    return false;
  }
  // length-prefixed (MP4 style) NAL units, 4-byte lengths
  for (let pos = 0; pos + 5 < d.length && pos < limit; ) {
    const len = ((d[pos] << 24) | (d[pos + 1] << 16) | (d[pos + 2] << 8) | d[pos + 3]) >>> 0;
    if (isKeyNal(d[pos + 4])) return true;
    if (len === 0) break;
    pos += 4 + len;
  }
  return false;
}

/** Audio decoder for one stream: the browser's if it has one, else the built-in WebAssembly decoder, else null. */
async function makeAudioPath(L: LibAV, s: any, stream: SoftStream, peek?: () => Promise<Uint8Array | null>): Promise<APath | null> {
  const base = { s, tb: s.time_base_num / s.time_base_den, fmt: -1, channels: stream.channels ?? 2, stream };
  const wc = await wcAudioConfig(L, s, stream.codec, peek);
  if (wc) {
    stream.via = 'browser';
    stream.decodable = true;
    stream.sampleRate ||= wc.cfg.sampleRate;
    stream.channels = wc.cfg.numberOfChannels;
    return { ...base, channels: wc.cfg.numberOfChannels, c: 0, pkt: 0, frame: 0, wc: wc.cfg, adts: wc.adts };
  }
  try {
    const [, c, pkt, frame] = await L.ff_init_decoder(s.codec_id, { codecpar: s.codecpar, time_base: [s.time_base_num, s.time_base_den] });
    stream.via = 'builtin';
    stream.decodable = true;
    return { ...base, c, pkt, frame };
  } catch {
    return null;
  }
}

const BASE = `${(import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'}vendor/libav`.replace(/\/{2,}/g, '/');
const TWO32 = 4294967296;
const NOPTS_HI = -2147483648;
/** Seconds of decoded audio kept scheduled ahead of the playhead. */
const AUDIO_AHEAD = 1.4;
/** Seconds between the moment a clock is (re)started and its first sample: gives the pump time to fill. */
const LEAD = 0.12;
const MAX_QUEUE_BYTES = 160 * 1024 * 1024;
const MAX_QUEUE_FRAMES = 32;
/** Hardware decoders hand out a limited pool of frames, so keep fewer waiting. */
const MAX_WC_FRAMES = 12;

export type SoftErrorCode = 'engine' | 'open' | 'no-decoder' | 'pixel-format';

export class SoftMediaError extends Error {
  constructor(
    public code: SoftErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'SoftMediaError';
  }
}

export interface SoftStream {
  index: number;
  kind: 'video' | 'audio';
  codec: string;
  width?: number;
  height?: number;
  /** Sample aspect ratio (pixel width / pixel height), 1 for square pixels. */
  sar?: number;
  channels?: number;
  sampleRate?: number;
  bitRate?: number;
  decodable: boolean;
  /** ISO language code and title from the container, if any. */
  lang?: string;
  title?: string;
  /** Who decodes this track: the browser (WebCodecs) or the built-in WebAssembly decoder. */
  via?: 'browser' | 'builtin';
}

export interface SoftInfo {
  duration: number;
  video?: SoftStream;
  audio?: SoftStream;
  /** Other audio tracks found in the file (the first one that can be decoded is played). */
  extraAudio: SoftStream[];
  /** Every audio track in the file, in container order. */
  audioStreams: SoftStream[];
}

export interface SoftOptions {
  video: boolean;
  audio: boolean;
  canvas?: HTMLCanvasElement;
  /** Follow this element's clock instead of running our own (sidecar mode). */
  clock?: HTMLVideoElement;
  /** Container stream index of the audio track to play (default: the first one that can be decoded). */
  audioStream?: number;
  /** Effects chain: sound goes gain -> chain.input ... chain.output -> speakers. */
  chain?: (ctx: AudioContext) => { input: AudioNode; output: AudioNode };
  onTime?: (t: number) => void;
  onEnded?: () => void;
  onError?: (e: unknown) => void;
  /** True while the pump cannot keep up (buffer ran dry). */
  onStall?: (stalled: boolean) => void;
  onStats?: (s: { frames: number; dropped: number }) => void;
}

interface Pending {
  t: number;
  img: VideoFrame | ImageData;
  bytes: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function tsOf(lo: number | undefined, hi: number | undefined, tb: number): number | null {
  if (lo === undefined) return null;
  const h = hi ?? 0;
  if (h === NOPTS_HI && lo === 0) return null;
  return ((lo >>> 0) + h * TWO32) * tb;
}

function splitInt64(v: number): [number, number] {
  const hi = Math.floor(v / TWO32);
  return [v - hi * TWO32, hi];
}

/** Downmix interleaved-by-plane float data to stereo (FFmpeg channel order: L R C LFE Ls Rs [Lb Rb]). */
function downmix(planes: Float32Array[]): Float32Array[] {
  const n = planes[0].length;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const c = planes.length;
  const g = c >= 6 ? 0.37 : c >= 3 ? 0.5 : 1;
  for (let i = 0; i < n; i++) {
    let l = planes[0][i];
    let r = planes[1][i];
    if (c >= 3) {
      const mid = planes[2][i] * 0.707;
      l += mid;
      r += mid;
    }
    if (c >= 6) {
      l += planes[4][i] * 0.707;
      r += planes[5][i] * 0.707;
    } else if (c === 4 || c === 5) {
      l += planes[c - 2][i] * 0.707;
      r += planes[c - 1][i] * 0.707;
    }
    if (c >= 8) {
      l += planes[6][i] * 0.707;
      r += planes[7][i] * 0.707;
    }
    L[i] = Math.max(-1, Math.min(1, l * g));
    R[i] = Math.max(-1, Math.min(1, r * g));
  }
  return [L, R];
}

export class SoftMedia {
  readonly info: SoftInfo;
  stats = { frames: 0, dropped: 0 };

  private libav: LibAV;
  private fmt: number;
  private pkt: number;
  private fileName: string;
  private startOffset = 0;
  private rawStreams: any[] = [];

  private v?: VPath;
  private a?: APath;
  private vdec: VideoDecoder | null = null;
  private adec: AudioDecoder | null = null;
  private lastPktT = 0;
  private needKey = true;
  private skippedDelta = 0;
  /** AVI and similar carry no presentation times: decoded frames then take the packets' times in order. */
  private ptsMissing = false;
  private pendingTs: number[] = [];

  private ctx: AudioContext;
  private gain: GainNode;
  private sources = new Set<AudioBufferSourceNode>();
  private base = { media: 0, ctx: 0 };
  private audioEnd = 0;
  private vq: Pending[] = [];
  private vqBytes = 0;
  private needFirst = true;
  private epoch = 0;
  private target = 0;
  private playing = false;
  private eof = false;
  private destroyed = false;
  private raf = 0;
  private timer = 0;
  private stalled = false;
  private canvas?: HTMLCanvasElement;
  private g2d?: CanvasRenderingContext2D | null;
  private lastTimeEmit = 0;
  private lastVideoT = 0;
  private clockEl?: HTMLVideoElement;
  private clockHandlers: Array<[string, () => void]> = [];

  private constructor(
    private opts: SoftOptions,
    init: {
      libav: LibAV;
      fmt: number;
      pkt: number;
      fileName: string;
      info: SoftInfo;
      v?: SoftMedia['v'];
      a?: SoftMedia['a'];
      startOffset: number;
      rawStreams: any[];
    },
  ) {
    this.libav = init.libav;
    this.fmt = init.fmt;
    this.pkt = init.pkt;
    this.fileName = init.fileName;
    this.info = init.info;
    this.v = init.v;
    this.a = init.a;
    this.startOffset = init.startOffset;
    this.rawStreams = init.rawStreams;
    this.canvas = opts.canvas;
    this.g2d = opts.canvas?.getContext('2d');
    const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
    this.ctx = new Ctx();
    this.gain = this.ctx.createGain();
    const chain = opts.chain?.(this.ctx);
    if (chain) {
      this.gain.connect(chain.input);
      chain.output.connect(this.ctx.destination);
    } else this.gain.connect(this.ctx.destination);
    void this.ctx.suspend();
    if (opts.canvas && init.v) {
      opts.canvas.width = init.v.stream.width || 640;
      opts.canvas.height = init.v.stream.height || 360;
    }
  }

  // ----------------------------------------------------------------- opening

  static async open(file: File, opts: SoftOptions): Promise<SoftMedia> {
    let libav: LibAV;
    try {
      const mod = await import(/* @vite-ignore */ `${BASE}/libav-lite.mjs`);
      libav = await mod.default.LibAV({ base: BASE, nothreads: true });
    } catch (e) {
      throw new SoftMediaError('engine', String((e as Error)?.message ?? e));
    }
    const fileName = `in_${Math.random().toString(36).slice(2)}`;
    try {
      await libav.mkreadaheadfile(fileName, file);
      let fmt: number;
      let streams: any[];
      try {
        [fmt, streams] = await libav.ff_init_demuxer_file(fileName);
      } catch (e) {
        throw new SoftMediaError('open', String((e as Error)?.message ?? e));
      }
      const pkt = await libav.av_packet_alloc();

      const startLo = await libav.AVFormatContext_start_time(fmt);
      const startHi = await libav.AVFormatContext_start_timehi?.(fmt);
      const startOffset = tsOf(startLo, startHi, 1 / 1_000_000) ?? 0;

      let duration = 0;
      const describe = async (s: any, kind: 'video' | 'audio'): Promise<SoftStream> => {
        const codec = await libav.avcodec_get_name(s.codec_id);
        const out: SoftStream = { index: s.index, kind, codec, decodable: false };
        if (s.duration > duration && Number.isFinite(s.duration)) duration = s.duration;
        if (kind === 'video') {
          out.width = await libav.AVCodecParameters_width(s.codecpar);
          out.height = await libav.AVCodecParameters_height(s.codecpar);
          const n = await libav.AVCodecParameters_sample_aspect_ratio_num?.(s.codecpar);
          const d = await libav.AVCodecParameters_sample_aspect_ratio_den?.(s.codecpar);
          out.sar = n && d ? n / d : 1;
        } else {
          out.sampleRate = await libav.AVCodecParameters_sample_rate(s.codecpar);
          out.channels =
            (await libav.AVCodecParameters_ch_layout_nb_channels?.(s.codecpar)) || (await libav.AVCodecParameters_channels?.(s.codecpar)) || 2;
        }
        out.bitRate = (await libav.AVCodecParameters_bit_rate(s.codecpar)) || undefined;
        out.lang = s.metadata?.language && s.metadata.language !== 'und' ? s.metadata.language : undefined;
        out.title = s.metadata?.title || undefined;
        return out;
      };

      let v: SoftMedia['v'];
      let a: SoftMedia['a'];
      let video: SoftStream | undefined;
      let audio: SoftStream | undefined;
      const extraAudio: SoftStream[] = [];
      const audioStreams: SoftStream[] = [];
      for (const s of streams) {
        const isV = s.codec_type === libav.AVMEDIA_TYPE_VIDEO;
        const isA = s.codec_type === libav.AVMEDIA_TYPE_AUDIO;
        if (!isV && !isA) continue;
        const stream = await describe(s, isV ? 'video' : 'audio');
        if (isV && !video) {
          video = stream;
          if (opts.video) {
            const wc = await wcVideoConfig(libav, s, stream.codec);
            if (wc) {
              stream.decodable = true;
              stream.via = 'browser';
              v = { s, c: 0, pkt: 0, frame: 0, tb: s.time_base_num / s.time_base_den, stream, wc };
            } else {
              try {
                const [, c, dpkt, frame] = await libav.ff_init_decoder(s.codec_id, { codecpar: s.codecpar, time_base: [s.time_base_num, s.time_base_den] });
                stream.decodable = true;
                stream.via = 'builtin';
                v = { s, c, pkt: dpkt, frame, tb: s.time_base_num / s.time_base_den, stream };
              } catch {
                /* reported below */
              }
            }
          }
        } else if (isA) {
          audioStreams.push(stream);
          // The requested track wins; otherwise the first one that has a decoder.
          const wanted = opts.audioStream === undefined || opts.audioStream === s.index;
          if (opts.audio && !audio && wanted) {
            const path = await makeAudioPath(libav, s, stream, () => peekPacket(libav, fmt, pkt, s.index));
            if (path) {
              audio = stream;
              a = path;
              continue;
            }
          }
          extraAudio.push(stream);
        }
      }
      if (opts.video && video && !v && !(opts.audio && a)) {
        throw new SoftMediaError('no-decoder', video.codec);
      }
      if (opts.audio && !opts.video && !a) {
        throw new SoftMediaError('no-decoder', extraAudio[0]?.codec ?? 'audio');
      }
      const mFmt = await libav.AVFormatContext_duration(fmt);
      const mFmtHi = await libav.AVFormatContext_durationhi?.(fmt);
      const fmtDur = tsOf(mFmt, mFmtHi, 1 / 1_000_000);
      if (fmtDur && fmtDur > 0 && Number.isFinite(fmtDur)) duration = Math.max(duration, fmtDur);

      const info: SoftInfo = { duration, video, audio, extraAudio, audioStreams };
      const media = new SoftMedia(opts, { libav, fmt, pkt, fileName, info, v, a, startOffset, rawStreams: streams });
      media.begin();
      return media;
    } catch (e) {
      try {
        libav.terminate?.();
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  // ----------------------------------------------------------------- control

  /** Current media position in seconds. */
  time(): number {
    if (this.clockEl) return this.clockEl.currentTime;
    const latency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return Math.max(0, this.base.media + (this.ctx.currentTime - this.base.ctx) - latency);
  }

  get isPlaying() {
    return this.playing;
  }

  get hasAudio() {
    return !!this.a;
  }

  async play() {
    if (this.destroyed) return;
    if (this.clockEl) return; // the <video> element drives playback
    if (this.eof && this.queueEmpty() && this.time() >= this.info.duration - 0.1) await this.seek(0);
    this.playing = true;
    await this.ctx.resume();
  }

  async pause() {
    this.playing = false;
    if (this.clockEl) return;
    await this.ctx.suspend();
  }

  async seek(t: number) {
    if (this.destroyed) return;
    const d = this.info.duration;
    const to = Math.max(0, d > 0 ? Math.min(t, Math.max(0, d - 0.05)) : t);
    this.restart(to);
  }

  setVolume(v: number) {
    this.gain.gain.value = Math.max(0, Math.min(2, v)); // up to 200%
  }

  /** Sidecar mode: follow a native <video> element. */
  followClock(el: HTMLVideoElement) {
    clearInterval(this.timer); // the position ticker of standalone audio isn't needed here
    this.clockEl = el;
    const on = (type: string, fn: () => void) => {
      el.addEventListener(type, fn);
      this.clockHandlers.push([type, fn]);
    };
    const resync = () => {
      if (el.paused || el.ended || el.playbackRate !== 1 || el.readyState < 3) {
        void this.ctx.suspend();
        return;
      }
      this.restart(el.currentTime + LEAD * 2);
      void this.ctx.resume();
    };
    on('playing', resync);
    on('seeked', resync);
    on('ratechange', resync);
    on('pause', () => void this.ctx.suspend());
    on('waiting', () => void this.ctx.suspend());
    on('ended', () => void this.ctx.suspend());
    this.timer = window.setInterval(() => {
      if (el.paused || el.playbackRate !== 1 || this.ctx.state !== 'running') return;
      const expected = this.base.media + (this.ctx.currentTime - this.base.ctx);
      if (Math.abs(expected - el.currentTime) > 0.15) resync();
    }, 1000);
    if (!el.paused) resync();
  }

  /** Switch to another audio track (container stream index). Returns false if it can't be decoded. */
  async selectAudio(index: number): Promise<boolean> {
    const raw = this.rawStreams.find((x) => x.index === index);
    const info = this.info.audioStreams.find((x) => x.index === index);
    if (!raw || !info || this.a?.s.index === index) return !!raw && !!info;
    const L = this.libav;
    const path = await makeAudioPath(L, raw, info, () => peekPacket(L, this.fmt, this.pkt, raw.index));
    if (!path) return false;
    const at = this.time();
    this.epoch++; // stop the pump before the old decoder goes away
    this.closeAudioDecoder();
    if (this.a && !this.a.wc) await L.ff_free_decoder(this.a.c, this.a.pkt, this.a.frame).catch(() => undefined);
    this.a = path;
    this.info.audio = info;
    this.restart(at);
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.epoch++;
    cancelAnimationFrame(this.raf);
    clearInterval(this.timer);
    for (const [t, fn] of this.clockHandlers) this.clockEl?.removeEventListener(t, fn);
    this.stopSources();
    this.clearQueue();
    void this.ctx.close().catch(() => undefined);
    this.closeVideoDecoder();
    this.closeAudioDecoder();
    const L = this.libav;
    void (async () => {
      try {
        if (this.v && !this.v.wc) await L.ff_free_decoder(this.v.c, this.v.pkt, this.v.frame);
        if (this.a && !this.a.wc) await L.ff_free_decoder(this.a.c, this.a.pkt, this.a.frame);
        await L.unlinkreadaheadfile(this.fileName);
      } catch {
        /* ignore */
      }
      try {
        L.terminate?.();
      } catch {
        /* ignore */
      }
    })();
  }

  // ---------------------------------------------------------------- internals

  private begin() {
    this.restart(0);
    if (this.canvas) {
      const tick = () => {
        this.raf = requestAnimationFrame(tick);
        this.present();
      };
      this.raf = requestAnimationFrame(tick);
    } else if (!this.clockEl) {
      // Audio only: no frames to show, but the position still has to be reported.
      this.timer = window.setInterval(() => this.present(), 200);
    }
  }

  private queueEmpty() {
    return this.vq.length === 0 && this.audioEnd <= this.time() + 0.02;
  }

  private stopSources() {
    for (const s of this.sources) {
      try {
        s.onended = null;
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
  }

  private clearQueue() {
    for (const p of this.vq) (p.img as VideoFrame).close?.();
    this.vq = [];
    this.vqBytes = 0;
  }

  private restart(to: number) {
    this.epoch++;
    this.stopSources();
    this.clearQueue();
    this.target = to;
    this.eof = false;
    this.needFirst = true;
    this.audioEnd = to;
    // Media time `to` is heard `delay` seconds from now: our own clock starts after a short lead so the
    // pump can fill the buffers; a followed <video> keeps playing, so we aim for where it will be.
    const delay = this.clockEl ? Math.max(0, to - this.clockEl.currentTime) : LEAD;
    this.base = { media: to, ctx: this.ctx.currentTime + delay };
    void this.pump(this.epoch).catch((e) => {
      if (!this.destroyed) this.opts.onError?.(e);
    });
  }

  /** True when both streams are comfortably buffered (an absent stream counts as full). */
  private enough() {
    const audioFull = !this.a || this.audioEnd - this.time() > AUDIO_AHEAD;
    const videoFull = !this.v || this.vq.length >= (this.v.wc ? MAX_WC_FRAMES : MAX_QUEUE_FRAMES) || this.vqBytes > MAX_QUEUE_BYTES;
    return audioFull && videoFull;
  }

  private async pump(epoch: number) {
    const L = this.libav;
    const alive = () => epoch === this.epoch && !this.destroyed;
    // Seek to the keyframe at or before the target (stream -1 = AV_TIME_BASE units).
    const seekTo = (this.target + this.startOffset) * 1_000_000;
    const [lo, hi] = splitInt64(Math.max(0, Math.round(seekTo)));
    // The very start is a byte seek: streams with one key frame (transport streams) must begin exactly there.
    let seeked = -1;
    if (this.target < 0.001) seeked = await L.av_seek_frame(this.fmt, -1, 0, 0, L.AVSEEK_FLAG_BYTE).catch(() => -1);
    if (seeked < 0) await L.avformat_seek_file_max(this.fmt, -1, lo, hi, 0).catch(() => -1);
    if (this.v) {
      if (this.v.wc) this.resetVideoDecoder(epoch);
      else await L.avcodec_flush_buffers(this.v.c);
    }
    if (this.a) {
      if (this.a.wc) this.resetAudioDecoder(epoch);
      else await L.avcodec_flush_buffers(this.a.c);
    }
    if (!alive()) return;

    while (alive()) {
      if (this.eof || this.enough()) {
        await sleep(this.eof ? 80 : 25);
        this.checkEnded();
        continue;
      }
      const [res, packets] = await L.ff_read_frame_multi(this.fmt, this.pkt, { limit: 192 * 1024 });
      if (!alive()) return;
      for (const [idx, list] of Object.entries(packets as Record<string, any[]>)) {
        const i = Number(idx);
        if (this.v && i === this.v.s.index) await this.decodeVideo(list, false, epoch);
        else if (this.a && i === this.a.s.index) await this.decodeAudio(list, false, epoch);
        if (!alive()) return;
      }
      if (res === L.AVERROR_EOF || (res !== 0 && res !== -L.EAGAIN)) {
        if (this.v) await this.decodeVideo([], true, epoch);
        if (this.a) await this.decodeAudio([], true, epoch);
        this.eof = true;
      }
    }
  }

  private checkEnded() {
    if (this.eof && this.playing && !this.clockEl && this.queueEmpty() && this.time() >= this.info.duration - 0.25) {
      this.playing = false;
      void this.ctx.suspend();
      this.opts.onEnded?.();
    }
  }

  // -------------------------------------------------------------------- video

  private async decodeVideo(packets: any[], fin: boolean, epoch: number) {
    if (this.v!.wc) return this.decodeVideoWc(packets, fin, epoch);
    const v = this.v!;
    const L = this.libav;
    const frames: any[] = await L.ff_decode_multi(v.c, v.pkt, v.frame, packets, { ignoreErrors: true, fin, copyoutFrame: 'video' });
    if (epoch !== this.epoch) return;
    for (const f of frames) {
      const t0 = tsOf(f.best_effort_timestamp ?? f.pts, f.best_effort_timestamphi ?? f.ptshi, v.tb);
      const t = t0 === null ? this.lastVideoT + 0.04 : t0 - this.startOffset;
      this.lastVideoT = t;
      if (t < this.target - 0.001) continue; // catching up after a seek
      const img = this.toImage(f, t);
      if (!img) continue;
      const bytes = f.data?.byteLength ?? 0;
      this.vq.push({ t, img, bytes });
      this.vqBytes += bytes;
      this.stats.frames++;
    }
  }

  private toImage(f: any, t: number): VideoFrame | ImageData | null {
    const L = this.libav;
    const fmt: number = f.format;
    const map: Array<[string | undefined, string]> = [
      ['AV_PIX_FMT_YUV420P', 'I420'],
      ['AV_PIX_FMT_YUVJ420P', 'I420'],
      ['AV_PIX_FMT_YUV422P', 'I422'],
      ['AV_PIX_FMT_YUVJ422P', 'I422'],
      ['AV_PIX_FMT_YUV444P', 'I444'],
      ['AV_PIX_FMT_YUVJ444P', 'I444'],
      ['AV_PIX_FMT_YUV420P10LE', 'I420P10'],
      ['AV_PIX_FMT_YUV422P10LE', 'I422P10'],
      ['AV_PIX_FMT_YUV444P10LE', 'I444P10'],
    ];
    const hit = map.find(([k]) => k && L[k] === fmt);
    if (!hit) {
      throw new SoftMediaError('pixel-format', String(fmt));
    }
    const format = hit[1];
    if (typeof VideoFrame !== 'undefined') {
      try {
        return new VideoFrame(f.data, {
          format: format as VideoPixelFormat,
          codedWidth: f.width,
          codedHeight: f.height,
          timestamp: Math.round(t * 1e6),
          layout: f.layout,
        });
      } catch {
        /* fall through to the CPU conversion */
      }
    }
    return format === 'I420' ? this.i420ToImageData(f) : null;
  }

  /** Fallback for browsers without WebCodecs VideoFrame: BT.601 limited-range YUV 4:2:0 to RGBA. */
  private i420ToImageData(f: any): ImageData {
    const w: number = f.width;
    const h: number = f.height;
    const out = new ImageData(w, h);
    const d = out.data;
    const [py, pu, pv] = f.layout as Array<{ offset: number; stride: number }>;
    const src: Uint8Array = f.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const Y = (src[py.offset + y * py.stride + x] - 16) * 1.164;
        const U = src[pu.offset + (y >> 1) * pu.stride + (x >> 1)] - 128;
        const V = src[pv.offset + (y >> 1) * pv.stride + (x >> 1)] - 128;
        const o = (y * w + x) * 4;
        d[o] = Y + 1.596 * V;
        d[o + 1] = Y - 0.392 * U - 0.813 * V;
        d[o + 2] = Y + 2.017 * U;
        d[o + 3] = 255;
      }
    }
    return out;
  }

  private present() {
    const now = this.time();
    let pick = -1;
    for (let i = 0; i < this.vq.length; i++) {
      if (this.vq[i].t <= now + 0.015) pick = i;
      else break;
    }
    if (pick < 0 && this.needFirst && this.vq.length) pick = 0;
    if (pick >= 0) {
      const frame = this.vq[pick];
      this.draw(frame.img);
      this.needFirst = false;
      const gone = this.vq.splice(0, pick + 1);
      for (const g of gone) {
        (g.img as VideoFrame).close?.();
        this.vqBytes -= g.bytes;
      }
      if (pick > 0) {
        this.stats.dropped += pick;
        this.opts.onStats?.({ ...this.stats });
      }
    }
    // Stall detection: playing, but nothing decoded in time.
    if (this.playing && !this.eof) {
      const stalled = this.vq.length === 0 && (!this.a || this.audioEnd < now + 0.05);
      if (stalled !== this.stalled) {
        this.stalled = stalled;
        this.opts.onStall?.(stalled);
      }
    }
    const nowMs = performance.now();
    if (nowMs - this.lastTimeEmit > 200) {
      this.lastTimeEmit = nowMs;
      this.opts.onTime?.(now);
    }
  }

  private draw(img: VideoFrame | ImageData) {
    const g = this.g2d;
    const c = this.canvas;
    if (!g || !c) return;
    const w = 'displayWidth' in img ? img.displayWidth : img.width;
    const h = 'displayHeight' in img ? img.displayHeight : img.height;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    if ('close' in img) g.drawImage(img as VideoFrame, 0, 0);
    else g.putImageData(img, 0, 0);
  }

  // -------------------------------------------------------------------- audio

  private async decodeAudio(packets: any[], fin: boolean, epoch: number) {
    if (this.a!.wc) return this.decodeAudioWc(packets, fin, epoch);
    const a = this.a!;
    const L = this.libav;
    const frames: any[] = await L.ff_decode_multi(a.c, a.pkt, a.frame, packets, { ignoreErrors: true, fin });
    if (epoch !== this.epoch) return;
    for (const f of frames) this.scheduleAudio(f);
  }

  private planes(f: any): Float32Array[] {
    const L = this.libav;
    const fmt: number = f.format;
    const planar = Array.isArray(f.data);
    const ch = planar ? f.data.length : f.channels || this.a!.channels;
    const conv = (src: ArrayLike<number>, n: number, stride: number, off: number): Float32Array => {
      const out = new Float32Array(n);
      if (fmt === L.AV_SAMPLE_FMT_FLT || fmt === L.AV_SAMPLE_FMT_FLTP || fmt === L.AV_SAMPLE_FMT_DBL || fmt === L.AV_SAMPLE_FMT_DBLP) {
        for (let i = 0; i < n; i++) out[i] = src[i * stride + off];
      } else if (fmt === L.AV_SAMPLE_FMT_S16 || fmt === L.AV_SAMPLE_FMT_S16P) {
        for (let i = 0; i < n; i++) out[i] = src[i * stride + off] / 32768;
      } else if (fmt === L.AV_SAMPLE_FMT_S32 || fmt === L.AV_SAMPLE_FMT_S32P) {
        for (let i = 0; i < n; i++) out[i] = src[i * stride + off] / 2147483648;
      } else if (fmt === L.AV_SAMPLE_FMT_U8 || fmt === L.AV_SAMPLE_FMT_U8P) {
        for (let i = 0; i < n; i++) out[i] = (src[i * stride + off] - 128) / 128;
      } else {
        throw new SoftMediaError('no-decoder', `sample format ${fmt}`);
      }
      return out;
    };
    if (planar) {
      const n = f.nb_samples ?? f.data[0].length;
      return f.data.map((p: ArrayLike<number>) => conv(p, n, 1, 0));
    }
    const n = f.nb_samples ?? Math.floor(f.data.length / ch);
    return Array.from({ length: ch }, (_, c) => conv(f.data, n, ch, c));
  }

  private scheduleAudio(f: any) {
    const a = this.a!;
    const rate: number = f.sample_rate || a.stream.sampleRate || 48000;
    const t0raw = tsOf(f.pts, f.ptshi, a.tb);
    this.scheduleAudioPlanes(this.planes(f), rate, t0raw === null ? null : t0raw - this.startOffset);
  }

  /** Queue decoded sound (one Float32Array per channel) to start at media time t0 (null = right after the previous block). */
  private scheduleAudioPlanes(input: Float32Array[], rate: number, t0in: number | null) {
    let planes = input;
    if (!planes.length || !planes[0].length) return;
    if (planes.length > 2) planes = downmix(planes);
    let t0 = t0in === null ? this.audioEnd : t0in;
    const n = planes[0].length;
    const dur = n / rate;
    if (t0 + dur <= this.target) return; // entirely before the seek target
    let skip = 0;
    if (t0 < this.target) {
      skip = Math.min(n - 1, Math.round((this.target - t0) * rate));
      t0 = this.target;
    }
    const len = n - skip;
    const buf = this.ctx.createBuffer(planes.length, len, rate);
    for (let c = 0; c < planes.length; c++) buf.copyToChannel((skip ? planes[c].subarray(skip) : planes[c]) as Float32Array<ArrayBuffer>, c);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    const now = this.ctx.currentTime;
    const when = this.base.ctx + (t0 - this.base.media);
    const end = when + len / rate;
    if (end <= now) return; // too late to be heard
    if (when >= now) src.start(when);
    else src.start(now, now - when);
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
    this.audioEnd = t0 + len / rate;
  }

  // ------------------------------------------------- decoding by the browser (WebCodecs)

  private closeVideoDecoder() {
    try {
      this.vdec?.close();
    } catch {
      /* already closed */
    }
    this.vdec = null;
  }

  private closeAudioDecoder() {
    try {
      this.adec?.close();
    } catch {
      /* already closed */
    }
    this.adec = null;
  }

  /** A fresh decoder after every seek (the demuxer restarts at a key frame, so there is no state to keep). */
  private resetVideoDecoder(epoch: number) {
    this.closeVideoDecoder();
    const cfg = this.v?.wc;
    if (!cfg) return;
    this.needKey = true;
    this.skippedDelta = 0;
    this.pendingTs = [];
    const dec = new VideoDecoder({
      output: (f) => this.onWcVideo(f, epoch),
      error: (e) => {
        if (epoch === this.epoch && !this.destroyed) this.opts.onError?.(new SoftMediaError('no-decoder', `${this.v?.stream.codec} (${e.message})`));
      },
    });
    dec.configure(cfg);
    this.vdec = dec;
  }

  private resetAudioDecoder(epoch: number) {
    this.closeAudioDecoder();
    const cfg = this.a?.wc;
    if (!cfg) return;
    const dec = new AudioDecoder({
      output: (d) => this.onWcAudio(d, epoch),
      error: () => undefined, // a damaged frame: skip it, the next ones decode fine
    });
    dec.configure(cfg);
    this.adec = dec;
  }

  private onWcVideo(f: VideoFrame, epoch: number) {
    const t = (this.ptsMissing && this.pendingTs.length ? this.pendingTs.shift()! : f.timestamp / 1e6) - this.startOffset;
    if (epoch !== this.epoch || this.destroyed || t < this.target - 0.001) {
      f.close(); // stale, or catching up after a seek
      return;
    }
    const bytes = f.codedWidth * f.codedHeight * 1.5;
    this.vq.push({ t, img: f, bytes });
    this.vqBytes += bytes;
    this.stats.frames++;
  }

  private onWcAudio(d: AudioData, epoch: number) {
    if (epoch === this.epoch && !this.destroyed) {
      const planes: Float32Array[] = [];
      for (let c = 0; c < d.numberOfChannels; c++) {
        const p = new Float32Array(d.numberOfFrames);
        d.copyTo(p, { planeIndex: c, format: 'f32-planar' });
        planes.push(p);
      }
      this.scheduleAudioPlanes(planes, d.sampleRate, d.timestamp / 1e6 - this.startOffset);
    }
    d.close();
  }

  private async decodeVideoWc(packets: any[], fin: boolean, epoch: number) {
    const v = this.v!;
    const dec = this.vdec;
    if (!dec || dec.state !== 'configured') return;
    for (const p of packets) {
      if (epoch !== this.epoch) return;
      const key = isKeyPacket(v.stream.codec, p);
      // After a seek the first chunk must be a key frame; some streams never flag them, so give up waiting eventually.
      if (this.needKey && !key && this.skippedDelta++ < 120) continue;
      this.needKey = false;
      // Hardware decoders hold a limited pool of frames: keep the ones waiting to be shown plus the ones still decoding bounded.
      while (epoch === this.epoch && !this.destroyed && this.vq.length + dec.decodeQueueSize > MAX_WC_FRAMES + 12) await sleep(8);
      if (epoch !== this.epoch) return;
      let sec = pktTime(p, v.tb);
      if (tsOf(p.pts, p.ptshi, v.tb) === null) this.ptsMissing = true;
      if (sec === null) sec = this.lastPktT + 0.04;
      this.lastPktT = sec;
      if (this.ptsMissing) this.pendingTs.splice(this.pendingTs.findIndex((x) => x > sec!) < 0 ? this.pendingTs.length : this.pendingTs.findIndex((x) => x > sec!), 0, sec);
      try {
        dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: Math.round(sec * 1e6), data: p.data }));
      } catch {
        return; // decoder was closed by an error or a newer seek
      }
    }
    if (fin) await dec.flush().catch(() => undefined);
  }

  private async decodeAudioWc(packets: any[], fin: boolean, epoch: number) {
    const a = this.a!;
    const dec = this.adec;
    if (!dec || dec.state !== 'configured') return;
    for (const p of packets) {
      if (epoch !== this.epoch) return;
      const t = pktTime(p, a.tb);
      const dur = tsOf(p.duration, p.durationhi, a.tb);
      let data: Uint8Array = p.data;
      if (a.adts && data.length > 7 && data[0] === 0xff && (data[1] & 0xf0) === 0xf0) data = data.subarray((data[1] & 1) === 1 ? 7 : 9); // raw AAC frames, the header lives in the config
      try {
        dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((t ?? this.audioEnd + this.startOffset) * 1e6), duration: dur ? Math.round(dur * 1e6) : undefined, data }));
      } catch {
        return;
      }
    }
    if (fin) await dec.flush().catch(() => undefined);
  }
}
