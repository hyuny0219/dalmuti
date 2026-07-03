import type {
  BotDifficulty,
  Card,
  ChatMessage,
  GameEvent,
  GameOptions,
  GamePublicState,
} from './types';

/** 요청-응답(ack) 공통 포맷 */
export type AckResponse<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export type Ack<T = undefined> = (res: AckResponse<T>) => void;

export type RoomPhase = 'LOBBY' | 'IN_GAME';

export type RoomPlayer = {
  id: string;
  nickname: string;
  isBot: boolean;
  botDifficulty: BotDifficulty | null;
  connected: boolean;
  isHost: boolean;
};

export type RoomState = {
  code: string;
  phase: RoomPhase;
  hostId: string;
  players: RoomPlayer[];
  options: GameOptions;
};

/**
 * 제3자에게 브로드캐스트해도 안전한 이벤트.
 * 세금 이벤트의 카드 id(비공개 정보)는 장수로 치환된다.
 */
export type PublicGameEvent =
  | Exclude<GameEvent, { type: 'TAX_TRIBUTE' } | { type: 'TAX_RETURN' }>
  | { type: 'TAX_TRIBUTE'; fromId: string; toId: string; cardCount: number }
  | { type: 'TAX_RETURN'; fromId: string; toId: string; cardCount: number };

export type JoinResult = {
  roomCode: string;
  playerId: string;
  sessionToken: string;
  room: RoomState;
};

export type RejoinResult = {
  playerId: string;
  room: RoomState;
  game: GamePublicState | null;
  hand: Card[] | null;
  chatHistory: ChatMessage[];
};

/** 클라이언트 → 서버 이벤트 */
export type ClientToServerEvents = {
  'room:create': (
    payload: { nickname: string; options?: Partial<GameOptions> },
    ack: Ack<JoinResult>,
  ) => void;
  'room:join': (payload: { roomCode: string; nickname: string }, ack: Ack<JoinResult>) => void;
  'room:rejoin': (
    payload: { roomCode: string; sessionToken: string },
    ack: Ack<RejoinResult>,
  ) => void;
  'room:leave': (ack: Ack) => void;
  'room:options': (payload: Partial<GameOptions>, ack: Ack) => void;
  'room:start': (ack: Ack) => void;
  'game:play': (payload: { cardIds: string[] }, ack: Ack) => void;
  'game:pass': (ack: Ack) => void;
  'game:declareRevolution': (payload: { declare: boolean }, ack: Ack) => void;
  'game:payTax': (payload: { cardIds: string[] }, ack: Ack) => void;
  'game:nextRound': (ack: Ack) => void;
  'chat:send': (payload: { text: string }, ack: Ack) => void;
};

/** 서버 → 클라이언트 이벤트 */
export type ServerToClientEvents = {
  'room:state': (state: RoomState) => void;
  'game:state': (state: GamePublicState) => void;
  /** 본인에게만 전송되는 비공개 정보 */
  'game:hand': (payload: {
    cards: Card[];
    /** 세금 반환 대기 중이면 반환해야 할 장수, 아니면 null */
    pendingTaxReturnCount: number | null;
  }) => void;
  'game:event': (event: PublicGameEvent) => void;
  'chat:message': (message: ChatMessage) => void;
};

/** 서버 오류 코드 (GameErrorCode 외 서버 계층 오류) */
export type ServerErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ALREADY_IN_ROOM'
  | 'NOT_IN_ROOM'
  | 'NOT_HOST'
  | 'GAME_ALREADY_STARTED'
  | 'GAME_NOT_STARTED'
  | 'INVALID_NICKNAME'
  | 'NICKNAME_TAKEN'
  | 'INVALID_SESSION'
  | 'INVALID_PAYLOAD'
  | 'CHAT_RATE_LIMITED'
  | 'NOT_ENOUGH_PLAYERS';
