import { randomBytes, randomUUID } from 'node:crypto';
import {
  CHAT_HISTORY_LIMIT,
  DalmutiGame,
  DEFAULT_GAME_OPTIONS,
  MAX_PLAYERS,
  type ChatMessage,
  type GameOptions,
  type RoomPlayer,
  type RoomState,
} from '@dalmuti/shared';

export type RoomMember = {
  id: string;
  nickname: string;
  sessionToken: string;
  socketId: string | null;
  connected: boolean;
  isBot: boolean;
};

/** 초당 허용 채팅 수 (도배 방지) */
const CHAT_RATE_PER_SECOND = 2;

export class Room {
  readonly code: string;
  hostId: string;
  options: GameOptions;
  members: RoomMember[] = [];
  game: DalmutiGame | null = null;
  chat: ChatMessage[] = [];
  lastActivityAt = Date.now();
  private chatTimestamps = new Map<string, number[]>();

  constructor(code: string, host: RoomMember, options: Partial<GameOptions>) {
    this.code = code;
    this.hostId = host.id;
    this.members = [host];
    this.options = sanitizeOptions(options);
  }

  touch(): void {
    this.lastActivityAt = Date.now();
  }

  get isFull(): boolean {
    return this.members.length >= MAX_PLAYERS;
  }

  get isInGame(): boolean {
    return this.game !== null && this.game.phase !== 'GAME_END';
  }

  findByToken(sessionToken: string): RoomMember | undefined {
    return this.members.find((m) => m.sessionToken === sessionToken);
  }

  findById(playerId: string): RoomMember | undefined {
    return this.members.find((m) => m.id === playerId);
  }

  /** 방장 승계: 접속 중인 사람 우선, 없으면 첫 멤버 */
  reassignHostIfNeeded(): void {
    if (this.members.some((m) => m.id === this.hostId)) return;
    const next = this.members.find((m) => m.connected) ?? this.members[0];
    if (next) this.hostId = next.id;
  }

  addChat(message: ChatMessage): void {
    this.chat.push(message);
    if (this.chat.length > CHAT_HISTORY_LIMIT) {
      this.chat = this.chat.slice(-CHAT_HISTORY_LIMIT);
    }
  }

  /** true면 허용, false면 도배로 거부 */
  checkChatRate(playerId: string, now = Date.now()): boolean {
    const stamps = (this.chatTimestamps.get(playerId) ?? []).filter(
      (t) => now - t < 1000,
    );
    if (stamps.length >= CHAT_RATE_PER_SECOND) {
      this.chatTimestamps.set(playerId, stamps);
      return false;
    }
    stamps.push(now);
    this.chatTimestamps.set(playerId, stamps);
    return true;
  }

  toState(): RoomState {
    return {
      code: this.code,
      phase: this.game ? 'IN_GAME' : 'LOBBY',
      hostId: this.hostId,
      players: this.members.map(
        (m): RoomPlayer => ({
          id: m.id,
          nickname: m.nickname,
          isBot: m.isBot,
          botDifficulty: null,
          connected: m.connected,
          isHost: m.id === this.hostId,
        }),
      ),
      options: { ...this.options },
    };
  }
}

export function createMember(nickname: string, socketId: string): RoomMember {
  return {
    id: randomUUID(),
    nickname,
    sessionToken: randomBytes(24).toString('base64url'),
    socketId,
    connected: true,
    isBot: false,
  };
}

export function systemMessage(text: string): ChatMessage {
  return {
    id: randomUUID(),
    type: 'system',
    senderId: null,
    senderNickname: null,
    text,
    timestamp: Date.now(),
  };
}

export function userMessage(member: RoomMember, text: string): ChatMessage {
  return {
    id: randomUUID(),
    type: 'user',
    senderId: member.id,
    senderNickname: member.nickname,
    text,
    timestamp: Date.now(),
  };
}

/** 방 옵션 검증: 타입/범위를 벗어나면 기본값으로 강제 */
export function sanitizeOptions(input: Partial<GameOptions> | undefined): GameOptions {
  const base = { ...DEFAULT_GAME_OPTIONS };
  if (!input || typeof input !== 'object') return base;
  if (typeof input.enableRevolution === 'boolean') {
    base.enableRevolution = input.enableRevolution;
  }
  if (typeof input.enableTaxation === 'boolean') {
    base.enableTaxation = input.enableTaxation;
  }
  if (
    typeof input.targetRounds === 'number' &&
    Number.isInteger(input.targetRounds) &&
    input.targetRounds >= 1 &&
    input.targetRounds <= 20
  ) {
    base.targetRounds = input.targetRounds;
  }
  if (input.turnTimeLimitSec === null) {
    base.turnTimeLimitSec = null;
  } else if (
    typeof input.turnTimeLimitSec === 'number' &&
    Number.isInteger(input.turnTimeLimitSec) &&
    input.turnTimeLimitSec >= 10 &&
    input.turnTimeLimitSec <= 300
  ) {
    base.turnTimeLimitSec = input.turnTimeLimitSec;
  }
  return base;
}

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class RoomManager {
  private rooms = new Map<string, Room>();

  create(host: RoomMember, options: Partial<GameOptions> | undefined): Room {
    let code: string;
    do {
      code = Array.from(
        { length: 6 },
        () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)],
      ).join('');
    } while (this.rooms.has(code));
    const room = new Room(code, host, options ?? {});
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  delete(code: string): void {
    this.rooms.delete(code);
  }

  get size(): number {
    return this.rooms.size;
  }

  /** 전원이 나갔거나 30분 이상 방치된 방 정리 */
  sweep(now = Date.now()): number {
    const STALE_MS = 30 * 60 * 1000;
    let removed = 0;
    for (const [code, room] of this.rooms) {
      const empty = room.members.length === 0;
      const allDisconnected = room.members.every((m) => !m.connected);
      if (empty || (allDisconnected && now - room.lastActivityAt > STALE_MS)) {
        this.rooms.delete(code);
        removed++;
      }
    }
    return removed;
  }
}
