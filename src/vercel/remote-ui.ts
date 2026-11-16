export const remoteStyles = `
#remoteWindow{width:calc(100vw - 24px);height:calc(100dvh - 24px);max-width:1500px;max-height:none;padding:0;border:1px solid #4b555d;border-radius:8px;background:#14191e;color:#e8ecef;overflow:hidden}
#remoteWindow::backdrop{background:#171c22ba}#remoteWindow[open]{display:grid;grid-template-rows:auto minmax(0,1fr) auto}
.remote-bar{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 16px;background:#20272e}.remote-bar h2{font-size:14px}.remote-bar p{margin:3px 0 0;color:#aebbc4;font-size:12px}.remote-bar .actions{margin:0;flex-wrap:nowrap}.remote-bar button{padding:7px 10px}
#remoteStage{position:relative;display:flex;align-items:center;justify-content:center;min-height:0;overflow:hidden;padding:8px}
#remoteStage #screenViewport{display:flex;align-items:center;justify-content:center;width:100%;height:100%;max-height:none;overflow:hidden}
#remoteStage #qr{object-fit:contain;max-width:100%;max-height:100%;width:auto;height:auto;border:0;border-radius:0;cursor:default;touch-action:none;user-select:none}
#remoteLoading{position:absolute;color:#bac5cc;font-size:14px}#remoteKeys{position:absolute;left:0;bottom:0;width:1px;height:1px;opacity:.01;padding:0;border:0;resize:none}
.remote-footer{padding:10px 16px;background:#20272e;display:flex;align-items:center;gap:10px;flex-wrap:wrap}.remote-footer p{color:#bac5cc;font-size:12px;margin:0;flex:1;min-width:180px}#remoteText{width:200px;max-width:35vw;padding:7px 9px;background:#303a43;color:#fff;border-color:#53616c}
#remoteWindow:has(#remoteKeys:focus) #remoteStage{box-shadow:inset 0 0 0 2px #7ba58d}
@media(max-width:600px){#remoteWindow{width:100vw;height:100dvh;border:0;border-radius:0}.remote-bar{padding:9px}.remote-bar p{max-width:180px}.remote-footer{padding:8px}#remoteText{max-width:none;width:150px}.remote-footer button{padding:7px}}
`;
export const remoteMarkup = `
<dialog id="remoteWindow" aria-label="抖音远程浏览器"><header class="remote-bar"><div><h2>抖音登录浏览器</h2><p id="remoteClock">正在准备登录窗口</p></div><div class="actions"><button id="remoteBack" class="secondary" type="button">返回面板</button><button id="remoteStop" class="danger" type="button">结束登录</button></div></header><div id="remoteStage"><p id="remoteLoading">正在打开 Chromium，等待画面…</p><textarea id="remoteKeys" aria-label="远端浏览器键盘" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea></div><div class="remote-footer"><p id="remoteNotice" role="status">点击画面后可直接输入、粘贴、滚动或拖动。绿色边框表示键盘已连接。</p><input id="remoteText" type="password" maxlength="128" autocomplete="off" placeholder="也可在这里输入验证码" aria-label="备用文字输入"><button id="remoteSend" type="button">输入并确认</button></div></dialog>`;

