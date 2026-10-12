import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compressImage,
  fitDimensions,
  formatBytes,
  outputName,
  type CompressionSettings,
  type OutputFormat,
} from './compress.ts';

const defaults: CompressionSettings = {
  mode: 'size',
  targetBytes: 1000,
  quality: 0.8,
  format: 'image/webp',
  allowResize: false,
  maxWidth: 800,
  maxHeight: 800,
};

function png(width = 1000, height = 500, size = 128, type = 'image/png'): File {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const data = new DataView(bytes.buffer);
  data.setUint32(8, 13);
  bytes.set(new TextEncoder().encode('IHDR'), 12);
  data.setUint32(16, width);
  data.setUint32(20, height);
  return new File([bytes], 'image.png', { type });
}

function jpeg(width = 1000, height = 500): File {
  const bytes = new Uint8Array(128);
  bytes.set([
    0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc2, 0, 11, 8,
    height >>> 8, height & 255, width >>> 8, width & 255, 1, 1, 0x11, 0, 0xff, 0xd9,
  ]);
  return new File([bytes], 'image.jpg', { type: 'image/jpeg' });
}

function webp(kind: 'VP8X' | 'VP8 ' | 'VP8L', width = 1000, height = 500): File {
  const bytes = new Uint8Array(128);
  const data = new DataView(bytes.buffer);
  const encoder = new TextEncoder();
  bytes.set(encoder.encode('RIFF'));
  data.setUint32(4, bytes.length - 8, true);
  bytes.set(encoder.encode('WEBP'), 8);
  bytes.set(encoder.encode(kind), 12);
  data.setUint32(16, kind === 'VP8L' ? 5 : 10, true);
  if (kind === 'VP8X') {
    const put24 = (offset: number, value: number) => {
      bytes[offset] = value & 255;
      bytes[offset + 1] = (value >>> 8) & 255;
      bytes[offset + 2] = (value >>> 16) & 255;
    };
    put24(24, width - 1);
    put24(27, height - 1);
  } else if (kind === 'VP8 ') {
    bytes.set([0x9d, 1, 0x2a], 23);
    data.setUint16(26, width, true);
    data.setUint16(28, height, true);
  } else {
    bytes[20] = 0x2f;
    data.setUint32(21, ((width - 1) | ((height - 1) << 14)) >>> 0, true);
  }
  return new File([bytes], 'image.webp', { type: 'image/webp' });
}

