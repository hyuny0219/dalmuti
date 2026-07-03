import { io, type Socket } from 'socket.io-client';
import type {
  AckResponse,
  ClientToServerEvents,
  ServerToClientEvents,
} from '@dalmuti/shared';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const SERVER_URL: string =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ?? 'http://localhost:3001';

export const socket: AppSocket = io(SERVER_URL, {
  transports: ['websocket', 'polling'],
});

/** ack 콜백을 Promise로 감싼 요청 헬퍼 */
export function call<T = undefined>(
  event: keyof ClientToServerEvents,
  ...args: unknown[]
): Promise<AckResponse<T>> {
  return new Promise((resolve) => {
    // 타입은 protocol.ts가 보증 — 전송 시점엔 가변 인자로 넘긴다
    (socket as Socket).emit(event as string, ...args, resolve);
  });
}
