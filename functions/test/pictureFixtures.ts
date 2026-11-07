const ascii = (text: string) => [...Buffer.from(text, "latin1")];

/** A GIF of [frames] one-pixel images, each behind a graphic control extension. */
export function gifOf(frames: number, { palette = false, comment = false } = {}): Buffer {
  const parts: number[][] = [ascii("GIF89a"), [1, 0, 1, 0, palette ? 0x80 : 0x00, 0, 0]];
  if (palette) parts.push([0, 0, 0, 255, 255, 255]);
  if (comment) parts.push([0x21, 0xfe, 3, ...ascii("hi!"), 0]);
  for (let at = 0; at < frames; at++) {
    parts.push([0x21, 0xf9, 4, 0, 10, 0, 0, 0]);
    parts.push([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 2, 2, 0x4c, 0x01, 0]);
  }
  parts.push([0x3b]);
  return Buffer.from(parts.flat());
}

/** A WebP made of these chunks, each `[fourcc, data]`. */
export function webpOf(...chunks: [string, number[]][]): Buffer {
  const body = chunks.flatMap(([name, data]) => {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(data.length);
    return [...ascii(name), ...size, ...data, ...(data.length % 2 === 1 ? [0] : [])];
  });
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length + 4);
  return Buffer.from([...ascii("RIFF"), ...size, ...ascii("WEBP"), ...body]);
}
