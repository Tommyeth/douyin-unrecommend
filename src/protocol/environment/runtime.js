// Bundled into QuickJS; this module never runs in the Worker host realm.
import * as DOM from 'linkedom/worker';

const call = (command) => {
  const result = JSON.parse(__canvasHost(JSON.stringify(command)));
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
const timers = new Map();
let timerId = 0,
  virtualTime = 0;
globalThis.setTimeout = (fn, delay = 0, ...args) => {
  if (timers.size >= 1024 || typeof fn !== 'function') throw new Error('timer budget');
  const id = ++timerId;
  timers.set(id, { fn, args, time: virtualTime + Math.max(0, Number(delay) || 0) });
  return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);
globalThis.__runTimers = () => {
  if (!timers.size) return;
  const next = Math.min(...[...timers.values()].map((t) => t.time));
  virtualTime = next;
  for (const [id, timer] of [...timers])
    if (timer.time <= next && timers.delete(id)) timer.fn(...timer.args);
};
globalThis.queueMicrotask = (fn) => Promise.resolve().then(fn);
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(virtualTime), 1000 / 60);
globalThis.cancelAnimationFrame = clearTimeout;

for (const [name, value] of Object.entries(DOM)) if (/^[A-Z]/.test(name)) globalThis[name] = value;
const { document } = DOM.parseHTML('<!doctype html><html><head></head><body></body></html>');
globalThis.document = document;
globalThis.window = globalThis.self = globalThis.top = globalThis.parent = globalThis;
Object.defineProperty(document, 'defaultView', { value: globalThis });
Object.defineProperty(document, 'readyState', { value: 'complete' });
Object.defineProperty(document, 'visibilityState', { value: 'visible' });
Object.defineProperty(document, 'hidden', { value: false });
const eventTarget = new DOM.EventTarget();
for (const name of ['addEventListener', 'removeEventListener', 'dispatchEvent'])
  globalThis[name] = eventTarget[name].bind(eventTarget);

class Storage {
  #items = new Map();
  get length() {
    return this.#items.size;
  }
  getItem(key) {
    return this.#items.get(String(key)) ?? null;
  }
  setItem(key, value) {
    if (this.#items.size >= 1024) throw Error('storage budget');
    this.#items.set(String(key), String(value));
  }
  removeItem(key) {
    this.#items.delete(String(key));
  }
  clear() {
    this.#items.clear();
  }
  key(index) {
    return [...this.#items.keys()][index] ?? null;
  }
}
globalThis.Storage = Storage;
globalThis.localStorage = new Storage();
globalThis.sessionStorage = new Storage();
const cookies = new Map();
Object.defineProperty(document, 'cookie', {
  get: () => [...cookies].map(([k, v]) => k + '=' + v).join('; '),
  set: (value) => {
    const [pair, ...attributes] = String(value).split(';');
    const at = pair.indexOf('=');
    if (at < 1) return;
    const key = pair.slice(0, at).trim(),
      val = pair.slice(at + 1);
    if (attributes.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a))) cookies.delete(key);
    else cookies.set(key, val);
  },
});

const resources = new WeakMap();
const contexts = new WeakMap();
function canvasId(canvas) {
  let record = resources.get(canvas);
  const width = Number(canvas.getAttribute('width') ?? 300),
    height = Number(canvas.getAttribute('height') ?? 150);
  if (!record || record.width !== width || record.height !== height) {
    if (record) call({ op: 'dispose', id: record.id });
    record = {
      id: call({ op: 'create', width: Math.max(1, width), height: Math.max(1, height) }),
      width,
      height,
      context: null,
    };
    resources.set(canvas, record);
  }
  return record;
}
function encodeArgument(value) {
  if (value instanceof DOM.HTMLCanvasElement) return { canvas: canvasId(value).id };
  if (value instanceof ImageData)
    return { width: value.width, height: value.height, data: Array.from(value.data) };
  if (value?.__reference) return { reference: value.__reference };
  return value;
}
class CanvasGradient {
  constructor(reference) {
    Object.defineProperty(this, '__reference', { value: reference });
  }
  addColorStop(offset, color) {
    return call({
      op: 'object',
      id: this.__reference,
      name: 'addColorStop',
      args: [offset, color],
    });
  }
}
class ImageData {
  constructor(data, width, height) {
    if (typeof data === 'number') {
      height = width;
      width = data;
      data = new Uint8ClampedArray(width * height * 4);
    }
    if (
      !(data instanceof Uint8ClampedArray) ||
      !Number.isInteger(width) ||
      width < 1 ||
      data.length % 4 ||
      data.length % (width * 4)
    )
      throw new TypeError('Invalid ImageData');
    height ??= data.length / (width * 4);
    if (width * height * 4 !== data.length) throw new TypeError('Invalid ImageData size');
    this.data = data;
    this.width = width;
    this.height = height;
    this.colorSpace = 'srgb';
  }
}
globalThis.ImageData = ImageData;
globalThis.CanvasGradient = CanvasGradient;
class Path2D {
  constructor(path) {
    const owner = canvasId(measurementCanvas).id;
    const result = call({ op: 'path', id: owner, path: typeof path === 'string' ? path : '' });
    Object.defineProperty(this, '__reference', { value: result.reference });
    if (path instanceof Path2D) this.addPath(path);
  }
}
for (const name of [
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
])
  Object.defineProperty(Path2D.prototype, name, {
    value: function (...args) {
      return call({ op: 'object', id: this.__reference, name, args: args.map(encodeArgument) });
    },
  });
