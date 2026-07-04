import { create } from 'zustand';
import type {
  BotDifficulty,
  Card,
  ChatMessage,
  GameOptions,
  GamePublicState,
  JoinResult,
  PublicGameEvent,
  RejoinResult,
  RoomState,
} from '@dalmuti/shared';
import { call, socket } from './socket';
import {
  clearSession,
  loadSession,
  markSessionLeft,
  saveNickname,
  saveSession,
  type SavedSession,
} from './session';

/** 화면 이펙트: 내 차례 리본 / 트릭 승리 / 완주 축하 / 혁명 플래시 */
export type FxKind = 'myturn' | 'trick' | 'finish' | 'revolution';
export type FxItem = {
  id: number;
  kind: FxKind;
  text: string;
  /** 강조 변형 (내가 완주 / 대혁명) */
  strong: boolean;
};

type Store = {
  connected: boolean;
  rejoining: boolean;
  me: SavedSession | null;
  room: RoomState | null;
  game: GamePublicState | null;
  hand: Card[];
  pendingTaxReturnCount: number | null;
  chat: ChatMessage[];
  selected: string[];
  /** 턴 제한 마감 시각(epoch ms)과 대상 플레이어 */
  turnDeadlineAt: number | null;
  turnTimerPlayerId: string | null;
  /** 현재 재생 중인 화면 이펙트 (한 번에 하나, 최신 우선) */
  fx: FxItem | null;
  /** 화면 상단 토스트로 보여줄 오류 */
  error: string | null;

  createRoom: (nickname: string) => Promise<void>;
  joinRoom: (roomCode: string, nickname: string) => Promise<void>;
  rejoin: () => Promise<void>;
  leaveRoom: () => Promise<void>;
  startGame: () => Promise<void>;
  updateOptions: (options: Partial<GameOptions>) => Promise<void>;
  addBot: (difficulty: BotDifficulty) => Promise<void>;
  removeBot: (botId: string) => Promise<void>;
  setBotDifficulty: (botId: string, difficulty: BotDifficulty) => Promise<void>;
  playSelected: () => Promise<void>;
  passTurn: () => Promise<void>;
  declareRevolution: (declare: boolean) => Promise<void>;
  payTaxSelected: () => Promise<void>;
  nextRound: () => Promise<void>;
  sendChat: (text: string) => Promise<boolean>;
  toggleSelect: (cardId: string) => void;
  clearSelected: () => void;
  setError: (message: string | null) => void;
  pushFx: (kind: FxKind, text: string, strong?: boolean) => void;
  clearFx: (id: number) => void;
};

let fxSeq = 0;

export const useStore = create<Store>((set, get) => {
  const fail = (message: string) => set({ error: message });

  const onJoined = (data: JoinResult, nickname: string) => {
    const me: SavedSession = {
      roomCode: data.roomCode,
      sessionToken: data.sessionToken,
      playerId: data.playerId,
      nickname,
    };
    saveSession(me);
    saveNickname(nickname);
    set({ me, room: data.room, chat: [], game: null, hand: [], selected: [] });
  };

  return {
    connected: false,
    rejoining: false,
    me: null,
    room: null,
    game: null,
    hand: [],
    pendingTaxReturnCount: null,
    chat: [],
    selected: [],
    turnDeadlineAt: null,
    turnTimerPlayerId: null,
    fx: null,
    error: null,

    async createRoom(nickname) {
      const res = await call<JoinResult>('room:create', { nickname });
      if (res.ok) onJoined(res.data, nickname);
      else fail(res.error.message);
    },

    async joinRoom(roomCode, nickname) {
      const res = await call<JoinResult>('room:join', {
        roomCode: roomCode.trim().toUpperCase(),
        nickname,
      });
      if (res.ok) onJoined(res.data, nickname);
      else fail(res.error.message);
    },

    async rejoin() {
      const saved = loadSession();
      if (!saved) return;
      set({ rejoining: true });
      const res = await call<RejoinResult>('room:rejoin', {
        roomCode: saved.roomCode,
        sessionToken: saved.sessionToken,
      });
      if (res.ok) {
        // 복귀 성공 — 자발적 이탈 플래그 해제
        const restored: SavedSession = {
          roomCode: saved.roomCode,
          sessionToken: saved.sessionToken,
          playerId: saved.playerId,
          nickname: saved.nickname,
        };
        saveSession(restored);
        set({
          me: restored,
          room: res.data.room,
          game: res.data.game,
          chat: res.data.chatHistory,
          rejoining: false,
        });
      } else {
        clearSession();
        set({ rejoining: false });
        if (res.error.code !== 'ROOM_NOT_FOUND') fail(res.error.message);
      }
    },

    async leaveRoom() {
      // 오프라인 상태에서도 즉시 나가져야 하므로 서버 응답을 기다리지 않는다
      // (서버는 ack와 무관하게 disconnect로도 동일하게 정리한다)
      void call('room:leave');
      const { room, game } = get();
      const midGame =
        room?.phase === 'IN_GAME' && game !== null && game.phase !== 'GAME_END';
      if (midGame) {
        // 서버가 좌석을 보존하는 경우이므로 세션 토큰도 보존한다 —
        // 지우면 "재접속으로 복귀 가능" 안내와 달리 영영 복귀할 수 없다.
        // 자동 복귀만 막고(플래그), 홈 화면에서 수동 복귀 버튼을 제공한다.
        markSessionLeft();
      } else {
        clearSession();
      }
      set({
        me: null,
        room: null,
        game: null,
        hand: [],
        chat: [],
        selected: [],
        pendingTaxReturnCount: null,
      });
    },

    async startGame() {
      const res = await call('room:start');
      if (!res.ok) fail(res.error.message);
    },

    async updateOptions(options) {
      const res = await call('room:options', options);
      if (!res.ok) fail(res.error.message);
    },

    async addBot(difficulty) {
      const res = await call('room:addBot', { difficulty });
      if (!res.ok) fail(res.error.message);
    },

    async removeBot(botId) {
      const res = await call('room:removeBot', { botId });
      if (!res.ok) fail(res.error.message);
    },

    async setBotDifficulty(botId, difficulty) {
      const res = await call('room:setBotDifficulty', { botId, difficulty });
      if (!res.ok) fail(res.error.message);
    },

    async playSelected() {
      const { selected } = get();
      if (selected.length === 0) return;
      const res = await call('game:play', { cardIds: selected });
      if (res.ok) set({ selected: [] });
      else fail(res.error.message);
    },

    async passTurn() {
      const res = await call('game:pass');
      if (!res.ok) fail(res.error.message);
    },

    async declareRevolution(declare) {
      const res = await call('game:declareRevolution', { declare });
      if (!res.ok) fail(res.error.message);
    },

    async payTaxSelected() {
      const { selected } = get();
      const res = await call('game:payTax', { cardIds: selected });
      if (res.ok) set({ selected: [] });
      else fail(res.error.message);
    },

    async nextRound() {
      const res = await call('game:nextRound');
      if (!res.ok) fail(res.error.message);
    },

    async sendChat(text) {
      const trimmed = text.trim();
      if (!trimmed) return false;
      const res = await call('chat:send', { text: trimmed });
      if (!res.ok) fail(res.error.message);
      return res.ok;
    },

    toggleSelect(cardId) {
      const { selected } = get();
      set({
        selected: selected.includes(cardId)
          ? selected.filter((id) => id !== cardId)
          : [...selected, cardId],
      });
    },

    clearSelected: () => set({ selected: [] }),
    setError: (message) => set({ error: message }),

    pushFx: (kind, text, strong = false) =>
      set({ fx: { id: ++fxSeq, kind, text, strong } }),
    clearFx: (id) => {
      if (get().fx?.id === id) set({ fx: null });
    },
  };
});

