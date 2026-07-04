import { useState } from 'react';
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  type BotDifficulty,
  type GameOptions,
} from '@dalmuti/shared';
import { ChatPanel } from '../components/ChatPanel';
import { RulesModal } from '../components/RulesModal';
import { useStore } from '../store';

/** 이 방으로 바로 들어오는 초대 링크 */
function inviteUrl(roomCode: string): string {
  return `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
}

const DIFFICULTY_LABELS: Record<BotDifficulty, string> = {
  easy: '🟢 쉬움',
  normal: '🟡 보통',
  hard: '🔴 어려움',
};

export function LobbyPage() {
  const room = useStore((s) => s.room)!;
  const me = useStore((s) => s.me)!;
  const startGame = useStore((s) => s.startGame);
  const updateOptions = useStore((s) => s.updateOptions);
  const setRoomPublic = useStore((s) => s.setRoomPublic);
  const addBot = useStore((s) => s.addBot);
  const removeBot = useStore((s) => s.removeBot);
  const setBotDifficulty = useStore((s) => s.setBotDifficulty);
  const leaveRoom = useStore((s) => s.leaveRoom);
  const kickPlayer = useStore((s) => s.kickPlayer);
  const isSpectator = useStore((s) => s.isSpectator);
  const sitDown = useStore((s) => s.sitDown);
  const setError = useStore((s) => s.setError);
  const [botDifficulty, setNewBotDifficulty] = useState<BotDifficulty>('normal');
  const [showRules, setShowRules] = useState(false);
  const [copied, setCopied] = useState(false);

  const isHost = room.hostId === me.playerId;
  const canStart = room.players.length >= MIN_PLAYERS;
  const isFull = room.players.length >= MAX_PLAYERS;

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(room.code);
      setError(null);
    } catch {
      /* 클립보드 권한 없음 — 코드는 화면에 보인다 */
    }
  };

  /** 초대 링크: 모바일은 공유 시트(카톡 등), 그 외엔 클립보드 복사 */
  const shareInvite = async () => {
    const url = inviteUrl(room.code);
    try {
      if (navigator.share) {
        await navigator.share({
          title: '달무티 온라인',
          text: `달무티 한 판 어때요? 방 코드 ${room.code}`,
          url,
        });
        return;
      }
    } catch {
      // 공유 시트 취소/미지원 — 복사로 폴백
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('링크 복사에 실패했습니다. 방 코드를 직접 공유해주세요');
    }
  };

  const setOpt = (patch: Partial<GameOptions>) => void updateOptions(patch);

  return (
    <div className="lobby">
      <div className="lobby-main">
        <div className="lobby-header">
          <h2>대기실</h2>
          <button type="button" className="room-code" onClick={() => void copyCode()}>
            방 코드: <strong>{room.code}</strong> 📋
          </button>
          <button type="button" className="btn btn-sm" onClick={() => void shareInvite()}>
            {copied ? '✅ 링크 복사됨!' : '🔗 초대 링크'}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowRules(true)}
          >
            📜 규칙
          </button>
        </div>
        {showRules && <RulesModal onClose={() => setShowRules(false)} />}

        {isSpectator && (
          <div className="lobby-sit-banner">
            👁 관전 중입니다.
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={isFull}
              onClick={() => void sitDown()}
            >
              {isFull ? '좌석이 가득 찼습니다' : '🪑 참가하기'}
            </button>
          </div>
        )}

        <ul className="lobby-players">
          {room.players.map((p) => (
            <li key={p.id} className={p.connected ? '' : 'player-disconnected'}>
              <span className="player-name">
                {p.isHost && '👑 '}
                {p.isBot && '🤖 '}
                {p.nickname}
                {p.id === me.playerId && ' (나)'}
              </span>
              {p.isBot && p.botDifficulty && (
                <span className="bot-controls">
                  {isHost ? (
                    <>
                      <select
                        value={p.botDifficulty}
                        aria-label={`${p.nickname} 난이도`}
                        onChange={(e) =>
                          void setBotDifficulty(p.id, e.target.value as BotDifficulty)
                        }
                      >
                        {(Object.keys(DIFFICULTY_LABELS) as BotDifficulty[]).map((d) => (
                          <option key={d} value={d}>
                            {DIFFICULTY_LABELS[d]}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="bot-remove"
                        aria-label={`${p.nickname} 제거`}
                        onClick={() => void removeBot(p.id)}
                      >
                        ✕
                      </button>
                    </>
                  ) : (
                    <span className="bot-badge">{DIFFICULTY_LABELS[p.botDifficulty]}</span>
                  )}
                </span>
              )}
              {!p.connected && !p.isBot && (
                <span className="player-status">연결 끊김</span>
              )}
              {isHost && !p.isBot && p.id !== me.playerId && (
                <button
                  type="button"
                  className="bot-remove"
                  aria-label={`${p.nickname} 내보내기`}
                  title="내보내기"
                  onClick={() => {
                    if (window.confirm(`${p.nickname}님을 방에서 내보낼까요?`)) {
                      void kickPlayer(p.id);
                    }
                  }}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
          {Array.from({ length: Math.max(0, MIN_PLAYERS - room.players.length) }).map(
            (_, i) => (
              <li key={`empty-${i}`} className="player-empty">
                빈 자리 (최소 {MIN_PLAYERS}명)
              </li>
            ),
          )}
        </ul>

        {isHost && (
          <div className="lobby-bot-row">
            <span>인원이 부족하면 AI 봇으로 채워보세요:</span>
            <select
              value={botDifficulty}
              aria-label="추가할 봇 난이도"
              onChange={(e) => setNewBotDifficulty(e.target.value as BotDifficulty)}
            >
              {(Object.keys(DIFFICULTY_LABELS) as BotDifficulty[]).map((d) => (
                <option key={d} value={d}>
                  {DIFFICULTY_LABELS[d]}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-sm"
              disabled={isFull}
              onClick={() => void addBot(botDifficulty)}
            >
              🤖 봇 추가
            </button>
          </div>
        )}

        <section className="lobby-options">
          <h3>게임 옵션 {!isHost && <small>(방장만 변경 가능)</small>}</h3>
          <label className="opt-row">
            <span>라운드 수</span>
            <select
              disabled={!isHost}
              value={room.options.targetRounds}
              onChange={(e) => setOpt({ targetRounds: Number(e.target.value) })}
            >
              {[1, 3, 5, 7, 10].map((n) => (
                <option key={n} value={n}>
                  {n}라운드
                </option>
              ))}
            </select>
          </label>
          <label className="opt-row">
            <span>세금 규칙</span>
            <input
              type="checkbox"
              disabled={!isHost}
              checked={room.options.enableTaxation}
              onChange={(e) => setOpt({ enableTaxation: e.target.checked })}
            />
          </label>
          <label className="opt-row">
            <span>혁명 규칙</span>
            <input
              type="checkbox"
              disabled={!isHost}
              checked={room.options.enableRevolution}
              onChange={(e) => setOpt({ enableRevolution: e.target.checked })}
            />
          </label>
          <label className="opt-row">
            <span>공개 방 목록 노출</span>
            <input
              type="checkbox"
              disabled={!isHost}
              checked={room.isPublic}
              onChange={(e) => void setRoomPublic(e.target.checked)}
            />
          </label>
        </section>

        <div className="lobby-actions">
          {isHost ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canStart}
              onClick={() => void startGame()}
            >
              {canStart
                ? '게임 시작'
                : `게임 시작 (${room.players.length}/${MIN_PLAYERS}명)`}
            </button>
          ) : (
            <p className="lobby-waiting">방장이 시작하기를 기다리는 중...</p>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => void leaveRoom()}>
            나가기
          </button>
        </div>
      </div>

      <ChatPanel />
    </div>
  );
}