function box(kind: string, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(8 + parts.reduce((sum, part) => sum + part.length, 0));
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(new TextEncoder().encode(kind), 4);
  let offset = 8;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function avif(width = 1000, height = 500, padding = 0): File {
  const encoder = new TextEncoder();
  const ftyp = box('ftyp', encoder.encode('mif1'), new Uint8Array(4), encoder.encode('avif'));
  const properties = new Uint8Array(12);
  const data = new DataView(properties.buffer);
  data.setUint32(4, width);
  data.setUint32(8, height);
  const meta = box('meta', new Uint8Array(4), box('iprp', box('ipco', box('ispe', properties))));
  return new File([ftyp, box('mdat', new Uint8Array(padding)), meta], 'image.avif', { type: 'image/avif' });
}

type Encoding = { width: number; height: number; format: string; quality: number };
type BrowserOptions = {
  width?: number;
  height?: number;
  bytes?: (encoding: Encoding) => number;
  outputType?: string;
  nullBlob?: boolean;
  encodeThrows?: boolean;
  drawThrows?: boolean;
  noContext?: boolean;
  bitmapFails?: boolean;
  imageFails?: boolean;
};

async function withBrowser(
  options: BrowserOptions,
  run: (state: {
    encodings: Encoding[];
    events: string[];
    decoded: number;
    closed: number;
    canvases: number;
    revoked: number;
    removed: number;
    canvas: { width: number; height: number };
  }) => Promise<void>,
): Promise<void> {
  const encodings: Encoding[] = [];
  const events: string[] = [];
  const state = {
    encodings,
    events,
    decoded: 0,
    closed: 0,
    canvases: 0,
    revoked: 0,
    removed: 0,
    canvas: { width: 0, height: 0 },
  };
  const width = options.width ?? 1000;
  const height = options.height ?? 500;
  const context = {
    fillStyle: '',
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    fillRect(x: number, y: number, w: number, h: number) {
      assert.equal(this.fillStyle, '#ffffff');
      assert.deepEqual([x, y, w, h], [0, 0, state.canvas.width, state.canvas.height]);
      events.push('fill');
    },
    drawImage(_image: unknown, x: number, y: number, w: number, h: number) {
      if (options.drawThrows) throw new Error('Draw failed');
      assert.deepEqual([x, y, w, h], [0, 0, state.canvas.width, state.canvas.height]);
      events.push('draw');
    },
  };
  const canvas = Object.assign(state.canvas, {
    getContext(kind: string) {
      assert.equal(kind, '2d');
      return options.noContext ? null : context;
    },
    toBlob(callback: (blob: Blob | null) => void, format: string, quality: number) {
      const encoding = { width: canvas.width, height: canvas.height, format, quality };
      encodings.push(encoding);
      if (options.encodeThrows) throw new Error('Encode failed');
      const size = options.bytes?.(encoding) ?? Math.ceil(100 + quality * 1000);
      const blob = options.nullBlob ? null : new Blob([new Uint8Array(size)], {
        type: options.outputType ?? format,
      });
      queueMicrotask(() => callback(blob));
    },
  });
  const restore: (() => void)[] = [];
  const replace = (object: object, key: PropertyKey, value: unknown) => {
    const previous = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { configurable: true, writable: true, value });
    restore.push(() => {
      if (previous) Object.defineProperty(object, key, previous);
      else Reflect.deleteProperty(object, key);
    });
  };
  class LocalImage {
    naturalWidth = width;
    naturalHeight = height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    decoding = '';
    set src(value: string) {
      assert.match(value, /^blob:/);
      queueMicrotask(() => options.imageFails ? this.onerror?.() : this.onload?.());
    }
    removeAttribute(name: string) {
      assert.equal(name, 'src');
      state.removed++;
    }
  }
  try {
    replace(globalThis, 'document', {
      createElement(tag: string) {
        assert.equal(tag, 'canvas');
        state.canvases++;
        return canvas;
      },
    });
    replace(globalThis, 'createImageBitmap', async () => {
      state.decoded++;
      if (options.bitmapFails) throw new Error('Bitmap failed');
      return { width, height, close: () => { state.closed++; } };
    });
    replace(globalThis, 'Image', LocalImage);
    replace(URL, 'createObjectURL', () => 'blob:local-test');
    replace(URL, 'revokeObjectURL', () => { state.revoked++; });
    await run(state);
  } finally {
    for (const undo of restore.reverse()) undo();
  }
}

test('fitDimensions fits landscape and portrait images without an upscale', () => {
  assert.deepEqual(fitDimensions(4000, 3000, 1000, 1000), { width: 1000, height: 750 });
  assert.deepEqual(fitDimensions(3000, 4000, 1000, 1000), { width: 750, height: 1000 });
  assert.deepEqual(fitDimensions(800, 600, 400, 200), { width: 266, height: 200 });
  assert.deepEqual(fitDimensions(100, 50, 800, 600), { width: 100, height: 50 });
  assert.deepEqual(fitDimensions(100, 100, 100, 100), { width: 100, height: 100 });
});

test('fitDimensions handles fractional limits and very narrow images', () => {
  assert.deepEqual(fitDimensions(100.9, 50.9, 40.9, 40.9), { width: 40, height: 20 });
  assert.deepEqual(fitDimensions(10000, 1, 1, 1), { width: 1, height: 1 });
  assert.deepEqual(fitDimensions(1, 10000, 3, 100), { width: 1, height: 100 });
});

test('fitDimensions rejects invalid dimensions and limits', () => {
  for (const invalid of [0, -1, 0.5, NaN, Infinity, -Infinity]) {
    for (let position = 0; position < 4; position++) {
      const values: [number, number, number, number] = [100, 100, 50, 50];
      values[position] = invalid;
      assert.throws(() => fitDimensions(...values), RangeError);
    }
  }
});

