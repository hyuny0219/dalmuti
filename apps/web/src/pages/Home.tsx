import { useEffect, useState } from 'react';
import { clearSession, loadNickname, loadSession } from '../session';
import { RulesModal } from '../components/RulesModal';
import { useStore } from '../store';

/**
 * 초대 링크(?room=CODE)로 열렸으면 방 코드를 돌려주고 주소를 정리한다.
 * StrictMode가 초기화 함수를 두 번 호출해도 안전하게 첫 결과를 기억한다.
 */
let inviteCodeCache: string | null = null;
function consumeInviteCode(): string {
  if (inviteCodeCache !== null) return inviteCodeCache;
  const params = new URLSearchParams(window.location.search);
  const code = (params.get('room') ?? '').toUpperCase();
  if (code) {
    // 새로고침/공유 시 파라미터가 다시 발동하지 않게 주소에서 지운다
    window.history.replaceState(null, '', window.location.pathname);
  }
  inviteCodeCache = /^[A-Z0-9]{6}$/.test(code) ? code : '';
  return inviteCodeCache;
}

export function HomePage() {
  const createRoom = useStore((s) => s.createRoom);
  const joinRoom = useStore((s) => s.joinRoom);
  const spectateRoom = useStore((s) => s.spectateRoom);
  const fetchPublicRooms = useStore((s) => s.fetchPublicRooms);
  const publicRooms = useStore((s) => s.publicRooms);
  const publicRoomsLoading = useStore((s) => s.publicRoomsLoading);
  const connected = useStore((s) => s.connected);
  const setError = useStore((s) => s.setError);
  const rejoin = useStore((s) => s.rejoin);
  const rejoining = useStore((s) => s.rejoining);
  const [nickname, setNickname] = useState(loadNickname());
  // 초대 링크로 들어왔으면 방 코드를 미리 채워 닉네임만 입력하면 되게
  const [code, setCode] = useState(consumeInviteCode);
  const [invited] = useState(() => code !== '');
  const [isPublic, setIsPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showRules, setShowRules] = useState(false);

  // 접속되면 공개 방 목록 로드
  useEffect(() => {
    if (connected) void fetchPublicRooms();
  }, [connected, fetchPublicRooms]);
  // 게임 중 "나가기"로 떠난 세션 — 자동 복귀 대신 수동 복귀 버튼을 보여준다
  const [leftSession, setLeftSession] = useState(() => {
    const saved = loadSession();
    return saved?.leftVoluntarily ? saved : null;
  });

  const withBusy = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const nicknameOk = nickname.trim().length >= 1;

  return (
    <div className="home">
      <h1 className="home-title">
        <span className="home-crown">👑</span> 달무티
      </h1>
      <p className="home-subtitle">
        중세 신분제 카드게임 — 온라인
        <button
          type="button"
          className="btn btn-ghost btn-sm rules-link"
          onClick={() => setShowRules(true)}
        >
          📜 규칙 보기
        </button>
      </p>
      {showRules && <RulesModal onClose={() => setShowRules(false)} />}

      {invited && !rejoining && (
        <div className="home-invited">
          🔗 초대 링크로 입장했습니다 — 닉네임을 입력하고 <strong>참가하기</strong>를 누르세요.
        </div>
      )}

      {leftSession && !rejoining && (
        <div className="home-resume">
          <span>
            🎮 <strong>{leftSession.roomCode}</strong> 방에 진행 중이던 게임이 있습니다
          </span>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void rejoin()}>
            복귀하기
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              clearSession();
              setLeftSession(null);
            }}
          >
            버리기
          </button>
        </div>
      )}

      {rejoining ? (
        <p className="home-rejoining">이전 게임으로 복귀 중...</p>
      ) : (
        <div className="home-card">
          <label className="field">
            <span>닉네임</span>
            <input
              value={nickname}
              maxLength={20}
              placeholder="1~20자"
              onChange={(e) => setNickname(e.target.value)}
            />
          </label>

          <label className="home-public-check">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
            />
            공개 방 목록에 노출 (누구나 참가·관전 가능)
          </label>

          <button
            type="button"
            className="btn btn-primary"
            disabled={!nicknameOk || busy}
            onClick={() => void withBusy(() => createRoom(nickname.trim(), isPublic))}
          >
            방 만들기
          </button>

          <div className="home-divider">또는</div>

          <div className="home-join-row">
            <input
              value={code}
              maxLength={6}
              placeholder="방 코드 (예: ABC123)"
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
            <button
              type="button"
              className="btn"
              disabled={!nicknameOk || code.trim().length !== 6 || busy}
              onClick={() => void withBusy(() => joinRoom(code, nickname.trim()))}
            >
              참가하기
            </button>
          </div>
        </div>
      )}

      {!rejoining && (
        <section className="public-rooms">
          <div className="public-rooms-head">
            <h3>공개 방</h3>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={publicRoomsLoading}
              onClick={() => void fetchPublicRooms()}
            >
              {publicRoomsLoading ? '불러오는 중...' : '↻ 새로고침'}
            </button>
          </div>
          {publicRooms.length === 0 ? (
            <p className="public-rooms-empty">
              지금 공개된 방이 없습니다. 방을 만들 때 "공개 방 목록에 노출"을 켜면 여기에 표시됩니다.
            </p>
          ) : (
            <ul className="public-rooms-list">
              {publicRooms.map((r) => (
                <li key={r.code}>
                  <span className="pr-code">{r.code}</span>
                  <span className="pr-host">{r.hostNickname}</span>
                  <span className="pr-meta">
                    {r.playerCount}/{r.maxPlayers}명
                    {r.inGame
                      ? ` · 라운드 ${r.round}/${r.targetRounds}`
                      : ' · 대기 중'}
                    {r.spectatorCount > 0 && ` · 👁 ${r.spectatorCount}`}
                  </span>
                  {r.inGame ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      onClick={() => {
                        if (!nicknameOk) return setError('먼저 닉네임을 입력해주세요');
                        void withBusy(() => spectateRoom(r.code, nickname.trim()));
                      }}
                    >
                      👁 관전
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={busy || r.playerCount >= r.maxPlayers}
                      onClick={() => {
                        if (!nicknameOk) return setError('먼저 닉네임을 입력해주세요');
                        void withBusy(() => joinRoom(r.code, nickname.trim()));
                      }}
                    >
                      참가
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
