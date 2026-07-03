import { io, type Socket } from 'socket.io-client';
import type {
  AckResponse,
  ClientToServerEvents,
  ServerToClientEvents,
} from '@dalmuti/shared';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// 서버 주소 우선순위: 빌드 시 주입된 VITE_SERVER_URL → (개발) localhost:3001
// → (운영) 페이지와 같은 오리진 (서버가 웹을 함께 서빙하는 단일 서비스 배포)
const SERVER_URL: string =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ??
  (import.meta.env.DEV ? 'http://localhost:3001' : window.location.origin);

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
