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
  saveNickname,
  saveSession,
  type SavedSession,
} from './session';

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
};

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
        set({
          me: saved,
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
      clearSession();
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
  };
});

// ── 소켓 이벤트 → 스토어 반영 (모듈 로드 시 1회 등록) ──────────────

socket.on('connect', () => {
  useStore.setState({ connected: true });
  // 저장된 세션이 있으면 무조건 복귀를 시도한다.
  // 순간적인 재연결에서도 서버의 새 소켓은 방에 바인딩돼 있지 않으므로
  // (store에 room이 남아 있더라도) rejoin으로 다시 묶어야 한다.
  if (loadSession()) void useStore.getState().rejoin();
});

socket.on('disconnect', () => {
  useStore.setState({ connected: false });
});

socket.on('room:state', (room: RoomState) => {
  useStore.setState({ room });
});

socket.on('game:state', (game: GamePublicState) => {
  useStore.setState((s) => ({
    game,
    // 세금 단계가 끝나면 반환 안내도 지운다 (다음 라운드로 새지 않게)
    pendingTaxReturnCount:
      game.phase === 'TAXATION' ? s.pendingTaxReturnCount : null,
  }));
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

socket.on('game:event', (_event: PublicGameEvent) => {
  // 애니메이션 훅 자리 — 현재 MVP는 상태 스냅샷 + 시스템 채팅으로 충분
});
