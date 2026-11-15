import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { seal, unseal, validToken } from '../src/crypto.js';
import { isFeed, parseFeed } from '../src/douyin.js';
import { sqlite } from '../src/node.js';
import { Store } from '../src/store.js';
import { deliver, flush } from '../src/notify.js';
import { app } from '../src/app.js';
import { Service } from '../src/service.js';
import { smtp } from '../src/smtp.js';
import type { Channel, Notice, Snapshot, MailConnect } from '../src/types.js';

const env = { ADMIN_TOKEN: 'a'.repeat(40), AUTH_SECRET: 'b'.repeat(40) };
const video = { id: '1001', title: '测试视频', url: 'https://www.douyin.com/video/1001' };
const snapshot = (videos = [video], complete = true): Snapshot => ({
  videos,
  complete,
  pages: 1,
  account: 'account-hash',
});
const notice: Notice = {
  id: 'test-1',
  kind: 'test',
  title: '中文通知',
  body: '这是一条测试消息',
  url: video.url,
};
const noMail: MailConnect = async () => {
  throw Error('not used');
};

test('配置拒绝短密钥、错误间隔、未加密通知地址与邮件头注入', () => {
  assert.throws(() => config({}));
  assert.throws(() => config({ ...env, POLL_INTERVAL_SECONDS: '1' }));
  assert.throws(() =>
    config({
      ...env,
      NOTIFICATIONS_JSON: JSON.stringify([
        { name: 'x', type: 'webhook', url: 'http://example.com' },
      ]),
    }),
  );
  assert.throws(() =>
    config({
      ...env,
      NOTIFICATIONS_JSON: JSON.stringify([
        {
          name: 'x',
          type: 'smtp',
          host: 'smtp.example.com',
          username: 'a',
          password: 'b',
          from: 'x@example.com\r\nBcc: a@b.com',
          to: ['y@example.com'],
        },
      ]),
    }),
  );
});
test('登录态加密、随机 IV 与错误密钥拒绝', async () => {
  const auth = { cookies: [{ value: 'do-not-leak' }] };
  const a = await seal(auth, env.AUTH_SECRET),
    b = await seal(auth, env.AUTH_SECRET);
  assert.notEqual(a, b);
  assert.ok(!a.includes('do-not-leak'));
  assert.deepEqual(await unseal(a, env.AUTH_SECRET), auth);
  await assert.rejects(unseal(a, 'c'.repeat(40)));
  assert.equal(await validToken('a', 'b'), false);
});
test('仅匹配推荐接口，喜欢接口不能混入', () => {
  assert.equal(
    isFeed('https://www-hj.douyin.com/aweme/v1/web/familiar/recommend/feed/?a_bogus=example'),
    true,
  );
  assert.equal(isFeed('https://www.douyin.com/aweme/v1/web/aweme/favorite/'), false);
  assert.equal(isFeed('https://evil-douyin.com/aweme/v1/web/familiar/recommend/feed/'), false);
});
test('API 空状态、长整数 ID、图文与异常返回严格区分', () => {
  assert.deepEqual(
    parseFeed({ status_code: 0, has_more: false, aweme_list: null, total: 0, max_cursor: 0 })
      .videos,
    [],
  );
  assert.throws(() => parseFeed({ status_code: 8, has_more: false, aweme_list: [] }));
  assert.throws(() => parseFeed({ status_code: 0, has_more: false }));
  assert.throws(() =>
    parseFeed({ status_code: 0, has_more: false, aweme_list: [{ aweme_id: 1234567890123456789 }] }),
  );
  const p = parseFeed({
    status_code: 0,
    has_more: 1,
    max_cursor: '123',
    aweme_list: [{ aweme_id: '1234567890123456789', desc: '图文', images: [{}] }],
  });
  assert.equal(p.videos[0].url, 'https://www.douyin.com/note/1234567890123456789');
  assert.equal(p.more, true);
});
test('重启去重、完整缺失后重新推荐再次通知', async () => {
  const db = sqlite(':memory:');
  let store = new Store(db);
  assert.equal(await store.observe(snapshot(), ['phone'], new Set()), 1);
  store = new Store(db);
  assert.equal(await store.observe(snapshot(), ['phone'], new Set()), 0);
  await store.observe(snapshot([], true), ['phone'], new Set());
  assert.equal(await store.observe(snapshot(), ['phone'], new Set()), 1);
  assert.equal((await db.all('SELECT * FROM outbox')).length, 2);
});
test('不完整扫描不能把未读取的记录标记为取消', async () => {
  const store = new Store(sqlite(':memory:'));
  await store.observe(snapshot(), ['phone'], new Set());
  await store.observe(snapshot([], false), ['phone'], new Set());
  assert.equal(await store.observe(snapshot(), ['phone'], new Set()), 0);
});
test('账号切换被拒绝；保留名单不会提醒', async () => {
  const store = new Store(sqlite(':memory:'));
  await store.observe(snapshot(), ['phone'], new Set(['1001']));
  assert.equal((await store.db.all('SELECT * FROM outbox')).length, 0);
  await assert.rejects(
    store.observe({ ...snapshot(), account: 'other' }, ['phone'], new Set()),
    /账号/,
  );
});
test('数据库锁阻止多个实例同时操作', async () => {
  const db = sqlite(':memory:');
  const a = new Store(db),
    b = new Store(db);
  await a.lock(async () => {
    await assert.rejects(
      b.lock(async () => 1),
      /正在执行/,
    );
  });
  assert.equal(await b.lock(async () => 2), 2);
});
test('Bark、企微、Webhook 请求格式及业务错误检查', async () => {
  for (const type of ['bark', 'wecom', 'webhook'] as const) {
    const c: Channel = {
      name: type,
      type,
      url: 'https://example.com/push',
      key: 'test-device',
      token: 'test-token',
    };
    let captured: RequestInit | undefined;
    const request = (async (_url: unknown, init: RequestInit) => {
      captured = init;
      return Response.json(type === 'bark' ? { code: 200 } : { errcode: 0 });
    }) as typeof fetch;
    await deliver(c, notice, noMail, request);
    const b = JSON.parse(String(captured!.body));
    if (type === 'bark') assert.equal(b.device_key, 'test-device');
    if (type === 'wecom') assert.equal(b.msgtype, 'text');
    if (type === 'webhook')
      assert.equal(
        (captured!.headers as Record<string, string>).Authorization,
        'Bearer test-token',
      );
  }
  await assert.rejects(
    deliver({ name: 'w', type: 'wecom', url: 'https://example.com' }, notice, noMail, (async () =>
      Response.json({ errcode: 40014 })) as typeof fetch),
  );
});
test('SMTP TLS 传输中的 AUTH LOGIN、多行响应与 UTF-8 MIME', async () => {
  const sent: string[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let stage = 0;
  const replies = [
    '250-test\r\n250 AUTH LOGIN\r\n',
    '334 user\r\n',
    '334 pass\r\n',
    '235 ok\r\n',
    '250 ok\r\n',
    '250 ok\r\n',
    '354 data\r\n',
    '250 queued\r\n',
    '221 bye\r\n',
  ];
  const connect: MailConnect = async () => ({
    readable: new ReadableStream({
      start(c) {
        controller = c;
        c.enqueue(new TextEncoder().encode('220 test ready\r\n'));
      },
    }),
    writable: new WritableStream({
      write(chunk) {
        sent.push(new TextDecoder().decode(chunk));
        controller.enqueue(new TextEncoder().encode(replies[stage++]));
      },
    }),
    async close() {
      controller.close();
    },
  });
  await smtp(
    connect,
    {
      name: 'mail',
      type: 'smtp',
      host: 'smtp.example.com',
      username: 'u',
      password: 'p',
      from: 'a@example.com',
      to: ['b@example.com'],
    },
    notice,
  );
  assert.equal(sent[1], 'AUTH LOGIN\r\n');
  assert.ok(sent[7].includes('Content-Transfer-Encoding: base64'));
  assert.ok(!sent[7].includes(notice.body));
});
test('通知失败保留待发队列并退避，成功不重复发送', async () => {
  const store = new Store(sqlite(':memory:'));
  await store.enqueue(notice, ['bark'], 1000);
  const realFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls++;
      return new Response('', { status: 500 });
    }) as typeof fetch;
    const channels: Channel[] = [
      { name: 'bark', type: 'bark', url: 'https://example.com', key: 'test' },
    ];
    assert.equal((await flush(store, channels, noMail, 1000)).failed, 1);
    await flush(store, channels, noMail, 1001);
    assert.equal(calls, 1);
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ code: 200 });
    }) as typeof fetch;
    assert.equal((await flush(store, channels, noMail, 62000)).sent, 1);
    await flush(store, channels, noMail, 63000);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