test('fitDimensions stays within bounds with only pixel-rounding aspect error', () => {
  for (const width of [1, 3, 16, 801, 4032]) {
    for (const height of [1, 7, 99, 600, 3024]) {
      for (const maxWidth of [1, 2, 99, 1024]) {
        for (const maxHeight of [1, 3, 87, 2048]) {
          const result = fitDimensions(width, height, maxWidth, maxHeight);
          assert.ok(Number.isInteger(result.width) && Number.isInteger(result.height));
          assert.ok(result.width >= 1 && result.width <= Math.min(width, maxWidth));
          assert.ok(result.height >= 1 && result.height <= Math.min(height, maxHeight));
          assert.ok(Math.abs(result.width * height - result.height * width) <= width + height);
        }
      }
    }
  }
});

test('formatBytes uses binary units and concise decimal values', () => {
  for (const [input, expected] of [
    [0, '0 B'], [1, '1 B'], [1023, '1023 B'], [1024, '1 KB'], [1536, '1.5 KB'],
    [12345, '12.06 KB'], [1024 ** 2, '1 MB'], [1024 ** 3, '1 GB'],
    [1024 ** 4, '1 TB'], [1024 ** 5, '1 PB'], [1024 ** 6, '1 EB'],
    [0.25, '0 B'], [1.8, '2 B'],
  ] as const) {
    assert.equal(formatBytes(input), expected);
  }
});

test('formatBytes handles invalid and very large values', () => {
  for (const bytes of [-1, -Infinity, Infinity, NaN]) assert.equal(formatBytes(bytes), '0 B');
  assert.match(formatBytes(Number.MAX_VALUE), / EB$/);
  assert.doesNotMatch(formatBytes(Number.MAX_VALUE), /NaN|Infinity|undefined/);
});

test('outputName replaces the last extension with the requested format', () => {
  assert.equal(outputName('photo.PNG', 'image/webp'), 'photo-compressed.webp');
  assert.equal(outputName('photo.final.avif', 'image/jpeg'), 'photo.final-compressed.jpg');
  assert.equal(outputName('photo', 'image/png'), 'photo-compressed.png');
  assert.equal(outputName('家族.jpeg', 'image/webp'), '家族-compressed.webp');
});

test('outputName handles paths, hidden names, empty names, and trailing dots', () => {
  for (const [input, expected] of [
    ['/images/photo.jpg', 'photo-compressed.png'],
    ['C:\\images\\photo.jpg', 'photo-compressed.png'],
    ['.photo', '.photo-compressed.png'],
    ['photo...', 'photo-compressed.png'],
    ['  photo.jpg  ', 'photo-compressed.png'],
    ['', 'image-compressed.png'],
    ['   ', 'image-compressed.png'],
    ['...', 'image-compressed.png'],
    ['/images/', 'image-compressed.png'],
  ]) {
    assert.equal(outputName(input!, 'image/png'), expected);
  }
});

test('outputName rejects unsupported formats and inherited object keys', () => {
  for (const format of ['image/avif', 'image/gif', 'toString', '__proto__']) {
    assert.throws(() => outputName('photo.jpg', format as OutputFormat), /Unsupported output format/);
  }
});

test('quality mode preserves decoded dimensions and the selected quality', async () => {
  await withBrowser({ width: 500, height: 1000 }, async (state) => {
    const file = png();
    const result = await compressImage(file, { ...defaults, mode: 'quality', quality: 0.3, allowResize: true });
    assert.equal(result.width, 500);
    assert.equal(result.height, 1000);
    assert.equal(result.quality, 0.3);
    assert.equal(state.encodings.length, 1);
    assert.equal(state.encodings[0]!.quality, 0.3);
    assert.equal(state.closed, 1);
    assert.equal(state.canvas.width, 0);
    assert.equal(state.canvas.height, 0);
  });
});

test('quality mode accepts both quality endpoints', async () => {
  for (const quality of [0, 1]) {
    await withBrowser({}, async (state) => {
      const result = await compressImage(png(), { ...defaults, mode: 'quality', quality });
      assert.equal(result.quality, quality);
      assert.equal(state.encodings[0]!.quality, quality);
    });
  }
});

