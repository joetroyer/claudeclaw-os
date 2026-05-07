#!/usr/bin/env node
/**
 * Slice 7 — Avatar generator CLI.
 *
 * Generates a 1024x1024 PNG avatar for a new agent. Uses the same image-gen
 * path the rest of the codebase already established in scripts/gen-agent-avatars.ts:
 * @google/genai with `gemini-3-pro-image-preview`. No new dependency.
 *
 * Behaviour:
 *   - If GOOGLE_API_KEY is set → calls Gemini, writes the returned PNG.
 *   - If unset OR the API call throws OR returns no inlineData → writes
 *     a deterministic placeholder PNG so the rest of the slice can ship.
 *     The placeholder is a small, valid PNG containing the agent's
 *     initials on a colored background, generated with a hand-rolled
 *     PNG encoder (no canvas dep, no node-canvas).
 *
 * Usage:
 *   node dist/agent-gen-avatar.js \
 *     --slug deliverability-expert \
 *     --display-name "Deliverability Expert" \
 *     --description "Inbox placement specialist" \
 *     --out /path/to/avatar.png \
 *     [--style photorealistic | pop-art] \
 *     [--placeholder]   # force placeholder, skip API call
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_FILE);
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

interface CliArgs {
  slug?: string;
  displayName?: string;
  description?: string;
  out?: string;
  style?: 'photorealistic' | 'pop-art';
  placeholder?: boolean;
  help?: boolean;
}

function usage(): void {
  console.log(`Usage: agent-gen-avatar --slug SLUG --display-name NAME --description DESC --out PATH [options]

Required:
  --slug SLUG              Agent slug (used in placeholder PNG)
  --display-name NAME      Display name (used in placeholder PNG)
  --description DESC       One-line agent description (fed into the image prompt)
  --out PATH               Output PNG path (parent dir created if missing)

Optional:
  --style STYLE            "photorealistic" (default) or "pop-art"
  --placeholder            Skip the API call and write the deterministic placeholder
  --help                   Show this help`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (arg === '--placeholder') { args.placeholder = true; continue; }
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const val = argv[++i];
    switch (key) {
      case 'slug': args.slug = val; break;
      case 'display-name': args.displayName = val; break;
      case 'description': args.description = val; break;
      case 'out': args.out = val; break;
      case 'style':
        if (val !== 'photorealistic' && val !== 'pop-art') {
          console.error(`error: invalid --style ${val}`); process.exit(1);
        }
        args.style = val;
        break;
      default: console.error(`unknown flag: ${arg}`); process.exit(1);
    }
  }
  return args;
}

function readEnvKey(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(envPath)) return undefined;
  const text = fs.readFileSync(envPath, 'utf-8');
  for (const line of text.split('\n')) {
    const m = line.match(new RegExp(`^${key}=(.*)$`));
    if (m) return m[1].replace(/^"|"$/g, '');
  }
  return undefined;
}

function buildPrompt(displayName: string, description: string, style: 'photorealistic' | 'pop-art'): string {
  if (style === 'pop-art') {
    return `Create a bold pop-art comic book style square profile picture avatar for an AI agent called "${displayName.toUpperCase()}".
Style: Retro 1960s Roy Lichtenstein pop art with ben-day dots, thick black outlines, vivid flat colors.
Character: Inspired by this role: ${description}. Confident, focused expression.
Background: Vibrant saturated color with geometric shapes.
Text: The word "${displayName.toUpperCase()}" in massive bold block letters across the top, white with black outline.
Square format. No speech bubbles.`;
  }
  return `Create a photorealistic square portrait headshot for a professional AI agent named "${displayName}".
Role: ${description}.
Style: studio-lit photorealistic portrait, neutral solid-color background, sharp focus, eye contact, friendly but focused expression. The subject should look like a real person — natural skin, real lighting, plausible clothing for the profession. Square 1:1 framing, head and shoulders.
No text, no logos, no watermark.`;
}

interface AvatarResult {
  ok: boolean;
  source: 'gemini' | 'placeholder';
  bytes: number;
  outPath: string;
  reason?: string;
}

async function tryGenerateWithGemini(
  apiKey: string,
  prompt: string,
  outPath: string,
): Promise<AvatarResult | null> {
  // Lazy-import @google/genai so the placeholder path stays dependency-free
  // when the package isn't installed in some runtime context.
  let GoogleGenAIModule: any;
  try {
    GoogleGenAIModule = await import('@google/genai');
  } catch (err) {
    return { ok: false, source: 'placeholder', bytes: 0, outPath, reason: '@google/genai not importable' };
  }
  const { GoogleGenAI } = GoogleGenAIModule;
  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-image-preview',
      contents: prompt,
      config: { responseModalities: ['TEXT', 'IMAGE'] },
    });
    const parts = response?.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.inlineData && part.inlineData.data) {
        const buf = Buffer.from(part.inlineData.data, 'base64');
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, buf);
        return { ok: true, source: 'gemini', bytes: buf.length, outPath };
      }
    }
    return { ok: false, source: 'placeholder', bytes: 0, outPath, reason: 'gemini returned no inline image data' };
  } catch (err) {
    return {
      ok: false, source: 'placeholder', bytes: 0, outPath,
      reason: `gemini call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Hand-rolled PNG placeholder ─────────────────────────────────────────
//
// Writes a 256x256 PNG with a solid background and the agent's initials
// drawn as block letters from a tiny built-in 5x7 bitmap font. No
// runtime dep: just zlib + manual chunking.

const FONT_5x7: Record<string, string[]> = {
  'A': ['01110','10001','10001','11111','10001','10001','10001'],
  'B': ['11110','10001','10001','11110','10001','10001','11110'],
  'C': ['01110','10001','10000','10000','10000','10001','01110'],
  'D': ['11110','10001','10001','10001','10001','10001','11110'],
  'E': ['11111','10000','10000','11110','10000','10000','11111'],
  'F': ['11111','10000','10000','11110','10000','10000','10000'],
  'G': ['01110','10001','10000','10111','10001','10001','01110'],
  'H': ['10001','10001','10001','11111','10001','10001','10001'],
  'I': ['11111','00100','00100','00100','00100','00100','11111'],
  'J': ['00111','00010','00010','00010','00010','10010','01100'],
  'K': ['10001','10010','10100','11000','10100','10010','10001'],
  'L': ['10000','10000','10000','10000','10000','10000','11111'],
  'M': ['10001','11011','10101','10101','10001','10001','10001'],
  'N': ['10001','11001','10101','10011','10001','10001','10001'],
  'O': ['01110','10001','10001','10001','10001','10001','01110'],
  'P': ['11110','10001','10001','11110','10000','10000','10000'],
  'Q': ['01110','10001','10001','10001','10101','10010','01101'],
  'R': ['11110','10001','10001','11110','10100','10010','10001'],
  'S': ['01111','10000','10000','01110','00001','00001','11110'],
  'T': ['11111','00100','00100','00100','00100','00100','00100'],
  'U': ['10001','10001','10001','10001','10001','10001','01110'],
  'V': ['10001','10001','10001','10001','10001','01010','00100'],
  'W': ['10001','10001','10001','10101','10101','10101','01010'],
  'X': ['10001','10001','01010','00100','01010','10001','10001'],
  'Y': ['10001','10001','10001','01010','00100','00100','00100'],
  'Z': ['11111','00001','00010','00100','01000','10000','11111'],
  '?': ['01110','10001','00001','00010','00100','00000','00100'],
};

function colorForSlug(slug: string): [number, number, number] {
  // Deterministic color: stable per slug, distinct enough across the team.
  const hash = crypto.createHash('sha256').update(slug).digest();
  // Pull HSV-like variation from the hash, convert to a vivid RGB.
  const h = hash[0] / 255;
  const s = 0.55 + (hash[1] / 255) * 0.20; // 55–75%
  const v = 0.55 + (hash[2] / 255) * 0.20; // 55–75%
  return hsvToRgb(h, s, v);
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0, g = 0, b = 0;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function getInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

function makePlaceholderPng(displayName: string, slug: string): Buffer {
  const W = 256;
  const H = 256;
  const [br, bg, bb] = colorForSlug(slug);
  const pixels = Buffer.alloc(W * H * 3);
  // Fill background.
  for (let i = 0; i < W * H; i++) {
    pixels[i * 3 + 0] = br;
    pixels[i * 3 + 1] = bg;
    pixels[i * 3 + 2] = bb;
  }
  // Draw initials in white. 5x7 font scaled to 14x (= 70x98 per glyph),
  // gap of 1*14 = 14 between glyphs. For 2 glyphs: 70+14+70 = 154 wide,
  // 98 tall. Center on canvas.
  const initials = getInitials(displayName);
  const scale = 14;
  const glyphW = 5 * scale;
  const glyphH = 7 * scale;
  const gap = 1 * scale;
  const totalW = initials.length * glyphW + (initials.length - 1) * gap;
  const startX = Math.floor((W - totalW) / 2);
  const startY = Math.floor((H - glyphH) / 2);

  for (let charIdx = 0; charIdx < initials.length; charIdx++) {
    const ch = initials[charIdx].toUpperCase();
    const glyph = FONT_5x7[ch] || FONT_5x7['?'];
    const ox = startX + charIdx * (glyphW + gap);
    for (let row = 0; row < 7; row++) {
      const rowStr = glyph[row];
      for (let col = 0; col < 5; col++) {
        if (rowStr[col] !== '1') continue;
        // Fill scale x scale pixel block.
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const x = ox + col * scale + dx;
            const y = startY + row * scale + dy;
            const idx = (y * W + x) * 3;
            pixels[idx + 0] = 255;
            pixels[idx + 1] = 255;
            pixels[idx + 2] = 255;
          }
        }
      }
    }
  }
  return encodePng(W, H, pixels);
}

function crc32(buf: Buffer): number {
  let c: number;
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'binary');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crcBuf]);
}

function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: truecolor RGB
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  // IDAT: per scanline, prepend filter byte 0 (None)
  const stride = width * 3;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0;
    rgb.copy(filtered, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(filtered, { level: 9 });
  // IEND
  const iend = Buffer.alloc(0);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', iend),
  ]);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help) { usage(); process.exit(0); }
  if (!args.slug) { console.error('error: --slug required'); process.exit(1); }
  if (!args.displayName) { console.error('error: --display-name required'); process.exit(1); }
  if (!args.description) { console.error('error: --description required'); process.exit(1); }
  if (!args.out) { console.error('error: --out required'); process.exit(1); }

  const style = args.style ?? 'photorealistic';
  const outPath = args.out;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  if (!args.placeholder) {
    const apiKey = readEnvKey('GOOGLE_API_KEY');
    if (apiKey) {
      const prompt = buildPrompt(args.displayName, args.description, style);
      const result = await tryGenerateWithGemini(apiKey, prompt, outPath);
      if (result && result.ok) {
        console.log(JSON.stringify({ ...result, prompt }, null, 2));
        return;
      }
      console.error(`gemini path unavailable, falling back to placeholder: ${result?.reason ?? 'unknown'}`);
    } else {
      console.error('GOOGLE_API_KEY not set; falling back to placeholder PNG');
    }
  }

  const png = makePlaceholderPng(args.displayName, args.slug);
  fs.writeFileSync(outPath, png);
  console.log(JSON.stringify({
    ok: true,
    source: 'placeholder',
    bytes: png.length,
    outPath,
    initials: getInitials(args.displayName),
  }, null, 2));
}

main().catch((err) => {
  console.error('agent-gen-avatar failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
