import baseVariant from '@jitl/quickjs-wasmfile-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import { SafeError } from '../types.js';
import { environment } from './challenge-environment.js';
import { UA } from './sign.js';

let wasm: WebAssembly.Module | undefined;
export function configureChallengeWasm(module: WebAssembly.Module) {
  wasm = module;
}
let engine: Promise<QuickJSWASMModule> | undefined;
export async function runChallenge(template: string) {
  if (template.length > 500000)
    throw new SafeError('LOGIN_CHALLENGE', '登录环境脚本过大，已停止。');
  engine ??= newQuickJSWASMModuleFromVariant(
    wasm ? newVariant(baseVariant, { wasmModule: wasm }) : baseVariant,
  );
  const vm = (await engine).newContext();
  let interrupts = 0;
  vm.runtime.setMemoryLimit(32 * 1024 * 1024);
  vm.runtime.setMaxStackSize(512 * 1024);
  // An instruction budget works even when a Worker clock does not advance during CPU work.
  vm.runtime.setInterruptHandler(() => ++interrupts > 2000);
  const install = (name: string, fn: (value: string) => string) => {
    // QuickJS's C-string bridge truncates NUL bytes. Transfer JSON text in both directions.
    const handle = vm.newFunction(name, (arg) =>
      vm.newString(JSON.stringify(fn(JSON.parse(vm.getString(arg))))),
    );
    vm.setProp(vm.global, '__host_' + name, handle);
    handle.dispose();
    const wrapper = vm.evalCode(
      `globalThis.${name}=value=>JSON.parse(__host_${name}(JSON.stringify(String(value))))`,
    );
    wrapper.dispose();
  };
  const evalText = (code: string, read = false) => {
    const r = vm.evalCode(code);
    if (r.error) {
      r.error.dispose();
      throw new SafeError('LOGIN_CHALLENGE', '登录环境校验脚本执行失败。');
    }
    const value = read ? vm.dump(r.value) : undefined;
    r.value.dispose();
    return value;
  };
  try {
    install('btoa', (value) => Buffer.from(value, 'latin1').toString('base64'));
    install('atob', (value) => Buffer.from(value, 'base64').toString('latin1'));
    install('__randomBytes', (value) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 65536) throw Error('random limit');
      return JSON.stringify([...crypto.getRandomValues(new Uint8Array(n))]);
    });
    evalText(
      `const P=${JSON.stringify({ ua: UA, browser_major: 151, cpu_core_num: 8, device_memory: 8, screen_width: 1920, screen_height: 1080, avail_width: 1920, avail_height: 1032, inner_width: 1920, inner_height: 855, outer_width: 1920, outer_height: 1032, webgl_vendor: 'Google Inc. (Intel)', webgl_renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)', languages: ['zh-CN', 'zh', 'en', 'zh-TW', 'ja'] })};\n${environment}`,
    );
    evalText(template);
    evalText('__runEntry()');
    for (let i = 0; i < 100; i++) {
      const jobs = vm.runtime.executePendingJobs(100);
      if (jobs.error) {
        jobs.error.dispose();
        throw new SafeError('LOGIN_CHALLENGE', '登录环境校验异步执行失败。');
      }
      if (evalText('Boolean(__challengeError)', true))
        throw new SafeError('LOGIN_CHALLENGE', '登录环境校验未完成。');
      const serialized = evalText(
        `(() => {
        const r=__challengeResult;
        if(!r)return '';
        if(typeof r.p_in!=='string'||!r.p_in.length||r.p_in.length>=10000)throw Error('invalid result');
        if(r.e_in && (typeof r.e_in!=='object'||Array.isArray(r.e_in)))throw Error('invalid environment');
        const text=JSON.stringify({p_in:r.p_in,e_in:r.e_in});
        if(text.length>20000)throw Error('result too large');
        return text;
      })()`,
        true,
      );
      if (serialized)
        return JSON.parse(serialized) as { p_in: string; e_in?: Record<string, unknown> };
      evalText('__runTimers()');
    }
    throw new SafeError('LOGIN_CHALLENGE', '登录环境校验超出执行预算。');
  } catch (e) {
    if (e instanceof SafeError) throw e;
    throw new SafeError('LOGIN_CHALLENGE', '登录环境脚本引擎失败，已停止。');
  } finally {
    vm.dispose();
  }
}
