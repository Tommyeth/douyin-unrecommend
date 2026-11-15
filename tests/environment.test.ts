import test from 'node:test';
import assert from 'node:assert/strict';
import { runChallenge } from '../src/protocol/challenge-vm.js';
const probe = async (body: string) =>
  (await runChallenge(`module.exports=async()=>{${body}}`)).e_in as any;

test('DOM 实际维护节点、属性、选择器、克隆和事件冒泡', async () => {
  const r = await probe(`
    const root=document.createElement('section');root.innerHTML='<div class="item" data-id="7"><span>中文</span></div>';
    document.body.appendChild(root);const child=root.querySelector('.item[data-id="7"]');
    const clone=child.cloneNode(true);clone.id='copy';root.appendChild(clone);
    let eventCount=0;root.addEventListener('click',()=>eventCount++);child.dispatchEvent(new Event('click',{bubbles:true}));
    const before=root.querySelectorAll('.item').length;child.remove();
    return {p_in:'ok',e_in:{before,after:root.querySelectorAll('.item').length,text:document.getElementById('copy').textContent,connected:clone.isConnected,removed:child.parentNode===null,eventCount,globalIdentity:window===globalThis&&self===window&&document.defaultView===window}};
  `);
  assert.deepEqual(r, {
    before: 2,
    after: 1,
    text: '中文',
    connected: true,
    removed: true,
    eventCount: 1,
    globalIdentity: true,
  });
});

test('Canvas 实际绘制像素、路径与渐变，调整尺寸清空画布并保留上下文身份', async () => {
  const r = await probe(`
    const c=document.createElement('canvas');c.width=30;c.height=20;const ctx=c.getContext('2d');
    ctx.fillStyle='#ff0000';ctx.fillRect(0,0,10,10);
    const red=Array.from(ctx.getImageData(2,2,1,1).data),clear=Array.from(ctx.getImageData(20,15,1,1).data);
    ctx.beginPath();ctx.rect(10,0,10,10);const inside=ctx.isPointInPath(15,5),outside=ctx.isPointInPath(25,5);
    const gradient=ctx.createLinearGradient(0,10,30,10);gradient.addColorStop(0,'black');gradient.addColorStop(1,'white');ctx.fillStyle=gradient;ctx.fillRect(0,10,30,10);
    const dark=ctx.getImageData(1,15,1,1).data[0],light=ctx.getImageData(28,15,1,1).data[0];
    const png=c.toDataURL();c.width=30;
    return {p_in:'ok',e_in:{red,clear,inside,outside,dark,light,png,reset:Array.from(ctx.getImageData(2,2,1,1).data),same:ctx===c.getContext('2d'),webgl:c.getContext('webgl')===null}};
  `);
  assert.deepEqual(r.red, [255, 0, 0, 255]);
  assert.deepEqual(r.clear, [0, 0, 0, 0]);
  assert.equal(r.inside, true);
  assert.equal(r.outside, false);
  assert.ok(r.dark < r.light);
  const png = Buffer.from(r.png.split(',')[1], 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 30);
  assert.equal(png.readUInt32BE(20), 20);
  assert.deepEqual(r.reset, [0, 0, 0, 0]);
  assert.equal(r.same, true);
  assert.equal(r.webgl, true);
});

test('文字使用字体真实测量并栅格化，DOM 尺寸反映样式与文本变化', async () => {
  const r = await probe(`
    const c=document.createElement('canvas');c.width=200;c.height=60;const ctx=c.getContext('2d');ctx.font='20px Arimo';
    const narrow=ctx.measureText('iiii').width,wide=ctx.measureText('WWWW').width;
    ctx.fillStyle='black';ctx.fillText('Hello',2,30);const pixels=ctx.getImageData(0,0,100,40).data;let painted=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i])painted++;
    const span=document.createElement('span');span.style.fontSize='20px';span.style.fontFamily='Arimo';span.textContent='iiii';document.body.appendChild(span);const first=span.offsetWidth;span.textContent='WWWW';const second=span.offsetWidth;
    const style=document.createElement('style');style.textContent='.probe{width:100px;height:25px;padding-left:4px;font-size:24px}';document.head.appendChild(style);span.className='probe';span.style.fontSize='';
    return {p_in:'ok',e_in:{narrow,wide,painted,first,second,width:span.offsetWidth,height:span.offsetHeight,fontSize:getComputedStyle(span).fontSize,font:document.fonts.check('20px Arimo'),missing:document.fonts.check('20px UnknownFont')}};
  `);
  assert.ok(r.wide > r.narrow && r.narrow > 0);
  assert.ok(r.painted > 20);
  assert.ok(r.second > r.first);
  assert.equal(r.width, 104);
  assert.equal(r.height, 25);
  assert.equal(r.fontSize, '24px');
  assert.equal(r.font, true);
  assert.equal(r.missing, false);
});

test('Path2D 与跨画布绘制产生真实像素，重复解码受资源预算限制', async () => {
  const r = await probe(`
    const a=document.createElement('canvas'),b=document.createElement('canvas');a.width=b.width=10;a.height=b.height=10;
    const x=a.getContext('2d'),y=b.getContext('2d'),path=new Path2D();path.rect(0,0,5,5);x.fillStyle='red';x.fill(path);
    y.drawImage(a,0,0);const pixel=Array.from(y.getImageData(2,2,1,1).data);
    let limited=false;try{for(let i=0;i<130;i++)y.drawImage(a,0,0);}catch{limited=true;}
    return {p_in:'ok',e_in:{pixel,limited}};
  `);
  assert.deepEqual(r, { pixel: [255, 0, 0, 255], limited: true });
});

test('Storage、Cookie、定时顺序保持状态；Canvas 超限不会留下后续会话资源', async () => {
  const r = await probe(`
    localStorage.setItem('a','1');localStorage.setItem('b','2');localStorage.removeItem('a');document.cookie='a=1';document.cookie='b=2';document.cookie='a=; Max-Age=0';
    const order=[];setTimeout(()=>order.push('later'),20);await new Promise(resolve=>setTimeout(()=>{order.push('first');resolve()},10));await new Promise(resolve=>setTimeout(resolve,20));
    const c=document.createElement('canvas');let limited=false;try{c.width=10000;}catch{limited=true;}
    return {p_in:'ok',e_in:{stored:localStorage.getItem('b'),length:localStorage.length,cookie:document.cookie,order,limited}};
  `);
  assert.deepEqual(r, {
    stored: '2',
    length: 1,
    cookie: 'b=2',
    order: ['first', 'later'],
    limited: true,
  });
  const next = await probe(
    `return{p_in:'ok',e_in:{length:localStorage.length,cookie:document.cookie}}`,
  );
  assert.deepEqual(next, { length: 0, cookie: '' });
});
