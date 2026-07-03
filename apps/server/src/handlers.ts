import type { Server, Socket } from 'socket.io';
import {
  GameError,
  MAX_CHAT_LENGTH,
  MIN_PLAYERS,
  DalmutiGame,
  type Ack,
  type ChatMessage,
  type ClientToServerEvents,
  type GameEvent,
  type PublicGameEvent,
  type ServerToClientEvents,
} from '@dalmuti/shared';
import {
  createMember,
  Room,
  RoomManager,
  sanitizeOptions,
  systemMessage,
  userMessage,
} from './room';

export type IoServer = Server<ClientToServerEvents, ServerToClientEvents>;
export type IoSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

type SocketData = { roomCode?: string; playerId?: string };

const fail = (code: string, message: string) =>
  ({ ok: false, error: { code, message } }) as const;
const ok = <T>(data: T) => ({ ok: true, data }) as const;

function getCtx(
  socket: IoSocket,
  rooms: RoomManager,
): { room: Room; memberId: string } | null {
  const data = socket.data as SocketData;
  if (!data.roomCode || !data.playerId) return null;
  const room = rooms.get(data.roomCode);
  if (!room || !room.findById(data.playerId)) return null;
  return { room, memberId: data.playerId };
}

function validNickname(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // 제어 문자 제거 후 공백 정리
  const cleaned = raw.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  if (cleaned.length < 1 || cleaned.length > 20) return null;
  return cleaned;
}

/** 세금 이벤트의 카드 id(비공개)를 장수로 치환 */
function toPublicEvent(e: GameEvent): PublicGameEvent {
  if (e.type === 'TAX_TRIBUTE' || e.type === 'TAX_RETURN') {
    return { type: e.type, fromId: e.fromId, toId: e.toId, cardCount: e.cardIds.length };
  }
  return e;
}

export class GameGateway {
  constructor(
    private readonly io: IoServer,
    private readonly rooms: RoomManager,
  ) {}

  register(socket: IoSocket): void {
    socket.on('room:create', (payload, ack) => this.onCreate(socket, payload, ack));
    socket.on('room:join', (payload, ack) => this.onJoin(socket, payload, ack));
    socket.on('room:rejoin', (payload, ack) => this.onRejoin(socket, payload, ack));
    socket.on('room:leave', (ack) => this.onLeave(socket, ack));
    socket.on('room:options', (payload, ack) => this.onOptions(socket, payload, ack));
    socket.on('room:start', (ack) => this.onStart(socket, ack));
    socket.on('game:play', (payload, ack) =>
      this.onGameAction(socket, ack, (game, pid) => {
        this.assertCardIds(payload);
        game.play(pid, payload.cardIds);
      }),
    );
    socket.on('game:pass', (ack) =>
      this.onGameAction(socket, ack, (game, pid) => void game.pass(pid)),
    );
    socket.on('game:declareRevolution', (payload, ack) =>
      this.onGameAction(socket, ack, (game, pid) => {
        if (typeof payload?.declare !== 'boolean') {
          throw new GameError('WRONG_PHASE', '잘못된 요청입니다');
        }
        game.declareRevolution(pid, payload.declare);
      }),
    );
    socket.on('game:payTax', (payload, ack) =>
      this.onGameAction(socket, ack, (game, pid) => {
        this.assertCardIds(payload);
        game.payTaxReturn(pid, payload.cardIds);
      }),
    );
    socket.on('game:nextRound', (ack) => this.onNextRound(socket, ack));
    socket.on('chat:send', (payload, ack) => this.onChat(socket, payload, ack));
    socket.on('disconnect', () => this.onDisconnect(socket));
  }

  // ── 방 생성/입장 ─────────────────────────────────────────────

  private onCreate(
    socket: IoSocket,
    payload: { nickname: string; options?: object },
    ack: Ack<import('@dalmuti/shared').JoinResult>,
  ): void {
    if (typeof ack !== 'function') return;
    if (getCtx(socket, this.rooms)) return ack(fail('ALREADY_IN_ROOM', '이미 방에 있습니다'));
    const nickname = validNickname(payload?.nickname);
    if (!nickname) return ack(fail('INVALID_NICKNAME', '닉네임은 1~20자여야 합니다'));

    const member = createMember(nickname, socket.id);
    const room = this.rooms.create(member, payload?.options);
    this.bind(socket, room.code, member.id);
    this.pushChat(room, systemMessage(`${nickname}님이 방을 만들었습니다.`));
    this.broadcastRoom(room);
    ack(
      ok({
        roomCode: room.code,
        playerId: member.id,
        sessionToken: member.sessionToken,
        room: room.toState(),
      }),
    );
  }

