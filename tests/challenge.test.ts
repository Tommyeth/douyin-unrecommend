import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createDecipheriv } from 'node:crypto';
import { runChallenge } from '../src/protocol/challenge-vm.js';
import { fpk1, murmur128, challengeBody, bitEnvironment } from '../src/protocol/fingerprint.js';
import { UA } from '../src/protocol/sign.js';

test('环境指纹与上游固定盐向量一致；AES 校验体可用独立 Node 实现解密', async () => {
  assert.equal(murmur128('abc'), 'b4963f3f3fad78673ba2744126ca2d52');
  assert.equal(
    fpk1(undefined, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])),
    'U2FsdGVkX18AAQIDBAUGB84DAb84oZd7BnHoRN4hvdH8wXBdxSfj4dsKZMu/EipHwqJQM2xaZ1JgT6kR+IKwaA==',
  );
  const decrypt = (text: string) => {
    const key = createHash('sha256').update(UA).digest();
    const d = createDecipheriv('aes-256-cbc', key, key.subarray(16));
    return Buffer.concat([d.update(Buffer.from(text, 'base64url')), d.final()]).toString();
  };
  assert.equal(decrypt(await bitEnvironment('fixture-iv')), 'fixture-iv');
  const body = await challengeBody();
  assert.equal(typeof JSON.parse(Buffer.from(decrypt(body.sign), 'base64').toString()), 'object');
  assert.ok(body.sk.length > 0);
});

test('隔离引擎处理异步入口、定时器参数、随机数和含 NUL 的 Base64', async () => {
  const result = await runChallenge(`module.exports = async function() {
    await new Promise(resolve => setTimeout(resolve, 10, 'ready'));
    const bytes=crypto.getRandomValues(new Uint8Array(8));
    const raw=atob('AAEC/w==');
    return {p_in:btoa(raw),e_in:{length:raw.length,zero:raw.charCodeAt(0),randomLength:bytes.length}};
  }`);
  assert.equal(result.p_in, 'AAEC/w==');
  assert.deepEqual(result.e_in, { length: 4, zero: 0, randomLength: 8 });
});

test('环境脚本无法访问宿主网络、文件系统、环境变量或其他会话全局变量', async () => {
  await runChallenge(`globalThis.previousSecret='fixture';module.exports=()=>({p_in:'ok'})`);
  const result = await runChallenge(
    `module.exports=()=>({p_in:'ok',e_in:{fetch:typeof fetch,process:typeof process,require:typeof require,secret:typeof previousSecret}})`,
  );
  assert.deepEqual(result.e_in, {
    fetch: 'undefined',
    process: 'undefined',
    require: 'undefined',
    secret: 'undefined',
  });
});

test('脚本指令、内存、异步预算和输出限制可终止异常脚本，下一次仍可运行', async () => {
  const cases = [
    'while(true){}',
    'const a=[];while(true)a.push(new Uint8Array(1024*1024))',
    'module.exports=()=>new Promise(()=>{})',
    'module.exports=()=>({p_in:"x".repeat(10000)})',
    'module.exports=()=>({p_in:"ok",e_in:"invalid"})',
    'module.exports=()=>{throw Error("sensitive upstream text")}',
  ];
  for (const code of cases)
    await assert.rejects(
      runChallenge(code),
      (e: any) => e.code === 'LOGIN_CHALLENGE' && !e.message.includes('sensitive'),
    );
  assert.equal((await runChallenge('module.exports=()=>({p_in:"recovered"})')).p_in, 'recovered');
});
