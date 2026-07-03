import { MIN_PLAYERS, type GameOptions } from '@dalmuti/shared';
import { ChatPanel } from '../components/ChatPanel';
import { useStore } from '../store';

export function LobbyPage() {
  const room = useStore((s) => s.room)!;
  const me = useStore((s) => s.me)!;
  const startGame = useStore((s) => s.startGame);
  const updateOptions = useStore((s) => s.updateOptions);
  const leaveRoom = useStore((s) => s.leaveRoom);
  const setError = useStore((s) => s.setError);

  const isHost = room.hostId === me.playerId;
  const canStart = room.players.length >= MIN_PLAYERS;

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(room.code);
      setError(null);
    } catch {
      /* 클립보드 권한 없음 — 코드는 화면에 보인다 */
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
        </div>

        <ul className="lobby-players">
          {room.players.map((p) => (
            <li key={p.id} className={p.connected ? '' : 'player-disconnected'}>
              <span className="player-name">
                {p.isHost && '👑 '}
                {p.nickname}
                {p.id === me.playerId && ' (나)'}
              </span>
              {!p.connected && <span className="player-status">연결 끊김</span>}
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