test('resize mode fits the bounds at the selected quality even when allowResize is false', async () => {
  await withBrowser({}, async (state) => {
    const result = await compressImage(png(), {
      ...defaults, mode: 'resize', maxWidth: 300, maxHeight: 100, quality: 0.6,
    });
    assert.equal(result.width, 200);
    assert.equal(result.height, 100);
    assert.equal(result.quality, 0.6);
    assert.equal(state.encodings.length, 1);
  });
});

test('resize mode never increases dimensions', async () => {
  await withBrowser({ width: 100, height: 50 }, async () => {
    const result = await compressImage(png(100, 50), { ...defaults, mode: 'resize' });
    assert.equal(result.width, 100);
    assert.equal(result.height, 50);
  });
});

test('size mode finds the highest fitting quality within the bounded search precision', async () => {
  await withBrowser({}, async (state) => {
    const result = await compressImage(png(), { ...defaults, targetBytes: 650 });
    assert.equal(result.targetMet, true);
    assert.ok(result.blob.size <= 650);
    assert.ok(result.quality <= 0.55 && result.quality >= 0.55 - 1 / 256);
    assert.equal(result.width, 1000);
    assert.equal(result.height, 500);
    assert.equal(state.encodings.length, 10);
  });
});

test('size mode stops immediately when maximum quality fits', async () => {
  await withBrowser({}, async (state) => {
    const result = await compressImage(png(), { ...defaults, targetBytes: 1100 });
    assert.equal(result.quality, 1);
    assert.equal(result.targetMet, true);
    assert.equal(state.encodings.length, 1);
  });
});

test('size mode reports failure without a dimension change when resize is disabled', async () => {
  await withBrowser({}, async (state) => {
    const result = await compressImage(png(), { ...defaults, targetBytes: 20 });
    assert.equal(result.targetMet, false);
    assert.equal(result.blob.size, 100);
    assert.equal(result.quality, 0);
    assert.equal(result.width, 1000);
    assert.equal(result.height, 500);
    assert.equal(state.encodings.length, 2);
  });
});

test('size mode progressively reduces dimensions only when permitted', async () => {
  await withBrowser({ bytes: ({ width, height, quality }) => Math.ceil(100 + width * height * (0.1 + quality * 0.9)) }, async (state) => {
    const result = await compressImage(png(), { ...defaults, targetBytes: 15000, allowResize: true });
    assert.equal(result.targetMet, true);
    assert.ok(result.blob.size <= 15000);
    assert.ok(result.width < 1000 && result.height < 500);
    assert.ok(Math.abs(result.width - result.height * 2) <= 1);
    assert.ok(state.encodings.length <= 130);
    for (let index = 1; index < state.encodings.length; index++) {
      assert.ok(state.encodings[index]!.width <= state.encodings[index - 1]!.width);
      assert.ok(state.encodings[index]!.height <= state.encodings[index - 1]!.height);
    }
  });
});

test('unreachable targets terminate and remain unmet even at one pixel', async () => {
  await withBrowser({ width: 16000, height: 1, bytes: () => 100 }, async (state) => {
    const result = await compressImage(png(16000, 1), { ...defaults, targetBytes: 1, allowResize: true });
    assert.equal(result.targetMet, false);
    assert.equal(result.blob.size, 100);
    assert.ok(state.encodings.some(({ width, height }) => width === 1 && height === 1));
    assert.ok(state.encodings.length <= 26);
    assert.equal(state.closed, 1);
  });
});

test('PNG skips quality search and respects the resize permission', async () => {
  for (const allowResize of [false, true]) {
    await withBrowser({ bytes: ({ width, height }) => 100 + width * height }, async (state) => {
      const result = await compressImage(png(1000, 500, 600000), {
        ...defaults, format: 'image/png', targetBytes: 15000, allowResize,
      });
      assert.equal(result.targetMet, allowResize);
      assert.ok(state.encodings.every(({ quality }) => quality === 1));
      const dimensions = new Set(state.encodings.map(({ width, height }) => `${width}x${height}`));
      assert.equal(dimensions.size, state.encodings.length);
      if (!allowResize) {
        assert.equal(state.encodings.length, 1);
        assert.equal(result.width, 1000);
      } else {
        assert.ok(result.blob.size <= 15000);
      }
    });
  }
});