globalThis.Path2D = Path2D;
class CanvasRenderingContext2D {
  constructor(canvas) {
    Object.defineProperty(this, 'canvas', { value: canvas });
  }
  createImageData(width, height) {
    if (typeof width === 'object') ({ width, height } = width);
    return new ImageData(width, height);
  }
  getContextAttributes() {
    return { alpha: true, colorSpace: 'srgb', desynchronized: false, willReadFrequently: false };
  }
}
const methods = [
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
];
for (const name of methods)
  Object.defineProperty(CanvasRenderingContext2D.prototype, name, {
    value: function (...args) {
      const result = call({
        op: 'call',
        id: canvasId(this.canvas).id,
        name,
        args: args.map(encodeArgument),
      });
      if (name === 'getImageData')
        return new ImageData(new Uint8ClampedArray(result.data), result.width, result.height);
      if (result?.reference) return new CanvasGradient(result.reference);
      return result;
    },
  });
for (const name of [
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
])
  Object.defineProperty(CanvasRenderingContext2D.prototype, name, {
    get() {
      return call({ op: 'get', id: canvasId(this.canvas).id, name });
    },
    set(value) {
      call({ op: 'set', id: canvasId(this.canvas).id, name, value: encodeArgument(value) });
    },
  });
globalThis.CanvasRenderingContext2D = CanvasRenderingContext2D;
for (const [name, initial] of [
  ['width', 300],
  ['height', 150],
])
  Object.defineProperty(DOM.HTMLCanvasElement.prototype, name, {
    get() {
      return Number(this.getAttribute(name) ?? initial);
    },
    set(value) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 2048) throw new RangeError('canvas dimensions');
      this.setAttribute(name, String(n));
      const old = resources.get(this);
      if (old) {
        call({ op: 'dispose', id: old.id });
        resources.delete(this);
      }
    },
  });
DOM.HTMLCanvasElement.prototype.getContext = function (kind) {
  if (kind !== '2d') return null; // A CPU renderer has no WebGL context. Never fabricate GPU pixels.
  canvasId(this);
  if (!contexts.has(this)) contexts.set(this, new CanvasRenderingContext2D(this));
  return contexts.get(this);
};
DOM.HTMLCanvasElement.prototype.toDataURL = function (type = 'image/png', quality) {
  if (!this.width || !this.height) return 'data:,';
  return call({ op: 'png', id: canvasId(this).id, type, quality });
};