test('管理 API 验证口令、同源、模式切换持久化和二维码访问', async () => {
  const store = new Store(sqlite(':memory:'));
  const service = new Service(config(env), store, noMail);
  const web = app(service);
  assert.equal((await web.request('/api/status')).status, 401);
  assert.equal((await web.request('/api/login/image')).status, 401);
  const headers = {
    Authorization: `Bearer ${env.ADMIN_TOKEN}`,
    'Content-Type': 'application/json',
  };
  assert.equal(
    (
      await web.request('/api/settings', {
        method: 'POST',
        headers: { ...headers, Origin: 'https://evil.example' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await web.request('/api/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify({ mode: 'auto_cancel', interval: 60 }),
      })
    ).status,
    200,
  );
  const s = await new Service(config(env), store, noMail).status();
  assert.equal(s.mode, 'auto_cancel');
  assert.equal(s.interval, 60);
  assert.equal(
    (
      await web.request('/api/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify({ mode: 'auto_cancel', interval: 0 }),
      })
    ).status,
    400,
  );
});

test('仅提醒模式不取消；自动模式处理已发现的记录并尊重单批上限', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  try {
    for (const mode of ['notify', 'auto_cancel'] as const) {
      const cfg = config({
        ...env,
        MODE: mode,
        MAX_ACTIONS: '1',
        IGNORE_IDS: '1002',
        NOTIFICATIONS_JSON: JSON.stringify([
          { name: 'test', type: 'webhook', url: 'https://example.com' },
        ]),
      });
      const store = new Store(sqlite(':memory:'));
      const service = new Service(cfg, store, noMail);
      let cancels = 0;
      const videos = [video, { ...video, id: '1002' }, { ...video, id: '1003' }];
      const fakeBot = {
        async scan() {
          return snapshot(videos);
        },
        async cancel() {
          cancels++;
          return snapshot(videos.slice(1));
        },
      };
      service.withClient = async (fn) =>
        fn(fakeBot as unknown as import('../src/douyin.js').Douyin);
      await service.poll();
      assert.equal(cancels, mode === 'notify' ? 0 : 1);
      assert.equal(JSON.parse((await store.get('last_scan'))!).added, 2);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('通知失败在未登录时也能随调度重试', async () => {
  const store = new Store(sqlite(':memory:'));
  const cfg = config({
    ...env,
    NOTIFICATIONS_JSON: JSON.stringify([
      { name: 'test', type: 'webhook', url: 'https://example.com' },
    ]),
  });
  await store.enqueue(notice, ['test']);
  const service = new Service(cfg, store, noMail);
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    const result = await service.poll(true);
    assert.equal(result.skipped, true);
    assert.equal(
      (await store.db.all<{ sent_at: number }>('SELECT sent_at FROM outbox'))[0].sent_at > 0,
      true,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
