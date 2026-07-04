import { useEffect, useMemo, useState } from 'react';
import {
  analyzeCombo,
  canBeat,
  type GamePublicState,
  type PlayerPublic,
} from '@dalmuti/shared';
import { CardBackStack, CardView } from '../components/CardView';
import { ChatPanel } from '../components/ChatPanel';
import { EffectLayer } from '../components/EffectLayer';
import { placeMedal, SOCIAL_RANK_LABELS } from '../format';
import { useStore } from '../store';

export function GamePage() {
  const game = useStore((s) => s.game);
  const me = useStore((s) => s.me)!;
  if (!game) return <div className="game-loading">게임 정보를 불러오는 중...</div>;
  return <GameBoard game={game} myId={me.playerId} />;
}

function GameBoard({ game, myId }: { game: GamePublicState; myId: string }) {
  const room = useStore((s) => s.room)!;
  const hand = useStore((s) => s.hand);
  const selected = useStore((s) => s.selected);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const playSelected = useStore((s) => s.playSelected);
  const passTurn = useStore((s) => s.passTurn);
  const leaveRoom = useStore((s) => s.leaveRoom);

  const mySeat = game.players.findIndex((p) => p.id === myId);
  const opponents = useMemo(
    () =>
      mySeat < 0
        ? game.players
        : [...game.players.slice(mySeat + 1), ...game.players.slice(0, mySeat)],
    [game.players, mySeat],
  );
  const meState = game.players.find((p) => p.id === myId);
  const isMyTurn = game.currentTurnPlayerId === myId;

  // 클라이언트 선검증 (서버가 최종 검증) — 버튼 활성화 UX용
  const selectedCards = hand.filter((c) => selected.includes(c.id));
  const combo = selectedCards.length > 0 ? analyzeCombo(selectedCards) : null;
  const canPlaySelection =
    isMyTurn && combo !== null && (game.field === null || canBeat(game.field, combo));

  return (
    <div className="game">
      {/* 내 차례 동안 화면 가장자리 금빛 맥동 */}
      {isMyTurn && game.phase === 'PLAYING' && <div className="fx-edge" aria-hidden="true" />}
      <EffectLayer />
      <div className="game-main">
        <header className="game-header">
          <span>
            라운드 {game.round}/{game.targetRounds}
          </span>
          <TurnCountdown myId={myId} />
          <span className="game-room-code">방 {room.code}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              if (window.confirm('게임에서 나갈까요? 세션이 유지되어 다시 접속하면 복귀할 수 있습니다.')) {
                void leaveRoom();
              }
            }}
          >
            나가기
          </button>
        </header>

        <div className="opponents">
          {opponents.map((p) => (
            <OpponentSeat
              key={p.id}
              player={p}
              isTurn={game.currentTurnPlayerId === p.id}
            />
          ))}
        </div>

        <div className="table-center">
          {game.field ? (
            <>
              <div className="field-cards">
                {game.field.cards.map((c) => (
                  <CardView key={c.id} card={c} small />
                ))}
              </div>
              <div className="field-hint">
                {game.field.count}장 · {game.field.effectiveRank}보다 낮은 숫자로만
                <span className="field-owner">
                  {' '}
                  ({nickOf(game, game.field.ownerId)}님이 냄)
                </span>
              </div>
            </>
          ) : (
            <div className="field-empty">
              {game.phase === 'PLAYING'
                ? `${nickOf(game, game.currentTurnPlayerId)}님이 새 트릭을 리드합니다`
                : ''}
            </div>
          )}
        </div>

        <div className="my-area">
          <div className="my-info">
            <span className="my-name">
              {meState?.rank && (
                <span className="rank-badge">
                  {SOCIAL_RANK_LABELS[meState.rank].emoji}{' '}
                  {SOCIAL_RANK_LABELS[meState.rank].label}
                </span>
              )}
              {isMyTurn && game.phase === 'PLAYING' && (
                <span className="turn-indicator">내 차례!</span>
              )}
              {meState?.finishedPlace && (
                <span className="finished-indicator">
                  {placeMedal(meState.finishedPlace)} 완주!
                </span>
              )}
            </span>
            <span className="my-score">점수 {meState?.score ?? 0}</span>
          </div>

          <div className="my-hand">
            {hand.map((c) => (
              <CardView
                key={c.id}
                card={c}
                selected={selected.includes(c.id)}
                onClick={() => toggleSelect(c.id)}
              />
            ))}
            {hand.length === 0 && game.phase === 'PLAYING' && (
              <div className="hand-empty">손패를 모두 털었습니다 🎉</div>
            )}
          </div>

          {game.phase === 'PLAYING' && hand.length > 0 && (
            <div className="my-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canPlaySelection}
                onClick={() => void playSelected()}
              >
                내기 {selected.length > 0 && `(${selected.length}장)`}
              </button>
              <button
                type="button"
                className="btn"
                disabled={!isMyTurn || game.field === null}
                onClick={() => void passTurn()}
              >
                패스
              </button>
            </div>
          )}
        </div>
      </div>

      <ChatPanel />
      <PhaseOverlay game={game} myId={myId} />
    </div>
  );
}

