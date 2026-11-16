export const hybridUiScript = `
if(hybridRuntime){
$('profileRefresh').textContent='核对账号';
let checking=false,control='';
function hideLive(){stopImages();clearInterval(clockTimer);$('liveLink').hidden=true;$('sessionClock').hidden=true;}
function showLive(j){control=j.control||'';const u=new URL(j.url);if(u.protocol!=='https:'||u.hostname!=='live.browser.run')throw Error('登录窗口地址无效');$('liveLink').href=u.href;$('liveLink').hidden=false;sessionEnds=j.expires;$('sessionClock').hidden=false;clearInterval(clockTimer);const tick=()=>{const n=Math.max(0,Math.ceil((sessionEnds-Date.now())/1000));$('sessionClock').textContent='登录窗口剩余 '+Math.floor(n/60)+':'+String(n%60).padStart(2,'0');};tick();clockTimer=setInterval(tick,1000);}
async function checkHybridLogin(){if(checking)return;checking=true;try{const j=await(await api('login/finish','POST')).json();if(j.ok){hideLive();await status();message('扫码与 Worker 纯协议验证通过，登录态已加密保存。')}else message('等待你在新窗口扫码并完成验证…')}catch(e){if(e.code==='BUSY')return;hideLive();await status().catch(()=>{});message(e.message)}finally{checking=false;}}
for(const [id,action] of [['chooseSms','sms'],['resendSms','resend'],['submitSms','code']])$(id).onclick=()=>run($(id),async()=>{stopImages();const code=$('hybridCode').value;$('hybridCode').value='';for(let i=0;checking&&i<40;i++)await new Promise(r=>setTimeout(r,250));if(!control)throw Error('请先点击打开登录浏览器，恢复当前会话。');await api('login/manual','POST',{control,action,...(action==='code'?{code}:{})});message('操作已发送，请查看抖音窗口的结果。');if(action==='code'){setTimeout(()=>void checkHybridLogin(),2500);timer=setInterval(()=>void checkHybridLogin(),6000);}});
$('hybridCode').onkeydown=e=>{if(e.key==='Enter')$('submitSms').click();};
$('login').onclick=()=>run($('login'),async()=>{stopImages();message('正在打开 Cloudflare 登录浏览器…');showLive(await(await api('login/start','POST')).json());timer=setInterval(()=>{if(Date.now()>sessionEnds){hideLive();message('登录窗口已到期，请重新打开。');return;}void checkHybridLogin();},6000);message('点击“进入抖音登录窗口”，在窗口中扫码；无法输入时使用辅助短信验证。');});
$('finish').onclick=()=>run($('finish'),async()=>{hideLive();await api('login/cancel','POST');await status();message('已关闭登录浏览器。');});
$('checkHybridLogin').onclick=()=>run($('checkHybridLogin'),checkHybridLogin);
$('validateSession').onclick=()=>run($('validateSession'),async()=>{message('正在验证保存的会话，本次不启动浏览器…');try{await api('session/validate','POST');await status();message('Worker 纯协议验证通过。');}catch(e){await status();throw e;}});
}
`;
