import { createServer, type Server as HttpServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Server } from 'socket.io';
import sirv from 'sirv';
import {
  PROTOCOL_VERSION,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@dalmuti/shared';
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

  // 단일 서비스 배포: WEB_DIST가 가리키는 웹 빌드 산출물을 함께 서빙한다
  // (프론트+백엔드를 무료 인스턴스 1개로 호스팅). SPA 폴백 포함.
  // pnpm --filter 실행 시 cwd가 패키지 디렉토리가 되므로 저장소 루트 기준도 시도한다.
  const webDist = process.env.WEB_DIST
    ? [
        resolve(process.cwd(), process.env.WEB_DIST),
        resolve(process.cwd(), '../..', process.env.WEB_DIST),
      ].find((p) => existsSync(p)) ?? null
    : null;
  const serveWeb = webDist ? sirv(webDist, { single: true, etag: true }) : null;
  if (process.env.WEB_DIST && !serveWeb) {
    console.warn(
      `[web] WEB_DIST 경로를 찾을 수 없습니다: ${process.env.WEB_DIST} — API 전용으로 기동`,
    );
  }
  if (serveWeb) console.log(`[web] 정적 파일 서빙: ${webDist}`);

  const startedAt = Date.now();
  const httpServer = createServer((req, res) => {
    // 로드밸런서/모니터링용 헬스체크 + 운영 지표
    // ("어제 왜 느렸지?"에 답할 최소한의 관측 지점 — 외부 모니터가 주기 수집 가능)
    if (req.url === '/healthz') {
      const stats = rooms.stats();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          sockets: io.engine?.clientsCount ?? 0,
          memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
          ...stats,
        }),
      );
      return;
    }
    if (serveWeb) {
      serveWeb(req, res, () => {
        res.writeHead(404);
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // CORS: 운영 환경에서는 반드시 명시해야 한다 (기본 전체 허용은 개발 전용).
  // 단, 웹을 같은 서버에서 서빙(WEB_DIST)하면 same-origin이므로 CORS가 필요 없다 —
  // 이 경우 미설정을 허용하고 cross-origin은 기본적으로 차단된다.
  const corsOrigin = process.env.CORS_ORIGIN?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!corsOrigin?.length && !serveWeb && process.env.NODE_ENV === 'production') {
    throw new Error(
      '운영 환경에서는 CORS_ORIGIN 환경변수를 설정해야 합니다 (WEB_DIST 단일 서비스 모드 제외)',
    );
  }
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: corsOrigin?.length ? { origin: corsOrigin } : serveWeb ? undefined : { origin: true },
  });

  const gateway = new GameGateway(io, rooms);
  io.on('connection', (socket) => {
    // 접속 즉시 버전을 알린다 — 배포 후 구버전 번들을 캐시한 클라이언트가
    // 스스로 "새로고침" 안내를 띄울 수 있도록 (프로토콜 스큐 대응)
    socket.emit('server:hello', { protocolVersion: PROTOCOL_VERSION });
    gateway.register(socket);
  });

  const sweeper = setInterval(() => {
    // 삭제 전 남은 소켓(관전자 포함)을 방에서 분리해 코드 재사용 시 유출 방지
    const removed = rooms.sweep(Date.now(), (room) => gateway.closeRoom(room));
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
