/**
 * One player API over the ways of playing something, picked per source:
 *
 *  native        the browser plays it in a <video> element (MP4, WebM, most MKV, audio, direct URLs, HLS, DASH)
 *  native+sound  the browser plays the picture, the built-in engine decodes the sound
 *                (AC-3, DTS, WMA …, or another audio track), kept in sync with the element
 *  builtin       FFmpeg compiled to WebAssembly decodes everything (AVI, WMV, FLV, MPEG, TS …),
 *                frames go to a canvas, sound to Web Audio
 */
import { SoftMedia, SoftMediaError, type SoftInfo } from './softmedia';
import { FxChain, loadFx, saveFx, type FxSettings } from './fx';
import { browserCanDecodeAudio, probeFile, type Chapter, type ProbeResult, type TrackInfo } from './probe';

export type Engine = 'native' | 'native+sound' | 'builtin';

export interface Source {
  file?: File;
  url?: string;
}

export interface LoadInfo {
  engine: Engine;
  duration: number;
  /** Live streams have no duration. */
  live: boolean;
  hasVideo: boolean;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
  /** Why this engine was chosen, shown in the info dialog. */
  reason: string;
  /** How a network source is delivered. */
  stream?: 'direct' | 'hls' | 'dash';
}

export interface AudioChoice {
  id: number;
  label: string;
  current: boolean;
}

export interface Quality {
  id: number; // -1 = automatic
  label: string;
  current: boolean;
}

export interface PlayerEvents {
  time: (t: number) => void;
  state: (playing: boolean) => void;
  ended: () => void;
  buffering: (on: boolean) => void;
  error: (message: string) => void;
  /** Something worth telling the user (e.g. the built-in sound decoder took over). */
  notice: (message: string) => void;
  /** Track list, chapters or the active audio track changed. */
  tracks: () => void;
}

/** Containers no browser opens; these go straight to the built-in engine. */
const BUILTIN_EXT = new Set(['avi', 'wmv', 'asf', 'flv', 'mpg', 'mpeg', 'mpe', 'vob', 'm2ts', 'm2t', 'mts', 'ts', 'mpegts', 'wma']);
/** Pure audio containers: no subtitles or chapters worth probing. */
const NO_PROBE_EXT = new Set(['mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'aac', 'weba']);

async function sniffBuiltinOnly(file: File): Promise<string | null> {
  const b = new Uint8Array(await file.slice(0, 600).arrayBuffer());
  const s = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'AVI ') return 'AVI';
  if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return 'Windows Media';
  if (s(0, 3) === 'FLV') return 'Flash video';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0xba) return 'MPEG program stream';
  if (b.length >= 565 && b[0] === 0x47 && b[188] === 0x47 && b[376] === 0x47) return 'MPEG transport stream';
  if (b.length >= 585 && b[4] === 0x47 && b[196] === 0x47 && b[388] === 0x47) return 'MPEG transport stream';
  return null;
}

