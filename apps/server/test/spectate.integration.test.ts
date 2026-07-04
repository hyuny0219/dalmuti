import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { io as clientIo, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import {
  enumeratePlayableCombos,
  type AckResponse,
  type Card,
  type ChatMessage,
  type GamePublicState,
  type JoinResult,
  type PublicRoomSummary,
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

describe('공개 방 목록', () => {
  it('공개 방만 목록에 노출되고, 방장이 토글할 수 있다', async () => {
    const host = await connect();
    const join = expectOk<JoinResult>(
      await call(host, 'room:create', { nickname: '공개장', isPublic: true }),
    );
    const hidden = await connect();
    expectOk<JoinResult>(await call(hidden, 'room:create', { nickname: '은둔자' })); // 비공개

    const viewer = await connect();
    const list = expectOk<PublicRoomSummary[]>(await call(viewer, 'room:list'));
    const codes = list.map((r) => r.code);
    expect(codes).toContain(join.roomCode);
    expect(list.find((r) => r.code === join.roomCode)).toMatchObject({
      hostNickname: '공개장',
      playerCount: 1,
      inGame: false,
    });
    // 비공개 방은 노출되지 않는다
    expect(list.some((r) => r.hostNickname === '은둔자')).toBe(false);

    // 방장이 비공개로 전환하면 목록에서 사라진다
    expectOk(await call(host, 'room:setPublic', { isPublic: false }));
    const after = expectOk<PublicRoomSummary[]>(await call(viewer, 'room:list'));
    expect(after.some((r) => r.code === join.roomCode)).toBe(false);

    // 방장이 아니면 토글 불가
    const guest = await connect();
    expectOk(await call(guest, 'room:join', { roomCode: join.roomCode, nickname: '손님' }));
    const denied = await call(guest, 'room:setPublic', { isPublic: true });
    expect(denied).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });
  });
});

describe('관전 모드', () => {
  type HostTracker = { state: GamePublicState | null; hand: Card[]; myId: string };

  async function startBotGame(): Promise<{
    host: Socket;
    roomCode: string;
    latest: HostTracker;
  }> {
    const host = await connect();
    // 리스너를 room:start 이전에 붙인다 — 봇 지연 0ms라 시작 직후
    // 브로드캐스트가 순식간에 지나가고 게임이 호스트 차례에서 멈추기 때문
    const latest: HostTracker = { state: null, hand: [], myId: '' };
    host.on('game:state', (s: GamePublicState) => {
      latest.state = s;
      latest.myId = s.players.find((p) => !p.isBot)!.id;
    });
    host.on('game:hand', (p: { cards: Card[] }) => {
      latest.hand = p.cards;
    });
    const join = expectOk<JoinResult>(
      await call(host, 'room:create', {
        nickname: '주인장',
        isPublic: true,
        options: { targetRounds: 1 },
      }),
    );
    for (const d of ['normal', 'normal', 'normal'] as const) {
      expectOk(await call(host, 'room:addBot', { difficulty: d }));
    }
    expectOk(await call(host, 'room:start'));
    return { host, roomCode: join.roomCode, latest };
  }

  it('관전자는 공개 상태와 채팅을 받지만 게임 액션은 거부된다', async () => {
    const { host, roomCode, latest } = await startBotGame();

    const spec = await connect();
    const received: { state: GamePublicState | null } = { state: null };
    spec.on('game:state', (s: GamePublicState) => {
      received.state = s;
    });
    const result = expectOk<SpectateResult>(
      await call(spec, 'room:spectate', { roomCode, nickname: '구경꾼' }),
    );
    expect(result.game?.phase).toBe('PLAYING');
    expect(result.room.spectatorCount).toBe(1);

    // 호스트가 수를 둬서 브로드캐스트를 발생시킨다 → 관전자가 수신할 때까지 반복
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline && !received.state) {
      const s = latest.state;
      if (
        s?.phase === 'PLAYING' &&
        s.currentTurnPlayerId === latest.myId &&
        latest.hand.length > 0
      ) {
        const combos = enumeratePlayableCombos(latest.hand, s.field);
        if (combos.length > 0) {
          await call(host, 'game:play', { cardIds: combos[0]!.map((c) => c.id) });
        } else {
          await call(host, 'game:pass');
        }
      }
      await new Promise((r) => setTimeout(r, 60));
    }

    expect(received.state).not.toBeNull();
    expect(received.state!.players).toHaveLength(4);

    // 게임 액션 거부
    const play = await call(spec, 'game:play', { cardIds: ['r1-1'] });
    expect(play).toMatchObject({ ok: false, error: { code: 'NOT_A_PLAYER' } });
    const pass = await call(spec, 'game:pass');
    expect(pass).toMatchObject({ ok: false, error: { code: 'NOT_A_PLAYER' } });

    // 관전자 채팅 — 👁 표시가 붙는다
    const chatReceived = new Promise<ChatMessage>((resolve) => {
      spec.on('chat:message', (m: ChatMessage) => {
        if (m.type === 'user') resolve(m);
      });
    });
    expectOk(await call(spec, 'chat:send', { text: '잘 보고 있어요!' }));
    const msg = await chatReceived;
    expect(msg.senderNickname).toBe('👁 구경꾼');
  }, 20000);

  it('관전자가 나가면 관전자 수가 줄어든다', async () => {
    const { host, roomCode } = await startBotGame();

    const spec = await connect();
    expectOk<SpectateResult>(await call(spec, 'room:spectate', { roomCode, nickname: '떠돌이' }));

    const sawZero = new Promise<RoomState>((resolve) => {
      host.on('room:state', (s: RoomState) => {
        if (s.spectatorCount === 0) resolve(s);
      });
    });
    expectOk(await call(spec, 'room:leave'));
    const state = await sawZero;
    expect(state.spectatorCount).toBe(0);
  });

  it('없는 방 관전은 거부된다', async () => {
    const spec = await connect();
    const res = await call(spec, 'room:spectate', { roomCode: 'ZZZZZZ', nickname: '유령' });
    expect(res).toMatchObject({ ok: false, error: { code: 'ROOM_NOT_FOUND' } });
  });
});