const measurementCanvas = document.createElement('canvas');
measurementCanvas.width = 1;
measurementCanvas.height = 1;
const measurement = () => measurementCanvas.getContext('2d');
const defaults = {
  display: 'block',
  position: 'static',
  fontSize: '16px',
  fontFamily: 'Arimo',
  fontWeight: '400',
  fontStyle: 'normal',
  lineHeight: 'normal',
  boxSizing: 'content-box',
};
globalThis.getComputedStyle = function (element) {
  const parent = element.parentElement;
  const inherited = parent ? getComputedStyle(parent) : defaults;
  const rules = { ...defaults };
  for (const key of ['fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'lineHeight'])
    rules[key] = inherited[key];
  for (const style of document.querySelectorAll('style'))
    for (const match of style.textContent.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
      try {
        if (element.matches(match[1].trim())) {
          const temp = document.createElement('i');
          temp.style.cssText = match[2];
          for (let i = 0; i < temp.style.length; i++) {
            const key = temp.style[i];
            rules[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] =
              temp.style.getPropertyValue(key);
          }
        }
      } catch {}
    }
  return new Proxy(element.style, {
    get(target, key) {
      if (key === 'getPropertyValue')
        return (name) =>
          target.getPropertyValue(name) ||
          rules[name] ||
          rules[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ||
          '';
      if (key === 'getPropertyPriority') return target.getPropertyPriority.bind(target);
      const own = target[key];
      return own || rules[key] || '';
    },
  });
};
const px = (value, size = 16) =>
  typeof value === 'number'
    ? value
    : /em$/.test(value)
      ? parseFloat(value) * size
      : parseFloat(value) || 0;
function bounds(element, depth = 0) {
  if (depth > 64 || !element.isConnected) return { x: 0, y: 0, width: 0, height: 0 };
  const s = getComputedStyle(element);
  if (s.display === 'none') return { x: 0, y: 0, width: 0, height: 0 };
  const fontSize = px(s.fontSize) || 16,
    ctx = measurement();
  ctx.font = `${s.fontStyle} ${s.fontWeight} ${fontSize}px ${s.fontFamily}`;
  const textWidth = ctx.measureText(element.textContent || '').width;
  let width = s.width && s.width !== 'auto' ? px(s.width, fontSize) : textWidth;
  let height = s.height && s.height !== 'auto' ? px(s.height, fontSize) : fontSize * 1.2;
  if (s.boxSizing !== 'border-box') {
    width +=
      px(s.paddingLeft) + px(s.paddingRight) + px(s.borderLeftWidth) + px(s.borderRightWidth);
    height +=
      px(s.paddingTop) + px(s.paddingBottom) + px(s.borderTopWidth) + px(s.borderBottomWidth);
  }
  const parent = element.parentElement;
  const p =
    parent && parent !== element.ownerDocument.documentElement
      ? bounds(parent, depth + 1)
      : { x: 0, y: 0 };
  return { x: p.x + px(s.left), y: p.y + px(s.top), width, height };
}
DOM.Element.prototype.getBoundingClientRect = function () {
  const b = bounds(this);
  return {
    ...b,
    top: b.y,
    left: b.x,
    right: b.x + b.width,
    bottom: b.y + b.height,
    toJSON() {
      return { ...b };
    },
  };
};
DOM.Element.prototype.getClientRects = function () {
  return this.isConnected ? [this.getBoundingClientRect()] : [];
};
for (const [name, axis] of [
  ['offsetWidth', 'width'],
  ['offsetHeight', 'height'],
  ['clientWidth', 'width'],
  ['clientHeight', 'height'],
])
  Object.defineProperty(DOM.HTMLElement.prototype, name, {
    get() {
      return Math.round(bounds(this)[axis]);
    },
  });
Object.defineProperty(DOM.HTMLElement.prototype, 'offsetParent', {
  get() {
    return this.isConnected ? this.parentElement : null;
  },
});

const fontFamilies = new Set([
  'arimo',
  'tinos',
  'cousine',
  'arial',
  'times new roman',
  'courier new',
  'sans-serif',
  'serif',
  'monospace',
]);
document.fonts = {
  status: 'loaded',
  ready: Promise.resolve(),
  check(value) {
    const family = String(value)
      .replace(/^.*?\d+(?:\.\d+)?px\s+/, '')
      .replaceAll('"', '')
      .replaceAll("'", '')
      .toLowerCase();
    return fontFamilies.has(family);
  },
  load(value) {
    return Promise.resolve(this.check(value) ? [value] : []);
  },
};

globalThis.navigator = {
  userAgent: P.ua,
  platform: 'Win32',
  vendor: 'Google Inc.',
  vendorSub: '',
  productSub: '20030107',
  language: 'zh-CN',
  languages: ['zh-CN'],
  hardwareConcurrency: 8,
  deviceMemory: 8,
  maxTouchPoints: 0,
  cookieEnabled: true,
  webdriver: false,
  pdfViewerEnabled: true,
  doNotTrack: null,
};
globalThis.screen = {
  width: 1920,
  height: 1080,
  availWidth: 1920,
  availHeight: 1032,
  availLeft: 0,
  availTop: 0,
  colorDepth: 24,
  pixelDepth: 24,
};
Object.assign(globalThis, {
  devicePixelRatio: 1,
  innerWidth: 1920,
  innerHeight: 855,
  outerWidth: 1920,
  outerHeight: 1032,
});
globalThis.location = {
  href: 'https://www.douyin.com/',
  origin: 'https://www.douyin.com',
  protocol: 'https:',
  host: 'www.douyin.com',
  hostname: 'www.douyin.com',
  pathname: '/',
  search: '',
  hash: '',
};
globalThis.performance = { now: () => virtualTime, timeOrigin: Date.now() };
globalThis.crypto = {
  getRandomValues(array) {
    const bytes = JSON.parse(__randomBytes(array.byteLength));
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes);
    return array;
  },
};
globalThis.matchMedia = (query) => ({
  matches: [
    '(color-gamut: srgb)',
    '(prefers-reduced-motion: no-preference)',
    '(prefers-contrast: no-preference)',
    '(forced-colors: none)',
    '(inverted-colors: none)',
    '(min-monochrome: 0)',
  ].includes(String(query).replace(/\s+/g, ' ')),
  media: String(query),
});
globalThis.console = { log() {}, warn() {}, error() {}, info() {}, debug() {}, trace() {} };
globalThis.module = { exports: {} };
globalThis.exports = module.exports;
globalThis.__runEntry = () => {
  const mod =
    typeof module.exports === 'function' || Object.keys(module.exports).length
      ? module.exports
      : globalThis.__p_ch;
  const entry =
    typeof mod === 'function' ? mod : mod && (mod.default || mod.getData || mod.get || mod.rs);
  if (typeof entry !== 'function') throw Error('missing challenge entry');
  globalThis.__challengeResult = null;
  globalThis.__challengeError = false;
  Promise.resolve()
    .then(() => entry())
    .then((r) => {
      globalThis.__challengeResult = r;
    })
    .catch(() => {
      globalThis.__challengeError = true;
    });
};
