import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { io as clientIo, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import {
  PROTOCOL_VERSION,
  type AckResponse,
  type JoinResult,
  type RoomState,
  type SpectateResult,
} from '@dalmuti/shared';
import { createGameServer, type GameServer } from '../src/server';

let server: GameServer;
let port: number;
let sockets: Socket[] = [];

beforeAll(async () => {
  process.env.BOT_DELAY_MS = '0';
  server = createGameServer();
  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  port = (server.httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  delete process.env.BOT_DELAY_MS;
  await server.close();
  await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
});

afterEach(() => {
  for (const s of sockets) s.disconnect();
  sockets = [];
});

async function connect(): Promise<Socket> {
  const socket = clientIo(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    forceNew: true,
  });
  sockets.push(socket);
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  return socket;
}

function call<T>(socket: Socket, event: string, ...args: unknown[]): Promise<AckResponse<T>> {
  return new Promise((resolve) => socket.emit(event, ...args, resolve));
}

function expectOk<T>(res: AckResponse<T>): T {
  if (!res.ok) throw new Error(`요청 실패: ${res.error.code} ${res.error.message}`);
  return res.data;
}

describe('프로토콜 버전 핸드셰이크', () => {
  it('접속 직후 server:hello로 버전을 알린다', async () => {
    const socket = clientIo(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      forceNew: true,
    });
    sockets.push(socket);
    const hello = await new Promise<{ protocolVersion: number }>((resolve) =>
      socket.once('server:hello', resolve),
    );
    expect(hello.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});

describe('healthz 운영 지표', () => {
  it('소켓/방/게임 수와 메모리를 노출한다', async () => {
    const host = await connect();
    expectOk<JoinResult>(await call(host, 'room:create', { nickname: '지표측정' }));

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(body.rooms).toBeGreaterThanOrEqual(1);
    expect(body.players).toBeGreaterThanOrEqual(1);
    expect(body.sockets).toBeGreaterThanOrEqual(1);
    expect(body.memoryRssMb).toBeGreaterThan(0);
    expect(typeof body.uptimeSec).toBe('number');
    expect(typeof body.gamesInProgress).toBe('number');
  });
});

describe('방장 강퇴', () => {
  it('방장이 멤버를 내보내면 당사자는 room:kicked를 받고 명단에서 빠진다', async () => {
    const host = await connect();
    const join = expectOk<JoinResult>(await call(host, 'room:create', { nickname: '방장' }));
    const guest = await connect();
    const guestJoin = expectOk<JoinResult>(
      await call(guest, 'room:join', { roomCode: join.roomCode, nickname: '불청객' }),
    );

    const kicked = new Promise<void>((resolve) => guest.once('room:kicked', resolve));
    const stateAfter = new Promise<RoomState>((resolve) => {
      host.on('room:state', (s: RoomState) => {
        if (s.players.length === 1) resolve(s);
      });
    });
    expectOk(await call(host, 'room:kick', { playerId: guestJoin.playerId }));
    await kicked;
    const state = await stateAfter;
    expect(state.players.some((p) => p.nickname === '불청객')).toBe(false);

    // 강퇴된 소켓의 바인딩도 해제됐다
    const chat = await call(guest, 'chat:send', { text: '아직 있나요?' });
    expect(chat).toMatchObject({ ok: false, error: { code: 'NOT_IN_ROOM' } });
    // 세션 토큰도 무효 (멤버 제거)
    const rejoin = await call(guest, 'room:rejoin', {
      roomCode: join.roomCode,
      sessionToken: guestJoin.sessionToken,
    });
    expect(rejoin).toMatchObject({ ok: false, error: { code: 'INVALID_SESSION' } });
  });

  it('방장이 아니면 강퇴할 수 없고, 자신/봇은 대상이 아니다', async () => {
    const host = await connect();
    const join = expectOk<JoinResult>(await call(host, 'room:create', { nickname: '방장' }));
    const guest = await connect();
    expectOk<JoinResult>(
      await call(guest, 'room:join', { roomCode: join.roomCode, nickname: '손님' }),
    );

    // 봇 id는 room:state 브로드캐스트로 확인 (addBot 전에 리스너 등록)
    const botState = new Promise<RoomState>((resolve) => {
      host.on('room:state', (s: RoomState) => {
        if (s.players.some((p) => p.isBot)) resolve(s);
      });
    });
    expectOk(await call(host, 'room:addBot', { difficulty: 'easy' }));
    const bot = (await botState).players.find((p) => p.isBot)!;

    const notHost = await call(guest, 'room:kick', { playerId: join.playerId });
    expect(notHost).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });

    const self = await call(host, 'room:kick', { playerId: join.playerId });
    expect(self).toMatchObject({ ok: false, error: { code: 'CANNOT_KICK' } });

    const kickBot = await call(host, 'room:kick', { playerId: bot.id });
    expect(kickBot).toMatchObject({ ok: false, error: { code: 'CANNOT_KICK' } });
  });
});

describe('관전자 착석', () => {
  it('대기 중인 방의 관전자는 빈 좌석에 앉아 참가자가 된다', async () => {
    const host = await connect();
    const join = expectOk<JoinResult>(await call(host, 'room:create', { nickname: '방장' }));

    const spec = await connect();
    expectOk<SpectateResult>(
      await call(spec, 'room:spectate', { roomCode: join.roomCode, nickname: '입질러' }),
    );

    const sit = expectOk<JoinResult>(await call(spec, 'room:sit'));
    expect(sit.sessionToken).toBeTruthy();
    expect(sit.room.players.some((p) => p.nickname === '입질러')).toBe(true);
    expect(sit.room.spectatorCount).toBe(0);

    // 이제 참가자로서 채팅에 👁 없이 표시된다
    const msg = new Promise<{ senderNickname: string | null }>((resolve) => {
      host.on('chat:message', (m: { type: string; senderNickname: string | null }) => {
        if (m.type === 'user') resolve(m);
      });
    });
    expectOk(await call(spec, 'chat:send', { text: '이제 참가자예요' }));
    expect((await msg).senderNickname).toBe('입질러');
  });

  it('게임 진행 중에는 착석할 수 없고, 참가자는 room:sit이 거부된다', async () => {
    const host = await connect();
    const join = expectOk<JoinResult>(
      await call(host, 'room:create', { nickname: '방장', options: { targetRounds: 1 } }),
    );
    for (let i = 0; i < 3; i++) expectOk(await call(host, 'room:addBot', { difficulty: 'easy' }));

    const notSpec = await call(host, 'room:sit');
    expect(notSpec).toMatchObject({ ok: false, error: { code: 'NOT_A_SPECTATOR' } });

    expectOk(await call(host, 'room:start'));
    const spec = await connect();
    expectOk<SpectateResult>(
      await call(spec, 'room:spectate', { roomCode: join.roomCode, nickname: '늦둥이' }),
    );
    const denied = await call(spec, 'room:sit');
    expect(denied).toMatchObject({ ok: false, error: { code: 'GAME_ALREADY_STARTED' } });
  });
});

describe('소켓 전역 rate limit', () => {
  it('짧은 시간에 이벤트를 퍼부으면 초과분이 거부된다', async () => {
    const flooder = await connect();
    const results = await Promise.all(
      Array.from({ length: 40 }, () => call(flooder, 'room:list')),
    );
    const okCount = results.filter((r) => r.ok).length;
    const limited = results.filter(
      (r) => !r.ok && (r as { error: { code: string } }).error.code === 'RATE_LIMITED',
    ).length;
    expect(okCount).toBeGreaterThan(0); // 정상 사용은 통과
    expect(limited).toBeGreaterThan(0); // 폭주는 차단
    expect(okCount + limited).toBe(40);
  });

  it('정상적인 게임 준비 흐름은 제한에 걸리지 않는다', async () => {
    const host = await connect();
    expectOk<JoinResult>(await call(host, 'room:create', { nickname: '정상인' }));
    for (let i = 0; i < 3; i++) {
      expectOk(await call(host, 'room:addBot', { difficulty: 'normal' }));
    }
    expectOk(await call(host, 'chat:send', { text: '시작할게요' }));
    expectOk(await call(host, 'room:start'));
  });
});
