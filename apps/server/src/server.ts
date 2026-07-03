import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@dalmuti/shared';
import { GameGateway } from './handlers';
import { RoomManager } from './room';

export type GameServer = {
  httpServer: HttpServer;
  io: Server<ClientToServerEvents, ServerToClientEvents>;
  rooms: RoomManager;
  close: () => Promise<void>;
};

export function createGameServer(): GameServer {
  const rooms = new RoomManager();

  const httpServer = createServer((req, res) => {
    // 로드밸런서/모니터링용 헬스체크 (+ 방 수 지표)
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // CORS: 운영 환경에서는 반드시 명시해야 한다 (기본 전체 허용은 개발 전용).
  // 미설정 배포가 조용히 전체 개방으로 동작하는 사고를 시작 시점에 차단.
  const corsOrigin = process.env.CORS_ORIGIN?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!corsOrigin?.length && process.env.NODE_ENV === 'production') {
    throw new Error('운영 환경에서는 CORS_ORIGIN 환경변수를 설정해야 합니다');
  }
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: corsOrigin?.length ? corsOrigin : true },
  });

  const gateway = new GameGateway(io, rooms);
  io.on('connection', (socket) => gateway.register(socket));

  const sweeper = setInterval(() => {
    const removed = rooms.sweep();
    if (removed > 0) console.log(`[sweep] 방치된 방 ${removed}개 정리`);
  }, 60_000);
  sweeper.unref();

  const close = async () => {
    clearInterval(sweeper);
    io.disconnectSockets(true);
    await io.close();
  };

  return { httpServer, io, rooms, close };
}
