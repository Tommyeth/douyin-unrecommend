// Adapted from yunsur/douyin-mcp challenge_template_runner.js (MIT).
// Copyright (c) 2026 Yunsur. This text runs only inside an isolated QuickJS VM.
export const environment = String.raw`const timers = new Map(); let nextTimer = 0;
function setTimeout(fn, ms, ...args) { const id=++nextTimer; timers.set(id, () => fn(...args)); return id; }
function clearTimeout(id) { timers.delete(id); }
function __runTimers() { const jobs=[...timers]; timers.clear(); for(const [,fn] of jobs) fn(); }
function __randomFill(a) { const x=JSON.parse(__randomBytes(a.byteLength)); new Uint8Array(a.buffer,a.byteOffset,a.byteLength).set(x); return a; }
// ---------- 最小 DOM / BOM ----------
function makeCanvas() {
  return {
    width: 0, height: 0,
    getContext(kind) {
      if (kind === '2d') {
        return {
          canvas: this,
          fillStyle: '', font: '', textBaseline: '',
          rect() {}, fillRect() {}, fillText() {}, strokeText() {},
          beginPath() {}, arc() {}, closePath() {}, fill() {}, stroke() {},
          isPointInPath: () => true,
          measureText: (s) => ({ width: (s || '').length * 7.5 }),
          getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        };
      }
      // webgl
      const GL = {
        UNMASKED_VENDOR_WEBGL: 0x9245,
        UNMASKED_RENDERER_WEBGL: 0x9246,
      };
      return {
        canvas: this,
        ...GL,
        getExtension: (n) => (n === 'WEBGL_debug_renderer_info' ? GL : null),
        getParameter: (p) => {
          if (p === GL.UNMASKED_VENDOR_WEBGL) return P.webgl_vendor;
          if (p === GL.UNMASKED_RENDERER_WEBGL) return P.webgl_renderer;
          return null;
        },
        getSupportedExtensions: () => P.webgl_extensions || [],
        createBuffer: () => ({}), bindBuffer() {}, bufferData() {},
        createProgram: () => ({}), createShader: () => ({}),
        shaderSource() {}, compileShader() {}, attachShader() {},
        linkProgram() {}, useProgram() {},
        getAttribLocation: () => 0, getUniformLocation: () => ({}),
        enableVertexAttribArray() {}, vertexAttribPointer() {},
        uniform2f() {}, drawArrays() {}, viewport() {}, clearColor() {}, clear() {},
        readPixels: (x, y, w, h, f, t, px) => { if (px) px.fill(0); },
      };
    },
    toDataURL: () => P.canvas_data_url || 'data:image/png;base64,',
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
    style: {},
  };
}

function container() {
 const children = new Set();
 return { style: {}, appendChild(node) { children.add(node); return node; }, removeChild(node) { children.delete(node); return node; }, contains(node) { return children.has(node); } };
}
const documentStub = {
  createElement: (tag) => {
    if (tag === 'canvas') return makeCanvas();
    return {
      style: {}, appendChild() {}, removeChild() {}, setAttribute() {},
      getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
      offsetWidth: 0, offsetHeight: 0,
    };
  },
  documentElement: container(),
  body: container(),
  head: container(),
  cookie: '',
  fonts: { check: () => true, ready: Promise.resolve(), load: () => Promise.resolve([]) },
  write() {}, open() {}, close() {},
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};

const navigatorStub = {
  userAgent: P.ua,
  platform: 'Win32',
  vendor: 'Google Inc.',
  vendorSub: '',
  productSub: '20030107',
  language: 'zh-CN',
  languages: P.languages || ['zh-CN', 'zh', 'en', 'zh-TW', 'ja'],
  hardwareConcurrency: P.cpu_core_num,
  deviceMemory: P.device_memory,
  maxTouchPoints: 0,
  cookieEnabled: true,
  webdriver: false,
  pdfViewerEnabled: true,
  doNotTrack: null,
  plugins: { length: 5 },
  mimeTypes: { length: 2 },
  userAgentData: {
    brands: [{ brand: 'Chromium', version: String(P.browser_major || 151) }],
    mobile: false, platform: 'Windows',
    getHighEntropyValues: () => Promise.resolve({ architecture: 'x86', bitness: '64' }),
  },
};

const screenStub = {
  width: P.screen_width, height: P.screen_height,
  availWidth: P.avail_width, availHeight: P.avail_height,
  availTop: 0, availLeft: 0,
  colorDepth: 24, pixelDepth: 24,
};

// matchMedia：colorGamut / forcedColors / monochrome / contrast / hdr / reducedMotion
function matchMedia(q) {
  const truthy = [
    '(color-gamut: srgb)',
    '(dynamic-range: standard)',
    '(prefers-reduced-motion: no-preference)',
    '(prefers-reduced-transparency: no-preference)',
    '(prefers-contrast: no-preference)',
    '(forced-colors: none)',
    '(inverted-colors: none)',
    '(min-monochrome: 0)',
  ];
  return { matches: truthy.some((t) => q.replace(/\s+/g, ' ').includes(t.replace(/\s+/g, ' '))), media: q };
}

const windowStub = {
  document: documentStub,
  navigator: navigatorStub,
  screen: screenStub,
  matchMedia,
  location: { href: 'https://www.douyin.com/', origin: 'https://www.douyin.com', protocol: 'https:', host: 'www.douyin.com' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {}, length: 0 },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {}, length: 0 },
  indexedDB: {},
  openDatabase: undefined,
  devicePixelRatio: 1,
  innerWidth: P.inner_width, innerHeight: P.inner_height,
  outerWidth: P.outer_width, outerHeight: P.outer_height,
  performance: { now: () => Date.now() % 100000, timeOrigin: Date.now() },
  crypto: { getRandomValues: (a) => __randomFill(a), subtle: {} },
  Intl: { DateTimeFormat: function() { return { resolvedOptions: () => ({ timeZone: 'Asia/Shanghai' }) }; } },
  addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout,
  Promise, Date, Math, JSON, Array, Object, String, Number, Boolean, RegExp, Error, TypeError,
  Uint8Array, Uint8ClampedArray, Int32Array, Float32Array, Float64Array, ArrayBuffer,
  Map, Set, Symbol, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent, btoa, atob,
};
windowStub.window = windowStub;
windowStub.self = windowStub;
windowStub.top = windowStub;
// 模块内部有 \`window.console\` / 裸 \`console\` 两种取法，两处都要有
windowStub.console = { log() {}, warn() {}, error() {}, info() {}, debug() {}, trace() {} };


Object.assign(globalThis,windowStub);
globalThis.module={exports:{}}; globalThis.exports=module.exports;
globalThis.__runEntry = () => {
 const mod = typeof module.exports==='function' || Object.keys(module.exports).length ? module.exports : globalThis.__p_ch || windowStub.__p_ch;
 const entry = typeof mod==='function' ? mod : mod && (mod.default || mod.getData || mod.get || mod.rs);
 if(typeof entry!=='function')throw Error('missing challenge entry');
 globalThis.__challengeResult=null; globalThis.__challengeError=false;
 Promise.resolve().then(()=>entry()).then(r=>{globalThis.__challengeResult=r;}).catch(()=>{globalThis.__challengeError=true;});
};
`;
