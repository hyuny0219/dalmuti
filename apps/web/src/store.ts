import { create } from 'zustand';
import {
  PROTOCOL_VERSION,
  type BotDifficulty,
  type Card,
  type ChatMessage,
  type GameOptions,
  type GamePublicState,
  type JoinResult,
  type PublicGameEvent,
  type PublicRoomSummary,
  type RejoinResult,
  type RoomState,
  type SocialRank,
  type SpectateResult,
} from '@dalmuti/shared';
import { call, socket } from './socket';
import { notifyMyTurn } from './notify';
import { recordGameResult } from './stats';
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

/** 게임 종료 요약용 라운드별 결과 (클라이언트가 ROUND_ENDED 이벤트를 누적) */
export type RoundResult = {
  round: number;
  placements: Array<{ playerId: string; place: number; rank: SocialRank }>;
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
  /** 관전자로 입장한 상태 (좌석 없음, 게임 액션 불가) */
  isSpectator: boolean;
  /** 홈 화면 공개 방 목록 */
  publicRooms: PublicRoomSummary[];
  publicRoomsLoading: boolean;
  /** 화면 상단 토스트로 보여줄 오류 */
  error: string | null;
  /** 서버가 새 프로토콜로 배포됨 — 새로고침 안내 배너 */
  versionMismatch: boolean;
  /** 내가 채팅을 가리기로 한 플레이어 id (이 브라우저에서만, 방 단위) */
  mutedIds: string[];
  /** 이번 게임의 라운드별 결과 (종료 요약용) */
  roundHistory: RoundResult[];

  createRoom: (nickname: string, isPublic?: boolean) => Promise<void>;
  joinRoom: (roomCode: string, nickname: string) => Promise<void>;
  spectateRoom: (roomCode: string, nickname: string) => Promise<void>;
  fetchPublicRooms: () => Promise<void>;
  setRoomPublic: (isPublic: boolean) => Promise<void>;
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
  /** 관전자 → 참가자 전환 (대기/게임 종료 상태에서만) */
  sitDown: () => Promise<void>;
  /** 방장: 사람 멤버 내보내기 (로비 전용) */
  kickPlayer: (playerId: string) => Promise<void>;
  toggleMute: (playerId: string) => void;
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
    set({
      me,
      room: data.room,
      chat: [],
      game: null,
      hand: [],
      selected: [],
      isSpectator: false,
      mutedIds: [],
      roundHistory: [],
    });
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
    isSpectator: false,
    publicRooms: [],
    publicRoomsLoading: false,
    error: null,
    versionMismatch: false,
    mutedIds: [],
    roundHistory: [],

    async createRoom(nickname, isPublic = false) {
      const res = await call<JoinResult>('room:create', { nickname, isPublic });
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

    async spectateRoom(roomCode, nickname) {
      const res = await call<SpectateResult>('room:spectate', {
        roomCode: roomCode.trim().toUpperCase(),
        nickname,
      });
      if (!res.ok) return fail(res.error.message);
      saveNickname(nickname);
      // 관전은 세션을 저장하지 않는다 (새로고침 시 홈으로)
      set({
        me: {
          roomCode: res.data.room.code,
          sessionToken: '',
          playerId: res.data.spectatorId,
          nickname,
        },
        room: res.data.room,
        game: res.data.game,
        chat: res.data.chatHistory,
        hand: [],
        selected: [],
        isSpectator: true,
      });
    },

    async fetchPublicRooms() {
      set({ publicRoomsLoading: true });
      const res = await call<PublicRoomSummary[]>('room:list');
      set({
        publicRooms: res.ok ? res.data : [],
        publicRoomsLoading: false,
      });
      if (!res.ok) fail(res.error.message);
    },

    async setRoomPublic(isPublic) {
      const res = await call('room:setPublic', { isPublic });
      if (!res.ok) fail(res.error.message);
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
        // 방이 사라진 가장 흔한 원인은 서버 재시작(배포/슬립) — 원인을 알 수 있게 안내한다
        if (res.error.code === 'ROOM_NOT_FOUND') {
          fail('이전 게임 방을 찾을 수 없습니다 — 서버가 재시작되었거나 방이 종료된 것 같아요.');
        } else {
          fail(res.error.message);
        }
      }
    },

    async leaveRoom() {
      // 오프라인 상태에서도 즉시 나가져야 하므로 서버 응답을 기다리지 않는다
      // (서버는 ack와 무관하게 disconnect로도 동일하게 정리한다)
      void call('room:leave');
      const { room, game, isSpectator } = get();
      const midGame =
        !isSpectator &&
        room?.phase === 'IN_GAME' &&
        game !== null &&
        game.phase !== 'GAME_END';
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
        isSpectator: false,
        mutedIds: [],
        roundHistory: [],
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

    async sitDown() {
      const { me } = get();
      const res = await call<JoinResult>('room:sit');
      if (!res.ok) return fail(res.error.message);
      const nickname = me?.nickname ?? '';
      // 이제 정식 참가자 — 세션을 저장해 재접속 복구 대상이 된다
      const session = {
        roomCode: res.data.roomCode,
        sessionToken: res.data.sessionToken,
        playerId: res.data.playerId,
        nickname,
      };
      saveSession(session);
      set({ me: session, room: res.data.room, isSpectator: false });
    },

    async kickPlayer(playerId) {
      const res = await call('room:kick', { playerId });
      if (!res.ok) fail(res.error.message);
    },

    toggleMute(playerId) {
      const { mutedIds } = get();
      set({
        mutedIds: mutedIds.includes(playerId)
          ? mutedIds.filter((id) => id !== playerId)
          : [...mutedIds, playerId],
      });
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

socket.on('server:hello', ({ protocolVersion }) => {
  // 배포 직후 구버전 번들을 들고 있는 탭 — 새로고침 안내 배너를 띄운다
  if (protocolVersion !== PROTOCOL_VERSION) {
    useStore.setState({ versionMismatch: true });
  }
});

socket.on('room:kicked', () => {
  clearSession();
  useStore.setState({
    me: null,
    room: null,
    game: null,
    hand: [],
    chat: [],
    selected: [],
    pendingTaxReturnCount: null,
    isSpectator: false,
    mutedIds: [],
    roundHistory: [],
    error: '방장이 회원님을 내보냈습니다.',
  });
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
  // 세금 반환/혁명 선택도 "내가 행동할 차례" — 백그라운드 탭 알림 대상
  const becameMyTax =
    meId !== undefined &&
    game.phase === 'TAXATION' &&
    game.taxationPendingIds.includes(meId) &&
    !(prev.game?.phase === 'TAXATION' && prev.game.taxationPendingIds.includes(meId));
  const becameMyRevolution =
    meId !== undefined &&
    game.phase === 'REVOLUTION' &&
    game.revolutionCandidateId === meId &&
    prev.game?.revolutionCandidateId !== meId;
  useStore.setState((s) => ({
    game,
    // 세금 단계가 끝나면 반환 안내도 지운다 (다음 라운드로 새지 않게)
    pendingTaxReturnCount:
      game.phase === 'TAXATION' ? s.pendingTaxReturnCount : null,
  }));
  if (becameMyTurn) prev.pushFx('myturn', '내 차례!');
  if (becameMyTurn) notifyMyTurn();
  else if (becameMyTax) notifyMyTurn('🔔 세금 반환 차례!');
  else if (becameMyRevolution) notifyMyTurn('🔔 혁명 선택!');
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

socket.on('room:closed', () => {
  const s = useStore.getState();
  if (!s.room) return;
  clearSession();
  useStore.setState({
    me: null,
    room: null,
    game: null,
    hand: [],
    chat: [],
    selected: [],
    pendingTaxReturnCount: null,
    isSpectator: false,
    mutedIds: [],
    roundHistory: [],
    error: '방이 종료되었습니다.',
  });
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
    // ── 게임 종료 요약용 라운드 결과 누적 ──
    case 'ROUND_STARTED':
      if (event.round === 1) useStore.setState({ roundHistory: [] }); // 새 게임(재대결 포함)
      break;
    case 'ROUND_ENDED':
      useStore.setState({
        roundHistory: [
          ...s.roundHistory,
          { round: event.round, placements: event.placements },
        ],
      });
      break;
    case 'GAME_ENDED': {
      // 개인 전적 기록 (관전자는 제외). 공동 1위는 승리로 인정
      const meId = s.me?.playerId;
      if (!s.isSpectator && meId && s.game.players.some((p) => p.id === meId)) {
        const myScore = s.game.players.find((p) => p.id === meId)?.score ?? 0;
        const topScore = Math.max(...s.game.players.map((p) => p.score));
        const dalmutiRounds = useStore
          .getState()
          .roundHistory.filter((r) =>
            r.placements.some((pl) => pl.playerId === meId && pl.place === 1),
          ).length;
        recordGameResult(myScore === topScore, dalmutiRounds);
      }
      break;
    }
    default:
      break;
  }
});
