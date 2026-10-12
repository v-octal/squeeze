export type CompressionMode = 'size' | 'quality' | 'resize';
export type OutputFormat = 'image/webp' | 'image/jpeg' | 'image/png';

export interface CompressionSettings {
  mode: CompressionMode;
  targetBytes: number;
  quality: number;
  format: OutputFormat;
  allowResize: boolean;
  maxWidth: number;
  maxHeight: number;
}

export interface CompressionResult {
  blob: Blob;
  width: number;
  height: number;
  quality: number;
  targetMet: boolean;
}

type Dimensions = { width: number; height: number };
type DecodedImage = Dimensions & { source: CanvasImageSource; release: () => void };

const MAX_PIXELS = 32_000_000;
const MAX_DIMENSION = 16_384;
const MAX_METADATA_BYTES = 1_048_576;
const MAX_RESIZE_STEPS = 12;
const QUALITY_STEPS = 8;
const EXTENSIONS = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
} satisfies Record<OutputFormat, string>;

function validateFormat(format: OutputFormat): void {
  if (!Object.prototype.hasOwnProperty.call(EXTENSIONS, format)) {
    throw new Error('Unsupported output format. Choose WebP, JPEG, or PNG.');
  }
}

function positiveDimension(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError(`${name} must be a finite number of at least 1 pixel.`);
  }
}

export function fitDimensions(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): Dimensions {
  positiveDimension(width, 'Width');
  positiveDimension(height, 'Height');
  positiveDimension(maxWidth, 'Maximum width');
  positiveDimension(maxHeight, 'Maximum height');
  width = Math.floor(width);
  height = Math.floor(height);
  const scale = Math.min(1, Math.floor(maxWidth) / width, Math.floor(maxHeight) / height);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
  const unit = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log2(bytes) / 10)));
  const value = Number((bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 2));
  return `${value} ${units[unit]}`;
}

export function outputName(filename: string, format: OutputFormat): string {
  validateFormat(format);
  const name = filename.split(/[/\\]/).pop()?.trim() || 'image';
  const dot = name.lastIndexOf('.');
  const stem = (dot > 0 ? name.slice(0, dot) : name).replace(/\.+$/, '') || 'image';
  return `${stem}-compressed.${EXTENSIONS[format]}`;
}

function validateDimensions({ width, height }: Dimensions): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('The image has invalid dimensions.');
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new Error('The image is too large. Use at most 32 megapixels and 16384 pixels per side.');
  }
}

function invalidMetadata(): never {
  throw new Error('Cannot read the image dimensions. The file is damaged or its metadata is too large.');
}

function text(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function jpegDimensions(bytes: Uint8Array): Dimensions {
  const data = view(bytes);
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalidMetadata();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = data.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) break;
      return { width: data.getUint16(offset + 5), height: data.getUint16(offset + 3) };
    }
    offset += length;
  }
  return invalidMetadata();
}

function webpDimensions(bytes: Uint8Array): Dimensions {
  const data = view(bytes);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const kind = text(bytes, offset, 4);
    const length = data.getUint32(offset + 4, true);
    const start = offset + 8;
    if (kind === 'VP8X' && length >= 10 && start + 10 <= bytes.length) {
      const uint24 = (position: number) =>
        bytes[position]! + bytes[position + 1]! * 256 + bytes[position + 2]! * 65536;
      return { width: uint24(start + 4) + 1, height: uint24(start + 7) + 1 };
    }
    if (kind === 'VP8 ' && length >= 10 && start + 10 <= bytes.length) {
      if ((bytes[start]! & 1) !== 0 || text(bytes, start + 3, 3) !== '\x9d\x01\x2a') break;
      return {
        width: data.getUint16(start + 6, true) & 0x3fff,
        height: data.getUint16(start + 8, true) & 0x3fff,
      };
    }
    if (kind === 'VP8L' && length >= 5 && start + 5 <= bytes.length && bytes[start] === 0x2f) {
      const bits = data.getUint32(start + 1, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    offset = start + length + (length % 2);
  }
  return invalidMetadata();
}

function boxAt(bytes: Uint8Array, offset: number, limit: number) {
  if (offset + 8 > bytes.length) invalidMetadata();
  const data = view(bytes);
  let size = data.getUint32(offset);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > bytes.length) invalidMetadata();
    size = data.getUint32(offset + 8) * 4294967296 + data.getUint32(offset + 12);
    header = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (!Number.isSafeInteger(size) || size < header || size > limit - offset) invalidMetadata();
  return { kind: text(bytes, offset + 4, 4), start: offset + header, end: offset + size };
}

