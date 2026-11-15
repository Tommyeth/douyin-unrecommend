import { SafeError, type Channel, type MailConnect, type Notice } from './types.js';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
export function mailMessage(channel: Channel, notice: Notice) {
  const body =
    b64(`${notice.body}\n${notice.url ?? ''}\n事件 ID：${notice.id}`)
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? '';
  return [
    `From: <${channel.from}>`,
    `To: ${channel.to!.map((x) => `<${x}>`).join(', ')}`,
    `Subject: =?UTF-8?B?${b64(notice.title)}?=`,
    `Message-ID: <${b64(notice.id).replace(/[^a-zA-Z0-9]/g, '')}@douyin-unrecommend.local>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}
export async function smtp(connect: MailConnect, channel: Channel, notice: Notice) {
  const socket = await connect(channel.host!, channel.port ?? 465);
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  let buffer = '';
  const decoder = new TextDecoder();
  const timeout = setTimeout(() => {
    void socket.close().catch(() => {});
  }, 15000);
  const line = async () => {
    while (!buffer.includes('\r\n')) {
      const part = await reader.read();
      if (part.done) throw new Error('SMTP closed');
      buffer += decoder.decode(part.value, { stream: true });
      if (buffer.length > 65536) throw new Error('SMTP response too long');
    }
    const i = buffer.indexOf('\r\n');
    const result = buffer.slice(0, i);
    buffer = buffer.slice(i + 2);
    return result;
  };
  const reply = async (expected: number[]) => {
    for (let i = 0; i < 100; i++) {
      const l = await line();
      const match = l.match(/^(\d{3})([ -])/);
      if (!match) throw new Error('SMTP malformed reply');
      if (match[2] === ' ') {
        if (!expected.includes(Number(match[1]))) throw new Error('SMTP rejected');
        return;
      }
    }
    throw new Error('SMTP multiline limit');
  };
  const command = async (text: string, codes: number[]) => {
    await writer.write(new TextEncoder().encode(text + '\r\n'));
    await reply(codes);
  };
  try {
    await reply([220]);
    await command('EHLO douyin-unrecommend.local', [250]);
    await command('AUTH LOGIN', [334]);
    await command(b64(channel.username!), [334]);
    await command(b64(channel.password!), [235]);
    await command(`MAIL FROM:<${channel.from}>`, [250]);
    for (const addr of channel.to!) await command(`RCPT TO:<${addr}>`, [250, 251]);
    await command('DATA', [354]);
    await command(mailMessage(channel, notice) + '\r\n.', [250]);
    // DATA 被接受即算投递成功，QUIT 失败不能触发重复投递。
    await command('QUIT', [221]).catch(() => {});
  } catch {
    throw new SafeError('SMTP_FAILED', 'SMTP 投递失败，请检查 465/TLS、账号授权码和收件人。', 502);
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
    writer.releaseLock();
    await socket.close().catch(() => {});
  }
}