  private onJoin(
    socket: IoSocket,
    payload: { roomCode: string; nickname: string },
    ack: Ack<import('@dalmuti/shared').JoinResult>,
  ): void {
    if (typeof ack !== 'function') return;
    if (getCtx(socket, this.rooms)) return ack(fail('ALREADY_IN_ROOM', '이미 방에 있습니다'));
    const nickname = validNickname(payload?.nickname);
    if (!nickname) return ack(fail('INVALID_NICKNAME', '닉네임은 1~20자여야 합니다'));
    const room =
      typeof payload?.roomCode === 'string' ? this.rooms.get(payload.roomCode) : undefined;
    if (!room) return ack(fail('ROOM_NOT_FOUND', '방을 찾을 수 없습니다'));
    if (room.isInGame) return ack(fail('GAME_ALREADY_STARTED', '게임이 이미 시작됐습니다'));
    if (room.isFull) return ack(fail('ROOM_FULL', '방이 가득 찼습니다'));
    if (room.members.some((m) => m.nickname === nickname)) {
      return ack(fail('NICKNAME_TAKEN', '이미 사용 중인 닉네임입니다'));
    }

    const member = createMember(nickname, socket.id);
    room.members.push(member);
    room.touch();
    this.bind(socket, room.code, member.id);
    this.pushChat(room, systemMessage(`${nickname}님이 입장했습니다.`));
    this.broadcastRoom(room);
    ack(
      ok({
        roomCode: room.code,
        playerId: member.id,
        sessionToken: member.sessionToken,
        room: room.toState(),
      }),
    );
  }

  private onRejoin(
    socket: IoSocket,
    payload: { roomCode: string; sessionToken: string },
    ack: Ack<import('@dalmuti/shared').RejoinResult>,
  ): void {
    if (typeof ack !== 'function') return;
    const room =
      typeof payload?.roomCode === 'string' ? this.rooms.get(payload.roomCode) : undefined;
    if (!room) return ack(fail('ROOM_NOT_FOUND', '방을 찾을 수 없습니다'));
    const member =
      typeof payload?.sessionToken === 'string'
        ? room.findByToken(payload.sessionToken)
        : undefined;
    if (!member) return ack(fail('INVALID_SESSION', '세션이 유효하지 않습니다'));

    // 이전 소켓이 살아있으면 끊는다 (중복 접속 방지)
    if (member.socketId && member.socketId !== socket.id) {
      this.io.sockets.sockets.get(member.socketId)?.disconnect(true);
    }
    member.socketId = socket.id;
    member.connected = true;
    room.game?.setConnected(member.id, true);
    room.touch();
    this.bind(socket, room.code, member.id);
    this.pushChat(room, systemMessage(`${member.nickname}님이 다시 접속했습니다.`));
    this.broadcastRoom(room);
    if (room.game) this.broadcastGameState(room);
    ack(
      ok({
        playerId: member.id,
        room: room.toState(),
        game: room.game?.getPublicState() ?? null,
        hand: room.game ? room.game.getHandOf(member.id) : null,
        chatHistory: [...room.chat],
      }),
    );
    if (room.game) this.sendHand(room, member.id);
  }

  private onLeave(socket: IoSocket, ack: Ack): void {
    if (typeof ack !== 'function') return;
    const ctx = getCtx(socket, this.rooms);
    if (!ctx) return ack(fail('NOT_IN_ROOM', '방에 있지 않습니다'));
    this.removeFromRoom(socket, ctx.room, ctx.memberId, '나갔습니다');
    ack(ok(undefined));
  }

  private onDisconnect(socket: IoSocket): void {
    const ctx = getCtx(socket, this.rooms);
    if (!ctx) return;
    const { room, memberId } = ctx;
    const member = room.findById(memberId);
    if (!member) return;

    if (room.isInGame) {
      // 게임 중엔 자리를 보존하고 재접속을 기다린다
      member.connected = false;
      member.socketId = null;
      room.game?.setConnected(memberId, false);
      this.pushChat(room, systemMessage(`${member.nickname}님의 연결이 끊겼습니다.`));
      this.broadcastRoom(room);
      this.broadcastGameState(room);
    } else {
      this.removeFromRoom(socket, room, memberId, '나갔습니다');
    }
  }