// ── 소켓 이벤트 → 스토어 반영 (모듈 로드 시 1회 등록) ──────────────

socket.on('connect', () => {
  useStore.setState({ connected: true });
  // 저장된 세션이 있으면 복귀를 시도한다.
  // 순간적인 재연결에서도 서버의 새 소켓은 방에 바인딩돼 있지 않으므로
  // (store에 room이 남아 있더라도) rejoin으로 다시 묶어야 한다.
  // 단, 게임 중 "나가기"로 자발적으로 떠난 세션은 자동 복귀하지 않는다.
  const saved = loadSession();
  if (saved && !saved.leftVoluntarily) void useStore.getState().rejoin();
});

socket.on('disconnect', () => {
  useStore.setState({ connected: false });
});

socket.on('room:state', (room: RoomState) => {
  useStore.setState({ room });
});

socket.on('game:state', (game: GamePublicState) => {
  const prev = useStore.getState();
  // 내 차례가 "시작되는" 전이 감지 → 리본 이펙트 (지속 글로우는 상태에서 파생)
  const meId = prev.me?.playerId;
  const becameMyTurn =
    meId !== undefined &&
    game.phase === 'PLAYING' &&
    game.currentTurnPlayerId === meId &&
    prev.game?.currentTurnPlayerId !== meId;
  useStore.setState((s) => ({
    game,
    // 세금 단계가 끝나면 반환 안내도 지운다 (다음 라운드로 새지 않게)
    pendingTaxReturnCount:
      game.phase === 'TAXATION' ? s.pendingTaxReturnCount : null,
  }));
  if (becameMyTurn) prev.pushFx('myturn', '내 차례!');
});

socket.on('game:hand', ({ cards, pendingTaxReturnCount }) => {
  useStore.setState({
    hand: cards,
    pendingTaxReturnCount,
    // 손패가 갱신되면 사라진 카드 선택은 해제
    selected: useStore
      .getState()
      .selected.filter((id) => cards.some((c) => c.id === id)),
  });
});

socket.on('chat:message', (message: ChatMessage) => {
  useStore.setState((s) => ({ chat: [...s.chat.slice(-199), message] }));
});

socket.on('game:timer', ({ deadlineAt, playerId }) => {
  useStore.setState({ turnDeadlineAt: deadlineAt, turnTimerPlayerId: playerId });
});

// 게임 이벤트 → 화면 이펙트 매핑 (서버가 game:state를 먼저 보내므로 닉네임 조회 가능)
socket.on('game:event', (event: PublicGameEvent) => {
  const s = useStore.getState();
  if (!s.game) return;
  const nick = (id: string) =>
    s.game!.players.find((p) => p.id === id)?.nickname ?? '???';
  switch (event.type) {
    case 'TRICK_WON':
      s.pushFx('trick', `⚜ ${nick(event.playerId)} 트릭 승리 ⚜`);
      break;
    case 'PLAYER_FINISHED': {
      const medal =
        event.place === 1 ? '🥇' : event.place === 2 ? '🥈' : event.place === 3 ? '🥉' : '🎉';
      s.pushFx(
        'finish',
        `${medal} ${nick(event.playerId)}님 ${event.place}등 완주!`,
        event.playerId === s.me?.playerId,
      );
      break;
    }
    case 'REVOLUTION_DECLARED':
      s.pushFx('revolution', event.isGreat ? '⚔ 대혁명 ⚔' : '⚔ 혁명 ⚔', event.isGreat);
      break;
    default:
      break;
  }
});
