import RFB from '@novnc/novnc';

export function connectDesktop(element, onState) {
  const url = new URL('/api/desktop/socket', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const rfb = new RFB(element, url.href);
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.focusOnClick = true;
  rfb.addEventListener('connect', () => onState(true, '已连接，可以直接点击画面并输入。'));
  rfb.addEventListener('disconnect', () =>
    onState(false, '桌面连接已关闭，可重新连接或使用截图操作。'),
  );
  rfb.addEventListener('securityfailure', () =>
    onState(false, '桌面认证失败，请重新打开登录浏览器。'),
  );
  return () => rfb.disconnect();
}
