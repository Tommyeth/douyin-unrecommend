import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { SafeError } from '../types.js';
import type { StateBackend } from '../vercel/state.js';

const COOKIE = 'douyin_desktop';
/** The RFB server stays on loopback. No admin token or ticket appears in URLs. */
export function desktopGateway(backend: StateBackend, publicOrigin?: string, rfbPort = 5900) {
  const tickets = new Map<string, { session: string; expires: number }>();
  const clients = new Map<WebSocket, { session: string; expires: number }>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });
  async function active(session: string) {
    const { state } = await backend.read();
    const lease = state.lease;
    return lease?.kind === 'login' &&
      lease.owner === session &&
      !lease.cancelled &&
      lease.expires > Date.now()
      ? lease
      : null;
  }
  const close = (session: string) => {
    for (const [key, value] of tickets) if (value.session === session) tickets.delete(key);
    for (const [ws, value] of clients)
      if (value.session === session) ws.close(1000, 'Session ended');
  };
  const timer = setInterval(() => {
    for (const [ticket, value] of tickets) if (value.expires <= Date.now()) tickets.delete(ticket);
    for (const [ws, value] of clients) {
      void active(value.session)
        .then((lease) => {
          if (!lease || value.expires <= Date.now()) ws.close(1000, 'Session ended');
        })
        .catch(() => ws.close(1011, 'State unavailable'));
    }
  }, 2000);
  timer.unref();
  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const reject = (status: number) => {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
    };
    try {
      if (req.url !== '/api/desktop/socket') return reject(404);
      const expected = publicOrigin ? new URL(publicOrigin).origin : `http://${req.headers.host}`;
      if (req.headers.origin !== expected) return reject(403);
      const raw = (req.headers.cookie ?? '')
        .split(';')
        .map((x) => x.trim())
        .find((x) => x.startsWith(COOKIE + '='))
        ?.slice(COOKIE.length + 1);
      const ticket = raw ? tickets.get(raw) : undefined;
      if (!ticket || ticket.expires <= Date.now() || !(await active(ticket.session)))
        return reject(401);
      wss.handleUpgrade(req, socket, head, (ws) => {
        clients.set(ws, ticket);
        const tcp = connect({ host: '127.0.0.1', port: rfbPort });
        tcp.on('data', (chunk) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
        });
        tcp.on('error', () => ws.close(1011, 'Desktop unavailable'));
        tcp.on('close', () => ws.close());
        ws.on('message', (data, binary) => {
          if (!binary || tcp.writableLength > 2_000_000)
            return ws.close(1008, 'Invalid desktop data');
          tcp.write(data as Buffer);
        });
        ws.on('close', () => {
          clients.delete(ws);
          tcp.destroy();
        });
        ws.on('error', () => tcp.destroy());
      });
    } catch {
      reject(503);
    }
  }
  return {
    async cookie(session: string, origin: string) {
      if (typeof session !== 'string') throw new SafeError('LOGIN_EXPIRED', '请先打开登录浏览器。');
      const lease = await active(session);
      if (!lease) throw new SafeError('LOGIN_EXPIRED', '扫码会话已结束，请重新打开浏览器。');
      close(session);
      const ticket = randomBytes(32).toString('hex');
      tickets.set(ticket, { session, expires: lease.expires });
      return `${COOKIE}=${ticket}; HttpOnly; SameSite=Strict; Path=/api/desktop; Max-Age=${Math.max(1, Math.floor((lease.expires - Date.now()) / 1000))}${new URL(origin).protocol === 'https:' ? '; Secure' : ''}`;
    },
    attach(server: Server) {
      server.on('upgrade', (req, socket, head) => {
        void upgrade(req, socket, head);
      });
    },
    close,
    shutdown() {
      clearInterval(timer);
      tickets.clear();
      for (const ws of clients.keys()) ws.terminate();
      wss.close();
    },
  };
}
