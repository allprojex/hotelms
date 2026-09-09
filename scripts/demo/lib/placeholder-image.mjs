// A dependency-free PNG writer for the demo's placeholder photography.
//
// The demo must never carry another operator's room photographs, so gallery
// images are generated here: a soft diagonal gradient in the property's brand
// colours with a lighter "window" band, which reads as a deliberate
// placeholder rather than a broken image. Roughly 20–40 KB per image.

import { deflateSync } from "node:zlib";

function crc32(buffer) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * Math.min(1, Math.max(0, t)));
}

/**
 * @param {{width:number,height:number,from:[number,number,number],to:[number,number,number],accent?:[number,number,number],seed?:number}} spec
 * @returns {Buffer} PNG bytes
 */
export function gradientPng(spec) {
  const { width, height, from, to, accent = [255, 255, 255], seed = 1 } = spec;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const t = (x / width) * 0.6 + (y / height) * 0.4;
      let r = mix(from[0], to[0], t);
      let g = mix(from[1], to[1], t);
      let b = mix(from[2], to[2], t);
      // a soft horizontal band, like light through a window
      const band = Math.exp(-(((y - height * (0.34 + ((seed % 7) / 40))) / (height * 0.12)) ** 2));
      r = mix(r, accent[0], band * 0.28);
      g = mix(g, accent[1], band * 0.28);
      b = mix(b, accent[2], band * 0.28);
      // gentle vignette
      const dx = (x - width / 2) / (width / 2);
      const dy = (y - height / 2) / (height / 2);
      const vignette = 1 - 0.22 * Math.min(1, dx * dx + dy * dy);
      raw[offset++] = Math.round(r * vignette);
      raw[offset++] = Math.round(g * vignette);
      raw[offset++] = Math.round(b * vignette);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