// Runs inside the existing browser-login UI scope. Commands use the same authenticated lease.
export const remoteScript = `
const remoteDialog=$('remoteWindow'),remoteStage=$('remoteStage'),remoteKeys=$('remoteKeys');
const originalScreenParent=$('screenViewport').parentElement;
let firstRemoteFrame=true,commandQueue=[],typed='',typingTimer=null,composing=false,pointerStart=null,wheelTimer=null,wheel=null;
function remoteNotice(text){$('remoteNotice').textContent=text;}
function drainRemote(){if(!loginAbort||!inputReady||inputPending||!commandQueue.length)return;const action=commandQueue.shift();void manualInput(action);}
function queueRemote(action){if(!loginAbort||!loginSession||!loginFrame){remoteNotice('画面尚未就绪，请稍候。');return;}if(commandQueue.length>=24){remoteNotice('操作等待较多，请等待画面响应。');return;}commandQueue.push(action);drainRemote();}
function flushTyped(){clearTimeout(typingTimer);typingTimer=null;if(typed){const text=typed;typed='';for(let i=0;i<text.length;i+=128)queueRemote({action:'text',text:text.slice(i,i+128)});}}
function resetRemote(){commandQueue=[];typed='';clearTimeout(typingTimer);clearTimeout(wheelTimer);typingTimer=null;wheelTimer=null;wheel=null;pointerStart=null;composing=false;remoteKeys.value='';$('remoteText').value='';$('remoteLoading').textContent='正在打开 Chromium，等待画面…';}
function openRemote(){if($('qr').hidden)firstRemoteFrame=true;if(!remoteDialog.open){remoteStage.append($('screenViewport'));$('qr').classList.remove('zoomed');remoteDialog.showModal();}$('remoteLoading').hidden=!$('qr').hidden;}
function closeRemote(){flushTyped();remoteDialog.close();originalScreenParent.append($('screenViewport'));}
const point=e=>{const r=$('qr').getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};};
$('qr').onclick=e=>{if(!remoteDialog.open){const p=point(e);void manualInput({action:'click',...p});}};
$('qr').addEventListener('pointerdown',e=>{if(!remoteDialog.open||e.button!==0)return;e.preventDefault();flushTyped();pointerStart={...point(e),clientX:e.clientX,clientY:e.clientY,id:e.pointerId};$('qr').setPointerCapture(e.pointerId);});
$('qr').addEventListener('pointerup',e=>{if(!pointerStart)return;const start=pointerStart;pointerStart=null;const end=point(e);if(Math.hypot(e.clientX-start.clientX,e.clientY-start.clientY)>5)queueRemote({action:'drag',x:start.x,y:start.y,toX:end.x,toY:end.y});else queueRemote({action:'click',x:end.x,y:end.y});remoteKeys.focus({preventScroll:true});});
$('qr').addEventListener('pointercancel',()=>{pointerStart=null;});
$('qr').addEventListener('wheel',e=>{if(!remoteDialog.open)return;e.preventDefault();flushTyped();const p=point(e);wheel={...p,deltaX:Math.max(-1200,Math.min(1200,(wheel?.deltaX||0)+e.deltaX)),deltaY:Math.max(-1200,Math.min(1200,(wheel?.deltaY||0)+e.deltaY))};clearTimeout(wheelTimer);wheelTimer=setTimeout(()=>{if(wheel)queueRemote({action:'wheel',...wheel});wheel=null;},160);},{passive:false});
remoteKeys.addEventListener('compositionstart',()=>{composing=true;});
function takeTyped(){if(composing)return;typed+=remoteKeys.value;remoteKeys.value='';clearTimeout(typingTimer);typingTimer=setTimeout(flushTyped,220);}
remoteKeys.addEventListener('compositionend',()=>{composing=false;takeTyped();});remoteKeys.addEventListener('input',takeTyped);
remoteKeys.addEventListener('keydown',e=>{if(e.isComposing||composing)return;let key='';if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='a')key='ControlOrMeta+A';else if(['Enter','Backspace','Delete','Tab','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key))key=e.key==='Tab'&&e.shiftKey?'Shift+Tab':e.key;if(key){e.preventDefault();flushTyped();queueRemote({action:'key',key});}});
remoteDialog.addEventListener('cancel',e=>{e.preventDefault();flushTyped();queueRemote({action:'key',key:'Escape'});});
$('remoteBack').onclick=closeRemote;$('openRemote').onclick=openRemote;$('remoteStop').onclick=()=>{$('finish').click();};
$('remoteSend').onclick=()=>{flushTyped();const text=$('remoteText').value;$('remoteText').value='';if(text)queueRemote({action:'text',text,submit:true});};
remoteControl={open:openRemote,reset:resetRemote,isOpen:()=>remoteDialog.open,
clock:text=>{$('remoteClock').textContent=text;},notice:remoteNotice,
frame:()=>{if(firstRemoteFrame){firstRemoteFrame=false;remoteNotice('点击远端输入框后可直接键入或粘贴。请等待每次操作确认。');}$('remoteLoading').hidden=true;$('openRemote').hidden=false;drainRemote();},
ack:event=>{if(event.code){resetRemote();remoteNotice(event.message);}else remoteNotice(event.focusedInput?'已选中输入框，可直接键入或粘贴。':event.message);},
end:()=>{resetRemote();$('remoteLoading').textContent='登录窗口已结束，可返回面板查看结果或重新开始。';$('remoteLoading').hidden=false;$('openRemote').hidden=true;}}
`;