  private removeFromRoom(
    socket: IoSocket,
    room: Room,
    memberId: string,
    verb: string,
  ): void {
    const member = room.findById(memberId);
    room.members = room.members.filter((m) => m.id !== memberId);
    socket.leave(room.code);
    (socket.data as SocketData).roomCode = undefined;
    (socket.data as SocketData).playerId = undefined;

    if (room.members.length === 0) {
      this.rooms.delete(room.code);
      return;
    }
    room.reassignHostIfNeeded();
    if (member) this.pushChat(room, systemMessage(`${member.nickname}님이 ${verb}.`));
    this.broadcastRoom(room);
  }

  // ── 로비 ────────────────────────────────────────────────────

  private onOptions(socket: IoSocket, payload: object, ack: Ack): void {
    if (typeof ack !== 'function') return;
    const ctx = getCtx(socket, this.rooms);
    if (!ctx) return ack(fail('NOT_IN_ROOM', '방에 있지 않습니다'));
    if (ctx.memberId !== ctx.room.hostId) return ack(fail('NOT_HOST', '방장만 가능합니다'));
    if (ctx.room.isInGame) {
      return ack(fail('GAME_ALREADY_STARTED', '게임 중에는 변경할 수 없습니다'));
    }
    ctx.room.options = sanitizeOptions({ ...ctx.room.options, ...payload });
    ctx.room.touch();
    this.broadcastRoom(ctx.room);
    ack(ok(undefined));
  }

  private onStart(socket: IoSocket, ack: Ack): void {
    if (typeof ack !== 'function') return;
    const ctx = getCtx(socket, this.rooms);
    if (!ctx) return ack(fail('NOT_IN_ROOM', '방에 있지 않습니다'));
    const { room, memberId } = ctx;
    if (memberId !== room.hostId) return ack(fail('NOT_HOST', '방장만 시작할 수 있습니다'));
    if (room.isInGame) return ack(fail('GAME_ALREADY_STARTED', '게임이 이미 시작됐습니다'));
    if (room.members.length < MIN_PLAYERS) {
      return ack(fail('NOT_ENOUGH_PLAYERS', `최소 ${MIN_PLAYERS}명이 필요합니다`));
    }

    try {
      room.game = new DalmutiGame(
        room.members.map((m) => ({ id: m.id, nickname: m.nickname, isBot: m.isBot })),
        room.options,
      );
      room.game.startRound();
    } catch (e) {
      room.game = null;
      return ack(this.gameErrorToAck(e));
    }
    room.touch();
    this.pushChat(room, systemMessage('게임을 시작합니다!'));
    this.broadcastRoom(room);
    this.pump(room);
    ack(ok(undefined));
  }

  private onNextRound(socket: IoSocket, ack: Ack): void {
    if (typeof ack !== 'function') return;
    const ctx = getCtx(socket, this.rooms);
    if (!ctx?.room.game) return ack(fail('GAME_NOT_STARTED', '게임이 시작되지 않았습니다'));
    if (ctx.memberId !== ctx.room.hostId) return ack(fail('NOT_HOST', '방장만 가능합니다'));
    try {
      ctx.room.game.startRound();
    } catch (e) {
      return ack(this.gameErrorToAck(e));
    }
    ctx.room.touch();
    this.pump(ctx.room);
    ack(ok(undefined));
  }

  // ── 게임 액션 공통 처리 ───────────────────────────────────────

  private onGameAction(
    socket: IoSocket,
    ack: Ack,
    action: (game: DalmutiGame, playerId: string) => void,
  ): void {
    if (typeof ack !== 'function') return;
    const ctx = getCtx(socket, this.rooms);
    if (!ctx) return ack(fail('NOT_IN_ROOM', '방에 있지 않습니다'));
    if (!ctx.room.game) return ack(fail('GAME_NOT_STARTED', '게임이 시작되지 않았습니다'));
    try {
      action(ctx.room.game, ctx.memberId);
    } catch (e) {
      return ack(this.gameErrorToAck(e));
    }
    ctx.room.touch();
    this.pump(ctx.room);
    ack(ok(undefined));
  }

  private assertCardIds(payload: unknown): asserts payload is { cardIds: string[] } {
    const p = payload as { cardIds?: unknown };
    if (
      !p ||
      !Array.isArray(p.cardIds) ||
      p.cardIds.length === 0 ||
      p.cardIds.length > 80 ||
      !p.cardIds.every((id) => typeof id === 'string' && id.length <= 16)
    ) {
      throw new GameError('CARDS_NOT_IN_HAND', '잘못된 카드 선택입니다');
    }
  }

  private gameErrorToAck(e: unknown) {
    if (e instanceof GameError) return fail(e.code, e.message);
    console.error('[game] unexpected error', e);
    return fail('INTERNAL', '서버 오류가 발생했습니다');
  }