async function avifDimensions(file: File): Promise<Dimensions> {
  let offset = 0;
  let supported = false;
  let dimensions: Dimensions | undefined;
  let boxes = 0;
  while (offset + 8 <= file.size && boxes++ < 256) {
    const header = new Uint8Array(await file.slice(offset, offset + 16).arrayBuffer());
    const box = boxAt(header, 0, file.size - offset);
    if (box.kind === 'ftyp' || box.kind === 'meta') {
      if (box.end - box.start > MAX_METADATA_BYTES) invalidMetadata();
      const bytes = new Uint8Array(await file.slice(offset + box.start, offset + box.end).arrayBuffer());
      if (box.kind === 'ftyp') {
        if (bytes.length < 8 || bytes.length % 4 !== 0) invalidMetadata();
        for (let position = 0; position + 4 <= bytes.length; position += 4) {
          if (position === 4) continue;
          const brand = text(bytes, position, 4);
          if (brand === 'avif' || brand === 'avis') supported = true;
        }
        if (!supported) throw new Error('Unsupported input format. Choose a JPEG, PNG, WebP, or AVIF image.');
      } else {
        const visit = (start: number, end: number, depth: number): void => {
          if (depth > 4) invalidMetadata();
          while (start < end) {
            if (boxes++ >= 256) invalidMetadata();
            const child = boxAt(bytes, start, end);
            if (child.kind === 'iprp' || child.kind === 'ipco') {
              visit(child.start, child.end, depth + 1);
            } else if (child.kind === 'ispe') {
              if (child.end - child.start < 12) invalidMetadata();
              const data = view(bytes);
              const candidate = {
                width: data.getUint32(child.start + 4),
                height: data.getUint32(child.start + 8),
              };
              validateDimensions(candidate);
              if (!dimensions || candidate.width * candidate.height > dimensions.width * dimensions.height) {
                dimensions = candidate;
              }
            }
            start = child.end;
          }
        };
        if (bytes.length < 4 || bytes[0] !== 0) invalidMetadata();
        visit(4, bytes.length, 0);
      }
    }
    if (supported && dimensions) return dimensions;
    offset += box.end;
  }
  return invalidMetadata();
}

async function inspectImage(file: File): Promise<string> {
  if (!file || !Number.isFinite(file.size) || file.size <= 0) {
    throw new Error('The image file is empty or invalid.');
  }
  const bytes = new Uint8Array(await file.slice(0, MAX_METADATA_BYTES).arrayBuffer());
  let format: string;
  let dimensions: Dimensions;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    format = 'image/jpeg';
    dimensions = jpegDimensions(bytes);
  } else if (text(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') {
    if (bytes.length < 33 || text(bytes, 12, 4) !== 'IHDR' || view(bytes).getUint32(8) !== 13) {
      invalidMetadata();
    }
    format = 'image/png';
    dimensions = { width: view(bytes).getUint32(16), height: view(bytes).getUint32(20) };
  } else if (text(bytes, 0, 4) === 'RIFF' && text(bytes, 8, 4) === 'WEBP') {
    format = 'image/webp';
    dimensions = webpDimensions(bytes);
  } else if (text(bytes, 4, 4) === 'ftyp') {
    format = 'image/avif';
    dimensions = await avifDimensions(file);
  } else {
    throw new Error('Unsupported input format. Choose a JPEG, PNG, WebP, or AVIF image.');
  }
  validateDimensions(dimensions);
  return format;
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      bitmap = undefined;
    }
    if (bitmap) {
      const source = bitmap;
      return { source, width: source.width, height: source.height, release: () => source.close() };
    }
  }
  if (typeof Image === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('Cannot decode this image in this browser. Try another browser or image format.');
  }
  const image = new Image();
  const url = URL.createObjectURL(file);
  const release = () => {
    image.onload = null;
    image.onerror = null;
    image.removeAttribute('src');
    URL.revokeObjectURL(url);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Cannot decode the image. The file is damaged or unsupported by this browser.'));
      image.decoding = 'async';
      image.src = url;
    });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, release };
  } catch (error) {
    release();
    throw error;
  }
}

function encode(canvas: HTMLCanvasElement, format: OutputFormat, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (!blob || blob.size === 0) {
          reject(new Error('The browser could not encode the image. Try a smaller image.'));
        } else if (blob.type.toLowerCase() !== format) {
          reject(new Error(`This browser cannot encode ${format}. Choose another output format.`));
        } else {
          resolve(blob);
        }
      }, format, quality);
    } catch {
      reject(new Error('The browser could not encode the image. Check the image format and dimensions.'));
    }
  });
}