test('size mode returns a valid original only for the same format', async () => {
  await withBrowser({}, async (state) => {
    const file = jpeg();
    const result = await compressImage(file, { ...defaults, format: 'image/jpeg', targetBytes: file.size });
    assert.equal(result.blob, file);
    assert.equal(result.quality, 1);
    assert.equal(result.targetMet, true);
    assert.equal(state.canvases, 0);
    assert.equal(state.closed, 1);
  });
  await withBrowser({}, async (state) => {
    const file = png();
    const result = await compressImage(file, { ...defaults, targetBytes: 2000 });
    assert.notEqual(result.blob, file);
    assert.equal(result.blob.type, 'image/webp');
    assert.equal(state.encodings.length, 1);
  });
});

test('size mode preserves original bytes and corrects a missing or incorrect MIME type', async () => {
  for (const type of ['', 'image/jpeg']) {
    await withBrowser({}, async (state) => {
      const file = png(1000, 500, 128, type);
      const result = await compressImage(file, { ...defaults, format: 'image/png' });
      assert.equal(result.blob.type, 'image/png');
      assert.deepEqual(await result.blob.arrayBuffer(), await file.arrayBuffer());
      assert.equal(result.targetMet, true);
      assert.equal(state.canvases, 0);
      assert.equal(state.closed, 1);
    });
  }
});

test('size mode does not return a larger encoding when the original is smaller', async () => {
  await withBrowser({ bytes: () => 500 }, async () => {
    const file = jpeg();
    const result = await compressImage(file, { ...defaults, format: 'image/jpeg', targetBytes: 100 });
    assert.equal(result.blob, file);
    assert.equal(result.targetMet, false);
  });
});

test('the original shortcut never overrides quality or resize settings', async () => {
  for (const mode of ['quality', 'resize'] as const) {
    await withBrowser({}, async (state) => {
      const file = png();
      const result = await compressImage(file, { ...defaults, mode, format: 'image/png', quality: 0.2 });
      assert.notEqual(result.blob, file);
      assert.equal(result.quality, 0.2);
      assert.equal(state.encodings.length, 1);
      assert.equal(result.width, mode === 'resize' ? 800 : 1000);
    });
  }
});

test('JPEG paints a white background before the image, and other formats retain alpha', async () => {
  for (const format of ['image/jpeg', 'image/png', 'image/webp'] as const) {
    await withBrowser({}, async (state) => {
      await compressImage(png(), { ...defaults, mode: 'quality', format });
      assert.deepEqual(state.events, format === 'image/jpeg' ? ['fill', 'draw'] : ['draw']);
    });
  }
});

test('header checks accept JPEG, PNG, all WebP variants, and AVIF metadata after media data', async () => {
  for (const file of [jpeg(), png(), webp('VP8X'), webp('VP8 '), webp('VP8L'), avif(), avif(1000, 500, 1100000)]) {
    await withBrowser({}, async (state) => {
      const result = await compressImage(file, { ...defaults, mode: 'quality' });
      assert.equal(result.width, 1000);
      assert.equal(state.decoded, 1);
      assert.equal(state.closed, 1);
    });
  }
});

test('oversized headers fail before native decoding or canvas allocation', async () => {
  for (const file of [
    png(20000, 1), png(6000, 6000), jpeg(20000, 1), jpeg(6000, 6000),
    webp('VP8X', 20000, 1), webp('VP8 ', 6000, 6000), webp('VP8L', 6000, 6000), avif(20000, 1),
  ]) {
    await withBrowser({}, async (state) => {
      await assert.rejects(compressImage(file, defaults), /too large/);
      assert.equal(state.decoded, 0);
      assert.equal(state.canvases, 0);
    });
  }
});

test('decoded dimension validation releases the bitmap before failure', async () => {
  for (const [width, height] of [[0, 500], [1000, 0], [20000, 500], [6000, 6000]]) {
    await withBrowser({ width: width!, height: height! }, async (state) => {
      await assert.rejects(compressImage(png(), defaults), /invalid dimensions|too large/);
      assert.equal(state.closed, 1);
      assert.equal(state.canvases, 0);
    });
  }
});

