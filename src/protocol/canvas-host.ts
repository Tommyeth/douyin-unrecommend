import CanvasKitInit from '../generated/canvaskit.cjs';
import type { CanvasKit, EmulatedCanvas2D } from 'canvaskit-wasm';
import { fonts } from '../generated/environment-assets.js';

let wasm: WebAssembly.Module | undefined;
let engine: Promise<CanvasKit> | undefined;
export function configureCanvasWasm(value: WebAssembly.Module) {
  wasm = value;
  // Emscripten's Node detection is active under nodejs_compat; wasmModule avoids file reads.
  (globalThis as any).__dirname ??= '/';
}
async function canvasKit() {
  engine ??= CanvasKitInit({ wasmModule: wasm }).then((ck) => {
    // Keep registered typefaces alive for the lifetime of CanvasKit's global font registry.
    const owner = ck.MakeCanvas(1, 1);
    for (const font of fonts)
      owner.loadFont(Buffer.from(font.data, 'base64'), { family: font.family });
    return ck;
  });
  return engine;
}
const methods = new Set([
  'save',
  'restore',
  'resetTransform',
  'setTransform',
  'transform',
  'translate',
  'rotate',
  'scale',
  'clearRect',
  'fillRect',
  'strokeRect',
  'beginPath',
  'closePath',
  'moveTo',
  'lineTo',
  'bezierCurveTo',
  'quadraticCurveTo',
  'arc',
  'arcTo',
  'ellipse',
  'rect',
  'fill',
  'stroke',
  'clip',
  'isPointInPath',
  'isPointInStroke',
  'fillText',
  'strokeText',
  'measureText',
  'setLineDash',
  'getLineDash',
  'getImageData',
  'putImageData',
  'createLinearGradient',
  'createRadialGradient',
  'createPattern',
  'drawImage',
]);
const properties = new Set([
  'fillStyle',
  'strokeStyle',
  'globalAlpha',
  'globalCompositeOperation',
  'lineWidth',
  'lineCap',
  'lineJoin',
  'miterLimit',
  'lineDashOffset',
  'shadowBlur',
  'shadowColor',
  'shadowOffsetX',
  'shadowOffsetY',
  'font',
  'textAlign',
  'textBaseline',
  'direction',
  'imageSmoothingEnabled',
  'imageSmoothingQuality',
]);
type Surface = {
  canvas: EmulatedCanvas2D;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
};

// Only numeric handles and JSON values cross the VM boundary. No host object is exposed.
export class CanvasHost {
  private surfaces = new Map<number, Surface>();
  private objects = new Map<number, any>();
  private next = 0;
  private operations = 0;
  private pixels = 0;
  private imagePixels = 0;
  private images = 0;
  private constructor(private ck: CanvasKit) {}
  static async create() {
    return new CanvasHost(await canvasKit());
  }
  private reference(value: any) {
    const id = ++this.next;
    if (this.objects.size >= 128) throw Error('canvas object budget');
    this.objects.set(id, value);
    return { reference: id };
  }
  private argument(value: any): any {
    if (value && typeof value === 'object' && 'reference' in value) {
      if (!this.objects.has(value.reference)) throw Error('invalid canvas reference');
      return this.objects.get(value.reference);
    }
    if (value && typeof value === 'object' && 'canvas' in value) {
      const surface = this.surfaces.get(value.canvas);
      if (!surface) throw Error('invalid canvas');
      // decodeImage retains its native image until the owning canvas is disposed.
      // Bound cumulative decoding even if the same canvas is drawn repeatedly.
      if (++this.images > 128 || (this.imagePixels += surface.width * surface.height) > 2_097_152)
        throw Error('decoded image budget');
      return surface.canvas.decodeImage(
        Buffer.from(surface.canvas.toDataURL().split(',')[1], 'base64'),
      );
    }
    return value;
  }
  dispatch(serialized: string): string {
    try {
      if (serialized.length > 2_000_000 || ++this.operations > 20000)
        throw Error('canvas operation budget');
      const command = JSON.parse(serialized);
      const { op, id, name } = command;
      let result: any;
      if (op === 'create') {
        const width = Number(command.width),
          height = Number(command.height);
        if (
          ![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 2048) ||
          width * height > 1_048_576 ||
          this.pixels + width * height > 2_097_152 ||
          this.surfaces.size >= 16
        )
          throw Error('canvas size budget');
        const canvas = this.ck.MakeCanvas(width, height);
        if (!canvas) throw Error('canvas allocation');
        const ctx = canvas.getContext('2d')!;
        ctx.font = '10px Arimo';
        const handle = ++this.next;
        this.surfaces.set(handle, { canvas, ctx, width, height });
        this.pixels += width * height;
        result = handle;
      } else if (op === 'dispose') {
        const surface = this.surfaces.get(id);
        if (surface) {
          surface.canvas.dispose();
          this.pixels -= surface.width * surface.height;
          this.surfaces.delete(id);
        }
      } else if (op === 'object') {
        const object = this.objects.get(id);
        if (
          !object ||
          ![
            'addColorStop',
            'setTransform',
            'addPath',
            'moveTo',
            'lineTo',
            'bezierCurveTo',
            'quadraticCurveTo',
            'arc',
            'arcTo',
            'ellipse',
            'rect',
            'closePath',
          ].includes(name) ||
          typeof object[name] !== 'function'
        )
          throw Error('invalid object operation');
        object[name](...(command.args || []).map((a: any) => this.argument(a)));
      } else {
        const surface = this.surfaces.get(id);
        if (!surface) throw Error('invalid canvas');
        const ctx = surface.ctx as any;
        if (op === 'get' && properties.has(name))
          result = typeof ctx[name] === 'object' ? undefined : ctx[name];
        else if (op === 'set' && properties.has(name)) ctx[name] = this.argument(command.value);
        else if (op === 'png') result = surface.canvas.toDataURL(command.type, command.quality);
        else if (op === 'path')
          result = this.reference(surface.canvas.makePath2D(command.path || ''));
        else if (op === 'call' && methods.has(name)) {
          const args = (command.args || []).map((a: any) => this.argument(a));
          if (name === 'getImageData') {
            if (
              !args.every((v: unknown) => typeof v === 'number' && Number.isFinite(v)) ||
              Math.abs(args[2] * args[3]) > 65536
            )
              throw Error('pixel read budget');
          }
          if (name === 'putImageData')
            args[0] = { ...args[0], data: new Uint8ClampedArray(args[0].data) };
          if (
            name === 'isPointInPath' &&
            (args.length === 2 || (args.length === 3 && typeof args[0] !== 'number'))
          )
            args.push('nonzero');
          result = ctx[name](...args);
          if (name === 'getImageData')
            result = {
              width: result.width,
              height: result.height,
              data: Array.from(result.data),
            };
          else if (name === 'measureText') result = { width: result.width };
          else if (['createLinearGradient', 'createRadialGradient', 'createPattern'].includes(name))
            result = this.reference(result);
        } else throw Error('unsupported canvas operation');
      }
      return JSON.stringify({ ok: true, value: result });
    } catch {
      // Never return engine internals, platform paths, or upstream values into diagnostics.
      return JSON.stringify({
        ok: false,
        error: 'Canvas operation unsupported or resource limit exceeded',
      });
    }
  }
  dispose() {
    for (const object of this.objects.values()) object?.delete?.();
    this.objects.clear();
    for (const { canvas } of this.surfaces.values()) canvas.dispose();
    this.surfaces.clear();
  }
}
