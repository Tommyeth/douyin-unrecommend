import type { Browser, BrowserContext } from 'playwright';

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
export type Video = { id: string; title: string; url: string };
export type Snapshot = { videos: Video[]; complete: boolean; pages: number; account: string };
export type Mode = 'notify' | 'auto_cancel';
export type Notice = { id: string; kind: string; title: string; body: string; url?: string };
export type Channel = {
  name: string;
  type: 'bark' | 'wecom' | 'webhook' | 'smtp';
  url?: string;
  key?: string;
  token?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  from?: string;
  to?: string[];
};
export interface Sql {
  run(sql: string, ...params: (string | number | null)[]): Promise<number>;
  all<T>(sql: string, ...params: (string | number | null)[]): Promise<T[]>;
}
export interface Browsers {
  launch(login?: boolean): Promise<{ browser: Browser; id: string }>;
  connect(id: string): Promise<Browser>;
  detach(browser: Browser): Promise<void>;
}
export interface MailSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}
export type MailConnect = (host: string, port: number) => Promise<MailSocket>;
export class SafeError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
export const safeError = (error: unknown): SafeError =>
  error instanceof SafeError
    ? error
    : new SafeError('UPSTREAM_ERROR', '浏览器或网络请求失败，请检查运行环境后重试。', 502);
