import { useEffect } from 'react';
import { GamePage } from './pages/Game';
import { HomePage } from './pages/Home';
import { LobbyPage } from './pages/Lobby';
import { useStore } from './store';

export function App() {
  const connected = useStore((s) => s.connected);
  const me = useStore((s) => s.me);
  const room = useStore((s) => s.room);
  const game = useStore((s) => s.game);
  const error = useStore((s) => s.error);
  const setError = useStore((s) => s.setError);
  const versionMismatch = useStore((s) => s.versionMismatch);

  // 오류 토스트 자동 제거
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error, setError]);

  // room:state 브로드캐스트가 ack(me 설정)보다 먼저 도착할 수 있으므로
  // me와 room이 모두 준비된 뒤에만 방 화면으로 전환한다
  const view =
    !room || !me ? 'home' : room.phase === 'IN_GAME' && game ? 'game' : 'lobby';

  return (
    <div className="app">
      {!connected && <div className="conn-banner">서버에 연결하는 중...</div>}
      {versionMismatch && (
        <div className="version-banner">
          🔄 새 버전이 배포되었습니다 — 원활한 플레이를 위해 새로고침 해주세요.
          <button type="button" className="btn btn-sm" onClick={() => location.reload()}>
            새로고침
          </button>
        </div>
      )}
      {error && (
        <div className="toast" onClick={() => setError(null)}>
          ⚠️ {error}
        </div>
      )}
      {view === 'home' && <HomePage />}
      {view === 'lobby' && <LobbyPage />}
      {view === 'game' && <GamePage />}
    </div>
  );
}
