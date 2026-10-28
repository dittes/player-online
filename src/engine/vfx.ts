/**
 * Video adjustments applied with CSS and SVG filters, so they cost the GPU almost nothing and work the same
 * for the browser's <video> and the built-in engine's canvas: brightness, contrast, saturation, hue, gamma,
 * sharpen, grayscale/invert, rotate, flip, zoom/pan and aspect ratio.
 */

export type Aspect = 'auto' | 'fill' | 'stretch' | '16:9' | '4:3' | '21:9' | '1:1' | '16:10' | '5:4';

export interface VideoSettings {
  brightness: number; // percent, 100 = unchanged
  contrast: number;
  saturation: number;
  hue: number; // degrees
  gamma: number; // 0.5 … 2.5, 1 = unchanged
  sharpen: number; // 0 … 1
  grayscale: boolean;
  invert: boolean;
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  zoom: number; // 1 … 4
  panX: number; // px
  panY: number;
  aspect: Aspect;
}

export const defaultVideo = (): VideoSettings => ({
  brightness: 100, contrast: 100, saturation: 100, hue: 0, gamma: 1, sharpen: 0, grayscale: false, invert: false,
  rotate: 0, flipH: false, flipV: false, zoom: 1, panX: 0, panY: 0, aspect: 'auto',
});

export const ASPECTS: Array<[Aspect, string]> = [
  ['auto', 'Original'], ['fill', 'Fill (crop)'], ['stretch', 'Stretch'], ['16:9', '16:9'], ['16:10', '16:10'],
  ['4:3', '4:3'], ['5:4', '5:4'], ['21:9', '21:9'], ['1:1', '1:1'],
];

const NS = 'http://www.w3.org/2000/svg';
let svgReady: { gamma: SVGFEFuncRElement[]; kernel: SVGFEConvolveMatrixElement } | null = null;

/** Two SVG filters (gamma and sharpen) referenced from the CSS filter list. Created once. */
function ensureSvg() {
  if (svgReady) return svgReady;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `
    <filter id="wp-gamma" color-interpolation-filters="sRGB"><feComponentTransfer>
      <feFuncR type="gamma" amplitude="1" exponent="1" offset="0"/><feFuncG type="gamma" amplitude="1" exponent="1" offset="0"/><feFuncB type="gamma" amplitude="1" exponent="1" offset="0"/>
    </feComponentTransfer></filter>
    <filter id="wp-sharpen" color-interpolation-filters="sRGB"><feConvolveMatrix order="3" kernelMatrix="0 0 0 0 1 0 0 0 0" divisor="1" preserveAlpha="true"/></filter>`;
  document.body.append(svg);
  svgReady = {
    gamma: Array.from(svg.querySelectorAll('feFuncR, feFuncG, feFuncB')) as SVGFEFuncRElement[],
    kernel: svg.querySelector('feConvolveMatrix') as SVGFEConvolveMatrixElement,
  };
  return svgReady;
}

const RATIO = (a: Aspect): number | null => {
  const m = /^(\d+):(\d+)$/.exec(a);
  return m ? Number(m[1]) / Number(m[2]) : null;
};

/** Apply the settings to the given surfaces (the <video> and the <canvas>) inside `stage`. */
export function applyVideo(stage: HTMLElement, surfaces: HTMLElement[], s: VideoSettings) {
  const parts: string[] = [];
  if (s.brightness !== 100) parts.push(`brightness(${s.brightness / 100})`);
  if (s.contrast !== 100) parts.push(`contrast(${s.contrast / 100})`);
  if (s.saturation !== 100) parts.push(`saturate(${s.saturation / 100})`);
  if (s.hue) parts.push(`hue-rotate(${s.hue}deg)`);
  if (s.grayscale) parts.push('grayscale(1)');
  if (s.invert) parts.push('invert(1)');
  if (s.gamma !== 1 || s.sharpen > 0) {
    const svg = ensureSvg();
    svg.gamma.forEach((f) => f.setAttribute('exponent', String(1 / s.gamma)));
    const k = s.sharpen * 1.2;
    svg.kernel.setAttribute('kernelMatrix', `0 ${-k} 0 ${-k} ${1 + 4 * k} ${-k} 0 ${-k} 0`);
    if (s.gamma !== 1) parts.push('url(#wp-gamma)');
    if (s.sharpen > 0) parts.push('url(#wp-sharpen)');
  }
  const filter = parts.join(' ') || 'none';

  // Rotating by 90° swaps width and height: shrink so the picture still fits the stage.
  const r = stage.getBoundingClientRect();
  const fit = s.rotate % 180 ? Math.min(r.width / r.height, r.height / r.width) : 1;
  const transform = `translate(${s.panX}px, ${s.panY}px) scale(${s.zoom * fit * (s.flipH ? -1 : 1)}, ${s.zoom * fit * (s.flipV ? -1 : 1)}) rotate(${s.rotate}deg)`;

  const ratio = RATIO(s.aspect);
  for (const el of surfaces) {
    el.style.filter = filter;
    el.style.transform = transform;
    el.classList.toggle('ratio', ratio !== null);
    if (ratio !== null) el.style.setProperty('--ar', String(ratio));
    el.style.objectFit = s.aspect === 'fill' ? 'cover' : s.aspect === 'stretch' || ratio !== null ? 'fill' : 'contain';
  }
}
