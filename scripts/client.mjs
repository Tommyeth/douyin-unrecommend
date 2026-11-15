#!/usr/bin/env node
const base = process.env.SERVICE_URL ?? 'http://127.0.0.1:8787';
const token = process.env.ADMIN_TOKEN;
if (!token) {
  console.error('请设置 ADMIN_TOKEN；远程实例还需设置 SERVICE_URL。');
  process.exit(1);
}
const [command, arg] = process.argv.slice(2);
const routes = {
  status: ['GET', 'status'],
  poll: ['POST', 'poll'],
  preview: ['POST', 'clear/preview'],
  clear: ['POST', 'clear'],
  test: ['POST', 'notifications/test'],
};
if (!routes[command] || (command === 'clear' && !arg)) {
  console.log(
    '用法：node --env-file=.env scripts/client.mjs status|poll|preview|test\n取消预览中的一批：node --env-file=.env scripts/client.mjs clear <预览返回的 token>',
  );
  process.exit(1);
}
const [method, path] = routes[command];
const response = await fetch(new URL('/api/' + path, base), {
  method,
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: command === 'clear' ? JSON.stringify({ token: arg }) : undefined,
});
const result = await response.json();
console.log(JSON.stringify(result, null, 2));
if (!response.ok) process.exitCode = 1;
