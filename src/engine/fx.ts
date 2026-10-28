/**
 * Audio effects: preamp, 10-band equalizer, loudness normalizer, mono downmix and balance, plus an analyser
 * for the visualizer. One FxChain exists per AudioContext (the browser engine and the built-in engine each
 * have their own context); all chains follow the same settings object.
 */

export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const EQ_PRESETS: Record<string, number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass boost': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  'Treble boost': [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  Vocal: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
  Speech: [-3, -2, 0, 2, 4, 4, 3, 1, -1, -3],
  Rock: [5, 4, 2, -1, -2, -1, 2, 4, 5, 5],
  Pop: [-1, 2, 4, 5, 3, 0, -1, -1, -1, -1],
  Dance: [6, 5, 3, 0, 0, -3, -4, -4, 0, 0],
  Classical: [0, 0, 0, 0, 0, 0, -3, -3, -3, -5],
  Laptop: [3, 6, 4, -2, -1, 1, 3, 5, 6, 6],
};

export interface FxSettings {
  enabled: boolean;
  /** dB, −12 … +12 */
  preamp: number;
  /** dB per band, −12 … +12 */
  bands: number[];
  /** Compress loud and quiet parts closer together (night mode). */
  normalize: boolean;
  mono: boolean;
  /** −1 (left) … +1 (right) */
  balance: number;
}

export const defaultFx = (): FxSettings => ({ enabled: false, preamp: 0, bands: EQ_PRESETS.Flat.slice(), normalize: false, mono: false, balance: 0 });

export function loadFx(): FxSettings {
  try {
    const raw = JSON.parse(localStorage.getItem('webplayer.fx') ?? 'null');
    if (raw && Array.isArray(raw.bands) && raw.bands.length === EQ_FREQS.length) return { ...defaultFx(), ...raw };
  } catch {
    /* ignore */
  }
  return defaultFx();
}

export function saveFx(s: FxSettings) {
  try {
    localStorage.setItem('webplayer.fx', JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

export class FxChain {
  readonly input: GainNode;
  readonly output: GainNode;
  readonly analyser: AnalyserNode;
  private preamp: GainNode;
  private filters: BiquadFilterNode[];
  private comp: DynamicsCompressorNode;
  private makeup: GainNode;
  private monoer: GainNode;
  private pan: StereoPannerNode;

  constructor(readonly ctx: AudioContext, settings: FxSettings) {
    this.input = ctx.createGain();
    this.preamp = ctx.createGain();
    this.filters = EQ_FREQS.map((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f;
      b.Q.value = 1.1;
      return b;
    });
    this.comp = ctx.createDynamicsCompressor();
    this.makeup = ctx.createGain();
    this.monoer = ctx.createGain();
    this.monoer.channelCount = 2;
    this.pan = ctx.createStereoPanner();
    this.output = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.8;

    let node: AudioNode = this.input;
    for (const n of [this.preamp, ...this.filters, this.comp, this.makeup, this.monoer, this.pan, this.output]) {
      node.connect(n);
      node = n;
    }
    this.output.connect(this.analyser); // tap only; the analyser has no output
    this.apply(settings);
  }

  apply(s: FxSettings) {
    const on = s.enabled;
    const t = this.ctx.currentTime;
    this.preamp.gain.setTargetAtTime(on ? 10 ** (s.preamp / 20) : 1, t, 0.02);
    this.filters.forEach((f, i) => f.gain.setTargetAtTime(on ? s.bands[i] : 0, t, 0.02));
    const norm = on && s.normalize;
    // Neutral settings when off: ratio 1 leaves the signal untouched.
    this.comp.threshold.value = norm ? -26 : 0;
    this.comp.knee.value = norm ? 24 : 0;
    this.comp.ratio.value = norm ? 6 : 1;
    this.comp.attack.value = 0.01;
    this.comp.release.value = 0.25;
    this.makeup.gain.setTargetAtTime(norm ? 2.2 : 1, t, 0.05);
    const mono = on && s.mono;
    this.monoer.channelCount = mono ? 1 : 2;
    this.monoer.channelCountMode = mono ? 'explicit' : 'max';
    this.pan.pan.setTargetAtTime(on ? s.balance : 0, t, 0.02);
  }

  /** Master volume after the effects (used for the browser engine's gain above 100 %). */
  setMaster(v: number) {
    this.output.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }
}