test('empty, unsupported, truncated, and malformed files fail before decoding', async () => {
  const files = [
    new File([], 'empty.png', { type: 'image/png' }),
    new File(['GIF89a'], 'wrong.png', { type: 'image/png' }),
    new File([new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0])], 'truncated.jpg'),
    new File([box('ftyp', new TextEncoder().encode('heic'))], 'unsupported.avif'),
    new File([new Uint8Array([0, 0, 0, 2, 102, 116, 121, 112])], 'bad.avif'),
    png(0, 500),
  ];
  for (const file of files) {
    await withBrowser({}, async (state) => {
      await assert.rejects(compressImage(file, defaults), /empty|Unsupported|dimensions/);
      assert.equal(state.decoded, 0);
    });
  }
});

test('PNG fallback for an unsupported encoder is an error, not a mislabeled result', async () => {
  await withBrowser({ outputType: 'image/png' }, async (state) => {
    await assert.rejects(compressImage(png(), { ...defaults, mode: 'quality' }), /cannot encode image\/webp/);
    assert.equal(state.closed, 1);
    assert.equal(state.canvas.width, 0);
    assert.equal(state.canvas.height, 0);
  });
});

test('canvas and encoding failures provide errors and release resources', async () => {
  for (const options of [
    { noContext: true }, { nullBlob: true }, { encodeThrows: true },
    { drawThrows: true }, { bytes: () => 0 },
  ]) {
    await withBrowser(options, async (state) => {
      await assert.rejects(compressImage(png(), { ...defaults, mode: 'quality' }), /could not/);
      assert.equal(state.closed, 1);
      assert.equal(state.canvas.width, 0);
      assert.equal(state.canvas.height, 0);
    });
  }
});

test('the image-element fallback revokes its URL and clears its source after success', async () => {
  await withBrowser({ bitmapFails: true }, async (state) => {
    await compressImage(png(), { ...defaults, mode: 'quality' });
    assert.equal(state.revoked, 1);
    assert.equal(state.removed, 1);
    assert.equal(state.closed, 0);
    assert.equal(state.encodings.length, 1);
  });
});

test('the image-element fallback revokes its URL after decode or encode failure', async () => {
  for (const options of [{ imageFails: true }, { nullBlob: true }]) {
    await withBrowser({ ...options, bitmapFails: true }, async (state) => {
      await assert.rejects(compressImage(png(), { ...defaults, mode: 'quality' }), /decode|encode/);
      assert.equal(state.revoked, 1);
      assert.equal(state.removed, 1);
    });
  }
});

test('invalid settings fail before decoding', async () => {
  const invalid: Partial<CompressionSettings>[] = [
    { quality: -0.1 }, { quality: 1.1 }, { quality: NaN }, { quality: Infinity },
    { targetBytes: 0 }, { targetBytes: -1 }, { targetBytes: NaN }, { targetBytes: Infinity },
    { mode: 'resize', maxWidth: 0 }, { mode: 'resize', maxHeight: Infinity },
    { mode: 'unknown' as CompressionSettings['mode'] }, { format: 'image/avif' as OutputFormat },
  ];
  for (const settings of invalid) {
    await withBrowser({}, async (state) => {
      await assert.rejects(compressImage(png(), { ...defaults, ...settings }), /Quality|target size|width|height|Unsupported/);
      assert.equal(state.decoded, 0);
    });
  }
});

test('compression snapshots settings before asynchronous work', async () => {
  await withBrowser({}, async (state) => {
    const settings = { ...defaults, mode: 'quality' as const, quality: 0.3 };
    const pending = compressImage(png(), settings);
    settings.quality = 0.9;
    settings.format = 'image/png';
    const result = await pending;
    assert.equal(result.quality, 0.3);
    assert.equal(result.blob.type, 'image/webp');
    assert.equal(state.encodings.length, 1);
  });
});

test('compression outside a browser has a useful error', async () => {
  await assert.rejects(compressImage(png(), defaults), /requires a browser/);
});
