import { useState } from 'react';
import { clearSession, loadNickname, loadSession } from '../session';
import { useStore } from '../store';

export function HomePage() {
  const createRoom = useStore((s) => s.createRoom);
  const joinRoom = useStore((s) => s.joinRoom);
  const rejoin = useStore((s) => s.rejoin);
  const rejoining = useStore((s) => s.rejoining);
  const [nickname, setNickname] = useState(loadNickname());
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
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
      <p className="home-subtitle">중세 신분제 카드게임 — 온라인</p>

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

          <button
            type="button"
            className="btn btn-primary"
            disabled={!nicknameOk || busy}
            onClick={() => void withBusy(() => createRoom(nickname.trim()))}
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
    </div>
  );
}