function validateSettings(settings: CompressionSettings): void {
  validateFormat(settings.format);
  if (!['size', 'quality', 'resize'].includes(settings.mode)) {
    throw new Error('Unsupported compression mode.');
  }
  if (!Number.isFinite(settings.quality) || settings.quality < 0 || settings.quality > 1) {
    throw new RangeError('Quality must be a finite number between 0 and 1.');
  }
  if (settings.mode === 'size' && (!Number.isFinite(settings.targetBytes) || settings.targetBytes < 1)) {
    throw new RangeError('The target size must be a finite number of at least 1 byte.');
  }
  if (settings.mode === 'resize') {
    positiveDimension(settings.maxWidth, 'Maximum width');
    positiveDimension(settings.maxHeight, 'Maximum height');
  }
}

export async function compressImage(file: File, settings: CompressionSettings): Promise<CompressionResult> {
  settings = { ...settings };
  validateSettings(settings);
  if (typeof document === 'undefined') {
    throw new Error('Image compression requires a browser with Canvas support.');
  }
  const inputFormat = await inspectImage(file);
  const image = await decodeImage(file);
  let canvas: HTMLCanvasElement | undefined;
  try {
    validateDimensions(image);
    const result = (blob: Blob, dimensions: Dimensions, quality: number): CompressionResult => ({
      blob,
      ...dimensions,
      quality,
      targetMet: settings.mode !== 'size' || blob.size <= settings.targetBytes,
    });
    let original: CompressionResult | undefined;
    if (settings.mode === 'size' && inputFormat === settings.format) {
      const blob = file.type === settings.format ? file : file.slice(0, file.size, settings.format);
      original = result(blob, { width: image.width, height: image.height }, 1);
      if (original.targetMet) return original;
    }
    canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The browser could not create a 2D canvas.');
    let dimensions = settings.mode === 'resize'
      ? fitDimensions(image.width, image.height, settings.maxWidth, settings.maxHeight)
      : { width: image.width, height: image.height };
    const render = () => {
      validateDimensions(dimensions);
      canvas!.width = dimensions.width;
      canvas!.height = dimensions.height;
      if (canvas!.width !== dimensions.width || canvas!.height !== dimensions.height) {
        throw new Error('The browser does not support the requested canvas dimensions.');
      }
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      if (settings.format === 'image/jpeg') {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, dimensions.width, dimensions.height);
      }
      try {
        context.drawImage(image.source, 0, 0, dimensions.width, dimensions.height);
      } catch {
        throw new Error('The browser could not draw the image. Try a smaller image.');
      }
    };
    const attempt = async (quality: number) => result(await encode(canvas!, settings.format, quality), dimensions, quality);
    render();
    if (settings.mode !== 'size') return await attempt(settings.quality);
    const search = async (): Promise<CompressionResult> => {
      const highest = await attempt(1);
      if (highest.targetMet || settings.format === 'image/png') return highest;
      const lowest = await attempt(0);
      if (!lowest.targetMet) return lowest.blob.size < highest.blob.size ? lowest : highest;
      let best = lowest;
      let low = 0;
      let high = 1;
      for (let step = 0; step < QUALITY_STEPS; step++) {
        const quality = (low + high) / 2;
        const candidate = await attempt(quality);
        if (candidate.targetMet) {
          best = candidate;
          low = quality;
        } else {
          high = quality;
        }
      }
      return best;
    };
    let current = await search();
    if (current.targetMet) return current;
    let smallest = original && original.blob.size < current.blob.size ? original : current;
    if (!settings.allowResize) return smallest;
    for (let step = 0; step < MAX_RESIZE_STEPS; step++) {
      if (dimensions.width === 1 && dimensions.height === 1) break;
      const scale = Math.max(0.25, Math.min(0.85, Math.sqrt(settings.targetBytes / current.blob.size) * 0.9));
      const next = fitDimensions(
        image.width,
        image.height,
        Math.max(1, Math.floor(dimensions.width * scale)),
        Math.max(1, Math.floor(dimensions.height * scale)),
      );
      if (next.width === dimensions.width && next.height === dimensions.height) break;
      dimensions = next;
      render();
      current = await search();
      if (current.targetMet) return current;
      if (current.blob.size < smallest.blob.size) smallest = current;
    }
    return smallest;
  } finally {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    image.release();
  }
}