function OpponentSeat({ player, isTurn }: { player: PlayerPublic; isTurn: boolean }) {
  return (
    <div
      className={[
        'seat',
        isTurn ? 'seat-turn' : '',
        player.connected ? '' : 'seat-disconnected',
      ].join(' ')}
    >
      <div className="seat-name">
        {player.nickname}
        {player.isBot && ' 🤖'}
        {isTurn && <span className="seat-turn-label">차례</span>}
      </div>
      <div className="seat-rank">
        {player.rank && (
          <>
            {SOCIAL_RANK_LABELS[player.rank].emoji}{' '}
            {SOCIAL_RANK_LABELS[player.rank].label}
          </>
        )}
      </div>
      {player.finishedPlace ? (
        <div className="seat-finished">{placeMedal(player.finishedPlace)} 완주</div>
      ) : (
        <CardBackStack count={player.handCount} />
      )}
      {!player.connected && <div className="seat-status">연결 끊김</div>}
      <div className="seat-score">{player.score}점</div>
    </div>
  );
}

/** REVOLUTION / TAXATION / ROUND_END / GAME_END 단계 오버레이 */
function PhaseOverlay({ game, myId }: { game: GamePublicState; myId: string }) {
  const room = useStore((s) => s.room)!;
  const hand = useStore((s) => s.hand);
  const selected = useStore((s) => s.selected);
  const toggleSelect = useStore((s) => s.toggleSelect);
  const pendingTaxReturnCount = useStore((s) => s.pendingTaxReturnCount);
  const payTaxSelected = useStore((s) => s.payTaxSelected);
  const declareRevolution = useStore((s) => s.declareRevolution);
  const nextRound = useStore((s) => s.nextRound);
  const startGame = useStore((s) => s.startGame);
  const leaveRoom = useStore((s) => s.leaveRoom);

  const isHost = room.hostId === myId;

  if (game.phase === 'REVOLUTION') {
    const candidate = game.revolutionCandidateId;
    if (candidate === myId) {
      return (
        <div className="overlay">
          <div className="overlay-card">
            <h3>🃏 광대 2장을 손에 넣었습니다!</h3>
            <p>혁명을 선언하면 이번 라운드의 세금이 면제됩니다.</p>
            <p className="overlay-note">
              당신이 대농노라면 <strong>대혁명</strong> — 계급이 완전히 역전됩니다!
            </p>
            <div className="overlay-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void declareRevolution(true)}
              >
                혁명 선언!
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void declareRevolution(false)}
              >
                포기
              </button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="overlay overlay-passive">
        <div className="overlay-banner">
          {nickOf(game, candidate)}님이 혁명을 고민하고 있습니다...
        </div>
      </div>
    );
  }

  if (game.phase === 'TAXATION') {
    // 반환 의무는 공개 상태(taxationPendingIds)로 판단한다 —
    // 정확한 장수(pendingTaxReturnCount)는 game:hand로 곧 도착하지만,
    // 그 사이에도 잘못된 '대기' 배너가 깜빡이지 않도록 계급으로 유추해 둔다.
    const iOweTax = game.taxationPendingIds.includes(myId);
    if (iOweTax) {
      const myRank = game.players.find((p) => p.id === myId)?.rank;
      const returnCount =
        pendingTaxReturnCount ?? (myRank === 'GREATER_DALMUTI' ? 2 : 1);
      const canSubmit = selected.length === returnCount;
      return (
        <div className="overlay">
          <div className="overlay-card overlay-wide">
            <h3>💰 세금 반환</h3>
            <p>농노에게 돌려줄 카드 {returnCount}장을 선택하세요.</p>
            <div className="overlay-hand">
              {hand.map((c) => (
                <CardView
                  key={c.id}
                  card={c}
                  selected={selected.includes(c.id)}
                  onClick={() => toggleSelect(c.id)}
                />
              ))}
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canSubmit}
              onClick={() => void payTaxSelected()}
            >
              {selected.length}/{returnCount}장 돌려주기
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="overlay overlay-passive">
        <div className="overlay-banner">
          세금 교환 중... (
          {game.taxationPendingIds.map((id) => nickOf(game, id)).join(', ')}님의 반환 대기)
        </div>
      </div>
    );
  }

  if (game.phase === 'ROUND_END' || game.phase === 'GAME_END') {
    const isEnd = game.phase === 'GAME_END';
    const byPlace = [...game.players].sort(
      (a, b) => (a.finishedPlace ?? 99) - (b.finishedPlace ?? 99),
    );
    const byScore = [...game.players].sort((a, b) => b.score - a.score);
    const list = isEnd ? byScore : byPlace;
    return (
      <div className="overlay">
        <div className="overlay-card overlay-wide">
          <h3>{isEnd ? '🏁 게임 종료!' : `라운드 ${game.round} 종료`}</h3>
          <table className="result-table">
            <thead>
              <tr>
                <th>{isEnd ? '최종 순위' : '완주'}</th>
                <th>이름</th>
                <th>{isEnd ? '점수' : '다음 계급'}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p, i) => (
                <tr key={p.id} className={p.id === myId ? 'result-me' : ''}>
                  <td>{isEnd ? placeMedal(i + 1) : placeMedal(p.finishedPlace)}</td>
                  <td>
                    {p.nickname}
                    {p.id === myId && ' (나)'}
                  </td>
                  <td>
                    {isEnd
                      ? `${p.score}점`
                      : p.rank
                        ? `${SOCIAL_RANK_LABELS[p.rank].emoji} ${SOCIAL_RANK_LABELS[p.rank].label}`
                        : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="overlay-actions">
            {isHost ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void (isEnd ? startGame() : nextRound())}
              >
                {isEnd ? '새 게임 시작' : '다음 라운드'}
              </button>
            ) : (
              <p className="overlay-note">방장이 진행하기를 기다리는 중...</p>
            )}
            {isEnd && (
              <button type="button" className="btn btn-ghost" onClick={() => void leaveRoom()}>
                방 나가기
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
}

function nickOf(game: GamePublicState, playerId: string | null): string {
  return game.players.find((p) => p.id === playerId)?.nickname ?? '???';
}

/** 턴 제한 카운트다운 — 서버 game:timer 이벤트 기반 */
function TurnCountdown({ myId }: { myId: string }) {
  const deadlineAt = useStore((s) => s.turnDeadlineAt);
  const timerPlayerId = useStore((s) => s.turnTimerPlayerId);
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!deadlineAt) {
      setRemaining(null);
      return;
    }
    const tick = () => setRemaining(Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000)));
    tick();
    const interval = setInterval(tick, 500);
    return () => clearInterval(interval);
  }, [deadlineAt]);

  if (remaining === null || timerPlayerId === null) return null;
  const mine = timerPlayerId === myId;
  return (
    <span className={`turn-countdown ${mine && remaining <= 10 ? 'countdown-urgent' : ''}`}>
      ⏰ {remaining}초
    </span>
  );
}
