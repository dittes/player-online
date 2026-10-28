// The bridge ships TypeScript sources that don't compile under our strict settings; we only need these two functions.
export function videoStreamToConfig(libav: unknown, stream: unknown): Promise<VideoDecoderConfig | null>;
export function audioStreamToConfig(libav: unknown, stream: unknown): Promise<AudioDecoderConfig | null>;
