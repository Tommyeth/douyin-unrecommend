declare module '*canvaskit.cjs' {
  import type { CanvasKit } from 'canvaskit-wasm';
  const init: (options?: { wasmModule?: WebAssembly.Module }) => Promise<CanvasKit>;
  export default init;
}