  // ── 채팅 ────────────────────────────────────────────────────

  private onChat(socket: IoSocket, payload: { text: string }, ack: Ack): void {
    if (typeof ack !== 'function') return;
    const ctx = getCtx(socket, this.rooms);
    if (!ctx) return ack(fail('NOT_IN_ROOM', '방에 있지 않습니다'));
    const member = ctx.room.findById(ctx.memberId)!;

    const raw = typeof payload?.text === 'string' ? payload.text : '';
    const text = raw.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
    if (text.length < 1 || text.length > MAX_CHAT_LENGTH) {
      return ack(fail('INVALID_PAYLOAD', `메시지는 1~${MAX_CHAT_LENGTH}자여야 합니다`));
    }
    if (!ctx.room.checkChatRate(ctx.memberId)) {
      return ack(fail('CHAT_RATE_LIMITED', '메시지를 너무 빠르게 보내고 있습니다'));
    }
    this.pushChat(ctx.room, userMessage(member, text));
    ctx.room.touch();
    ack(ok(undefined));
  }

  // ── 브로드캐스트 ─────────────────────────────────────────────

  private bind(socket: IoSocket, roomCode: string, playerId: string): void {
    (socket.data as SocketData).roomCode = roomCode;
    (socket.data as SocketData).playerId = playerId;
    socket.join(roomCode);
  }

  private pushChat(room: Room, message: ChatMessage): void {
    room.addChat(message);
    this.io.to(room.code).emit('chat:message', message);
  }

  private broadcastRoom(room: Room): void {
    this.io.to(room.code).emit('room:state', room.toState());
  }

  private broadcastGameState(room: Room): void {
    if (!room.game) return;
    this.io.to(room.code).emit('game:state', room.game.getPublicState());
  }

  private sendHand(room: Room, memberId: string): void {
    const game = room.game;
    const member = room.findById(memberId);
    if (!game || !member?.socketId) return;
    this.io.to(member.socketId).emit('game:hand', {
      cards: game.getHandOf(memberId),
      pendingTaxReturnCount: game.getPendingTaxReturn(memberId)?.count ?? null,
    });
  }

  /** 엔진 이벤트를 소비해 브로드캐스트 + 시스템 메시지 생성, 상태/손패 동기화 */
  private pump(room: Room): void {
    const game = room.game;
    if (!game) return;

    for (const event of game.drainEvents()) {
      const publicEvent = toPublicEvent(event);
      this.io.to(room.code).emit('game:event', publicEvent);
      const text = this.eventToSystemText(room, publicEvent);
      if (text) this.pushChat(room, systemMessage(text));
    }
    this.broadcastGameState(room);
    for (const m of room.members) {
      if (m.connected) this.sendHand(room, m.id);
    }
  }

  private eventToSystemText(room: Room, e: PublicGameEvent): string | null {
    const nick = (id: string) => room.findById(id)?.nickname ?? '???';
    switch (e.type) {
      case 'ROUND_STARTED':
        return `라운드 ${e.round} 시작!`;
      case 'REVOLUTION_PENDING':
        return `${nick(e.playerId)}님이 광대 2장을 손에 넣었습니다. 혁명을 선언할지 결정 중...`;
      case 'REVOLUTION_DECLARED':
        return e.isGreat
          ? `대혁명! ${nick(e.playerId)}님의 선언으로 계급이 완전히 역전됩니다!`
          : `혁명! ${nick(e.playerId)}님의 선언으로 이번 라운드는 세금이 없습니다.`;
      case 'REVOLUTION_DECLINED':
        return `${nick(e.playerId)}님이 혁명을 포기했습니다.`;
      case 'TAX_TRIBUTE':
        return `${nick(e.fromId)}님이 ${nick(e.toId)}님에게 최고 카드 ${e.cardCount}장을 상납했습니다.`;
      case 'TAX_RETURN':
        return `${nick(e.fromId)}님이 ${nick(e.toId)}님에게 ${e.cardCount}장을 돌려주었습니다.`;
      case 'PLAYER_FINISHED':
        return `🎉 ${nick(e.playerId)}님이 ${e.place}등으로 완주했습니다!`;
      case 'ROUND_ENDED':
        return `라운드 ${e.round} 종료! 다음 라운드의 계급이 정해졌습니다.`;
      case 'GAME_ENDED':
        return '게임 종료! 수고하셨습니다.';
      default:
        return null; // PLAYED/PASSED/TRICK_WON은 채팅에 남기지 않는다 (게임 화면에 표시)
    }
  }
}