const ext = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';
const langName = (code?: string) => {
  if (!code) return '';
  try {
    return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
};

export class Player {
  readonly video: HTMLVideoElement;
  readonly canvas: HTMLCanvasElement;
  engine: Engine = 'native';
  info: LoadInfo | null = null;
  probe: ProbeResult | null = null;
  fx: FxSettings = loadFx();

  private soft: SoftMedia | null = null;
  private sound: SoftMedia | null = null;
  private source: Source = {};
  private url: string | null = null;
  private loadToken = 0;
  private ticker = 0;
  private _volume = 1;
  private _muted = false;
  private _rate = 1;
  private audioPick: number | null = null;
  private hls: import('hls.js').default | null = null;
  private dash: import('dashjs').MediaPlayerClass | null = null;
  private chains = new Set<FxChain>();
  private softChain: FxChain | null = null;
  private soundChain: FxChain | null = null;
  private graph?: { ctx: AudioContext; chain: FxChain };

  constructor(
    stage: HTMLElement,
    private ev: PlayerEvents,
  ) {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.video.className = 'surface';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'surface';
    this.canvas.hidden = true;
    stage.prepend(this.canvas, this.video);

    const v = this.video;
    v.addEventListener('play', () => this.ev.state(true));
    v.addEventListener('pause', () => this.ev.state(false));
    v.addEventListener('ended', () => {
      this.ev.state(false);
      this.ev.ended();
    });
    v.addEventListener('waiting', () => this.ev.buffering(true));
    v.addEventListener('playing', () => this.ev.buffering(false));
    v.addEventListener('error', () => {
      // Handled during load(); later errors (decode failures mid-file) are reported.
      if (this.info) this.ev.error('The browser stopped playing this file.');
    });
    this.ticker = window.setInterval(() => {
      if (this.engine !== 'builtin' && !v.paused) this.ev.time(v.currentTime);
    }, 250);
  }

  // ---------------------------------------------------------------- loading

  async load(src: Source, startAt = 0): Promise<LoadInfo> {
    const token = ++this.loadToken;
    this.unload();
    this.source = src;
    let info: LoadInfo;
    if (src.url) {
      info = await this.loadUrl(src.url);
    } else {
      const file = src.file!;
      const e = ext(file.name);
      const sniffed = await sniffBuiltinOnly(file);
      if (token !== this.loadToken) throw new Error('superseded');
      if (sniffed || BUILTIN_EXT.has(e)) {
        info = await this.loadBuiltin(file, sniffed ? `${sniffed} isn’t playable by browsers` : `.${e} isn’t playable by browsers`);
      } else {
        try {
          info = await this.loadNative(file);
        } catch {
          if (token !== this.loadToken) throw new Error('superseded');
          info = await this.loadBuiltin(file, 'the browser could not play this file');
        }
      }
    }
    if (token !== this.loadToken) {
      this.unload();
      throw new Error('superseded');
    }
    this.info = info;
    this.applyVolume();
    if (info.engine === 'native' && src.file) this.watchAudio(src.file);
    if (src.file && !NO_PROBE_EXT.has(ext(src.file.name))) this.scheduleProbe(src.file, token);
    if (startAt > 1 && !info.live) await this.seek(startAt);
    return info;
  }

  private loadNative(file: File): Promise<LoadInfo> {
    this.engine = 'native';
    this.showSurface('video');
    this.url = URL.createObjectURL(file);
    return this.waitForMetadata(this.url, 'the browser can play this file itself');
  }

  /** Point the <video> at a source and resolve once its size and duration are known. */
  private waitForMetadata(src: string | null, reason: string, stream: LoadInfo['stream'] = undefined, attach?: () => void): Promise<LoadInfo> {
    const v = this.video;
    return new Promise<LoadInfo>((resolve, reject) => {
      const timer = window.setTimeout(() => fail(), 20000);
      const done = () => {
        clearTimeout(timer);
        v.removeEventListener('loadedmetadata', ok);
        v.removeEventListener('error', fail);
      };
      const ok = () => {
        done();
        const hasVideo = v.videoWidth > 0;
        const live = !Number.isFinite(v.duration);
        resolve({
          engine: 'native',
          duration: live ? 0 : v.duration,
          live,
          hasVideo,
          width: v.videoWidth || undefined,
          height: v.videoHeight || undefined,
          reason,
          stream,
        });
      };
      const fail = () => {
        done();
        reject(new Error('native'));
      };
      v.addEventListener('loadedmetadata', ok);
      v.addEventListener('error', fail);
      if (src) v.src = src;
      attach?.();
    });
  }

  private async loadUrl(url: string): Promise<LoadInfo> {
    this.engine = 'native';
    this.showSurface('video');
    const v = this.video;
    const kind: 'hls' | 'dash' | 'direct' = /\.m3u8([?#]|$)/i.test(url) ? 'hls' : /\.mpd([?#]|$)/i.test(url) ? 'dash' : 'direct';
    const failMsg = (): Error => new Error(`The address could not be played. The server may be unreachable, or it doesn’t allow other websites to read it (CORS).`);
    try {
      if (kind === 'hls') {
        // hls.js everywhere MSE exists; browsers without it (iPhone) play HLS natively.
        const { default: Hls } = await import('hls.js');
        if (!Hls.isSupported()) {
          if (v.canPlayType('application/vnd.apple.mpegurl')) return await this.waitForMetadata(url, 'this browser plays HLS itself', 'hls');
          throw new Error('This browser can’t play HLS streams.');
        }
        const hls = new Hls({ enableWorker: true });
        this.hls = hls;
        return await this.waitForMetadata(null, 'HLS stream played with hls.js', 'hls', () => {
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal) v.dispatchEvent(new Event('error'));
          });
          hls.loadSource(url);
          hls.attachMedia(v);
        });
      }
      if (kind === 'dash') {
        const dashjs = await import('dashjs');
        const dash = dashjs.MediaPlayer().create();
        this.dash = dash;
        return await this.waitForMetadata(null, 'DASH stream played with dash.js', 'dash', () => {
          dash.on('error', () => v.dispatchEvent(new Event('error')));
          dash.initialize(v, url, false);
        });
      }
      return await this.waitForMetadata(url, 'direct network address', 'direct');
    } catch (e) {
      this.destroyStreams();
      if ((e as Error).message === 'native') throw failMsg();
      throw e;
    }
  }

  private async loadBuiltin(file: File, reason: string): Promise<LoadInfo> {
    this.releaseNative();
    this.engine = 'builtin';
    this.showSurface('canvas');
    try {
      this.soft = await SoftMedia.open(file, {
        video: true,
        audio: true,
        canvas: this.canvas,
        chain: (ctx) => this.makeChain(ctx, 'soft'),
        onTime: (t) => this.ev.time(t),
        onEnded: () => {
          this.ev.state(false);
          this.ev.ended();
        },
        onStall: (s) => this.ev.buffering(s),
        onError: (err) => this.ev.error(this.describe(err)),
      });
    } catch (err) {
      this.engine = 'native';
      throw new Error(this.describe(err));
    }
    const i: SoftInfo = this.soft.info;
    return {
      engine: 'builtin',
      duration: i.duration,
      live: false,
      hasVideo: !!i.video,
      width: i.video?.width,
      height: i.video?.height,
      videoCodec: i.video?.codec,
      audioCodec: i.audio?.codec,
      reason: `${reason}; opened by the built-in player (FFmpeg demuxer). Video: ${i.video?.via === 'browser' ? 'decoded by the browser' : 'built-in decoder'}${i.audio ? `, audio: ${i.audio.via === 'browser' ? 'decoded by the browser' : 'built-in decoder'}` : ''}`,
    };
  }

  private describe(err: unknown): string {
    if (err instanceof SoftMediaError) {
      if (err.code === 'no-decoder') {
        // H.264, HEVC, AAC … are decoded by the browser itself; if it can't, there is no fallback.
        if (/^(h264|hevc|vp8|vp9|av1|aac|opus|vorbis)\b/.test(err.message)) return `This browser can’t decode ${err.message.split(' ')[0].toUpperCase()} here. A recent Chrome, Edge or Safari usually can.`;
        return `The built-in player doesn’t include the codec this file uses (${err.message}).`;
      }
      if (err.code === 'pixel-format') return 'This video uses a colour format the built-in player can’t show yet.';
      if (err.code === 'engine') return 'The built-in player could not be loaded.';
      if (err.code === 'open') return 'This file could not be read. It may be damaged.';
    }
    return 'Playback failed because of an unexpected error.';
  }

  // ------------------------------------------------- sound the browser can't decode

  /** After the native element started playing: if the sound is silent, hand the audio track to the built-in engine. */
  private checkSilentAudio(file: File, token: number) {
    const v = this.video as HTMLVideoElement & { webkitAudioDecodedByteCount?: number };
    if (this.engine !== 'native' || v.webkitAudioDecodedByteCount === undefined) return;
    window.setTimeout(async () => {
      if (token !== this.loadToken || this.engine !== 'native' || v.paused || v.muted || v.webkitAudioDecodedByteCount !== 0) return;
      await this.startSidecar(file, token, undefined, true);
    }, 1600);
  }

  private watchAudio(file: File) {
    const token = this.loadToken;
    const onPlaying = () => {
      this.video.removeEventListener('playing', onPlaying);
      this.checkSilentAudio(file, token);
    };
    this.video.addEventListener('playing', onPlaying);
  }

  /** Decode an audio track with the built-in engine while the browser keeps playing the picture. */
  private async startSidecar(file: File, token: number, audioStream?: number, announce = false): Promise<boolean> {
    const v = this.video;
    try {
      const m = await SoftMedia.open(file, { video: false, audio: true, clock: v, audioStream, chain: (ctx) => this.makeChain(ctx, 'sound') });
      if (token !== this.loadToken) {
        m.destroy();
        return false;
      }
      this.stopSidecar();
      this.sound = m;
      this.soundChain = this.lastMade;
      this.engine = 'native+sound';
      this.audioPick = m.info.audio?.index ?? null;
      v.muted = true;
      m.followClock(v);
      this.applyVolume();
      if (this.info) this.info = { ...this.info, engine: 'native+sound', audioCodec: m.info.audio?.codec, reason: 'the browser plays the picture; the sound is decoded by the built-in player' };
      if (announce) this.ev.notice(`Sound is decoded by the built-in player (${m.info.audio?.codec ?? 'audio'}).`);
      this.ev.tracks();
      return true;
    } catch {
      return false; // no audio track, or a codec the built-in player doesn't have
    }
  }

  private stopSidecar() {
    this.sound?.destroy();
    this.sound = null;
    if (this.soundChain) this.chains.delete(this.soundChain);
    this.soundChain = null;
  }

  // ------------------------------------------------------------ probing / tracks

  private scheduleProbe(file: File, token: number) {
    window.setTimeout(async () => {
      if (token !== this.loadToken) return;
      try {
        const p = await probeFile(file);
        if (token !== this.loadToken) return;
        this.probe = p;
        this.ev.tracks();
        // Browsers without the silent-audio counter: decide from the codec instead.
        const v = this.video as HTMLVideoElement & { webkitAudioDecodedByteCount?: number };
        const first = p.tracks.find((t) => t.kind === 'audio');
        if (this.engine === 'native' && v.webkitAudioDecodedByteCount === undefined && first && !browserCanDecodeAudio(first.codec)) {
          await this.startSidecar(file, token, first.index, true);
        }
      } catch {
        /* the track list is a bonus; playback is unaffected */
      }
    }, 1200);
  }

  get chapters(): Chapter[] {
    return this.probe?.chapters ?? [];
  }

  get subtitleTracks(): TrackInfo[] {
    return this.probe?.tracks.filter((t) => t.kind === 'subtitle') ?? [];
  }

  get currentFile(): File | undefined {
    return this.source.file;
  }

  audioChoices(): AudioChoice[] {
    if (this.hls && this.hls.audioTracks.length > 1) {
      return this.hls.audioTracks.map((t, i) => ({ id: i, label: [t.name, langName(t.lang)].filter(Boolean).join(' · ') || `Track ${i + 1}`, current: this.hls!.audioTrack === i }));
    }
    const label = (t: { index: number; codec: string; lang?: string; title?: string; channels?: number }, n: number) => {
      const ch = t.channels ? (t.channels === 1 ? 'mono' : t.channels === 2 ? 'stereo' : t.channels === 6 ? '5.1' : t.channels === 8 ? '7.1' : `${t.channels} ch`) : '';
      return [t.title, langName(t.lang), t.codec.toUpperCase(), ch].filter(Boolean).join(' · ') || `Track ${n + 1}`;
    };
    if (this.engine === 'builtin' && this.soft) {
      const cur = this.soft.info.audio?.index;
      return this.soft.info.audioStreams.map((t, n) => ({ id: t.index, label: label(t, n), current: t.index === cur }));
    }
    const audio = this.probe?.tracks.filter((t) => t.kind === 'audio') ?? [];
    const cur = this.audioPick ?? audio[0]?.index;
    return audio.map((t, n) => ({ id: t.index, label: label(t, n), current: t.index === cur }));
  }

  async setAudioTrack(id: number) {
    if (this.hls && this.hls.audioTracks.length > 1) {
      this.hls.audioTrack = id;
      this.ev.tracks();
      return;
    }
    if (this.engine === 'builtin') {
      if (await this.soft?.selectAudio(id)) this.ev.tracks();
      else this.ev.notice('The built-in player can’t decode that track.');
      return;
    }
    const file = this.source.file;
    if (!file) return;
    const first = this.probe?.tracks.find((t) => t.kind === 'audio');
    // Back to the browser's own (default) track when it can decode it.
    if (first && id === first.index && browserCanDecodeAudio(first.codec)) {
      this.stopSidecar();
      this.engine = 'native';
      this.audioPick = null;
      this.video.muted = this._muted;
      this.applyVolume();
      if (this.info) this.info = { ...this.info, engine: 'native' };
      this.ev.tracks();
      return;
    }
    const t = this.video.currentTime;
    const ok = await this.startSidecar(file, this.loadToken, id);
    if (!ok) this.ev.notice('The built-in player can’t decode that track.');
    else void t;
  }

  // ---------------------------------------------------------- adaptive quality

  qualities(): Quality[] {
    if (this.hls && this.hls.levels.length > 1) {
      return [
        { id: -1, label: 'Auto', current: this.hls.autoLevelEnabled },
        ...this.hls.levels.map((l, i) => ({ id: i, label: l.height ? `${l.height}p` : `${Math.round(l.bitrate / 1000)} kbit/s`, current: !this.hls!.autoLevelEnabled && this.hls!.currentLevel === i })).reverse(),
      ];
    }
    return [];
  }

  setQuality(id: number) {
    if (this.hls) this.hls.currentLevel = id; // -1 = automatic
  }

  // ---------------------------------------------------------------- transport

  get playing(): boolean {
    return this.engine === 'builtin' ? !!this.soft?.isPlaying : !this.video.paused;
  }
  get time(): number {
    return this.engine === 'builtin' ? (this.soft?.time() ?? 0) : this.video.currentTime;
  }
  get duration(): number {
    return this.info?.duration ?? 0;
  }
  get canChangeRate(): boolean {
    return this.engine !== 'builtin' && !this.info?.live;
  }
  get canPip(): boolean {
    return this.engine !== 'builtin' && !!this.info?.hasVideo && 'requestPictureInPicture' in this.video;
  }
  /** Chromecast (Remote Playback API) or AirPlay (Safari). */
  get canCast(): boolean {
    const v = this.video as HTMLVideoElement & { webkitShowPlaybackTargetPicker?: () => void; remote?: unknown };
    return this.engine === 'native' && (!!v.remote || !!v.webkitShowPlaybackTargetPicker);
  }

  async cast() {
    const v = this.video as HTMLVideoElement & { webkitShowPlaybackTargetPicker?: () => void; remote?: { prompt: () => Promise<void> } };
    if (v.remote) await v.remote.prompt();
    else v.webkitShowPlaybackTargetPicker?.();
  }

  async play() {
    if (!this.info) return;
    if (this.graph) void this.graph.ctx.resume();
    if (this.engine === 'builtin') {
      // Without a prior click the browser keeps the audio context suspended and resume() never settles.
      const started = await Promise.race([this.soft!.play().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 500))]);
      if (!started) {
        void this.soft?.pause();
        this.ev.state(false);
        this.ev.notice('Press play to start. The browser needs a click or tap first.');
        return;
      }
      this.ev.state(true);
    } else {
      try {
        await this.video.play();
      } catch (e) {
        if ((e as DOMException)?.name === 'NotAllowedError') this.ev.notice('Press play to start. The browser needs a click or tap first.');
      }
    }
  }

  async pause() {
    if (this.engine === 'builtin') {
      await this.soft?.pause();
      this.ev.state(false);
    } else this.video.pause();
  }

  async toggle() {
    if (this.playing) await this.pause();
    else await this.play();
  }

  async seek(t: number) {
    const d = this.duration;
    const to = Math.max(0, d > 0 ? Math.min(t, d) : t);
    if (this.engine === 'builtin') await this.soft?.seek(to);
    else this.video.currentTime = to;
    this.ev.time(to);
  }

  seekBy(delta: number) {
    return this.seek(this.time + delta);
  }

  /** Step one frame (the frame rate is an estimate for native playback). */
  async step(dir: 1 | -1) {
    await this.pause();
    await this.seekBy(dir * (1 / 25));
  }

  // ------------------------------------------------------------------- audio

  private lastMade: FxChain | null = null;
  private makeChain(ctx: AudioContext, which: 'soft' | 'sound') {
    const c = new FxChain(ctx, this.fx);
    this.chains.add(c);
    this.lastMade = c;
    if (which === 'soft') this.softChain = c;
    return { input: c.input, output: c.output };
  }

  /** The analyser of whichever engine is making sound (for the visualizer). */
  get analyser(): AnalyserNode | null {
    return (this.engine === 'builtin' ? this.softChain : this.engine === 'native+sound' ? this.soundChain : this.graph?.chain)?.analyser ?? null;
  }

  /** Route the browser's <video> through the effects chain (an element can only be connected once). */
  ensureGraph() {
    if (this.graph) return this.graph;
    const ctx = new AudioContext();
    const src = ctx.createMediaElementSource(this.video);
    const chain = new FxChain(ctx, this.fx);
    src.connect(chain.input);
    chain.output.connect(ctx.destination);
    this.chains.add(chain);
    this.graph = { ctx, chain };
    return this.graph;
  }

  setFx(s: FxSettings) {
    this.fx = s;
    saveFx(s);
    if (s.enabled && this.engine === 'native' && this.info?.hasVideo !== undefined) this.ensureGraph();
    this.chains.forEach((c) => c.apply(s));
    this.applyVolume();
  }

  get volume() {
    return this._volume;
  }
  get muted() {
    return this._muted;
  }
  setVolume(v: number, muted = false) {
    this._volume = Math.max(0, Math.min(2, v));
    this._muted = muted;
    this.applyVolume();
  }

  private applyVolume() {
    const eff = this._muted ? 0 : this._volume;
    this.soft?.setVolume(eff);
    this.sound?.setVolume(eff);
    if (this.engine === 'builtin') return;
    const v = this.video;
    if (this.engine === 'native+sound') {
      v.muted = true;
      return;
    }
    v.muted = this._muted;
    // The effects chain, or volume above 100 %, needs the element routed through Web Audio.
    if (this.graph || eff > 1 || this.fx.enabled || (this.info && !this.info.hasVideo)) {
      const g = this.ensureGraph();
      v.volume = 1;
      g.chain.setMaster(eff);
      void g.ctx.resume();
    } else v.volume = eff;
  }

  get rate() {
    return this._rate;
  }
  setRate(r: number) {
    this._rate = r;
    if (this.engine !== 'builtin') this.video.playbackRate = r;
  }

  // ----------------------------------------------------------------- extras

  async snapshot(): Promise<Blob | null> {
    const src: CanvasImageSource = this.engine === 'builtin' ? this.canvas : this.video;
    const w = this.engine === 'builtin' ? this.canvas.width : this.video.videoWidth;
    const h = this.engine === 'builtin' ? this.canvas.height : this.video.videoHeight;
    if (!w || !h) return null;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;
    g.filter = (this.engine === 'builtin' ? this.canvas : this.video).style.filter.replace(/url\([^)]*\)/g, '').trim() || 'none';
    g.drawImage(src, 0, 0, w, h);
    return new Promise((r) => c.toBlob(r, 'image/png'));
  }

  async pip() {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (this.canPip) await this.video.requestPictureInPicture();
  }

  // ---------------------------------------------------------------- teardown

  private showSurface(which: 'video' | 'canvas') {
    this.video.hidden = which !== 'video';
    this.canvas.hidden = which !== 'canvas';
  }

  private destroyStreams() {
    this.hls?.destroy();
    this.hls = null;
    this.dash?.destroy();
    this.dash = null;
  }

  private releaseNative() {
    this.destroyStreams();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }

  unload() {
    this.soft?.destroy();
    this.soft = null;
    if (this.softChain) this.chains.delete(this.softChain);
    this.softChain = null;
    this.stopSidecar();
    this.releaseNative();
    this.info = null;
    this.probe = null;
    this.audioPick = null;
    this.source = {};
    this.engine = 'native';
    this.video.muted = this._muted;
  }

  destroy() {
    clearInterval(this.ticker);
    this.unload();
  }
}
