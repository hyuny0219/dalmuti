import { RANK_NAMES_KO } from '@dalmuti/shared';
import { RANK_EMOJI } from '../format';

/** 처음 온 사람을 위한 한 페이지 규칙 요약 (공개 방 유입 대응) */
export function RulesModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="overlay-card overlay-wide rules-card"
        role="dialog"
        aria-label="게임 규칙"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rules-head">
          <h3>📜 달무티 규칙 요약</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            ✕ 닫기
          </button>
        </div>

        <div className="rules-body">
          <section>
            <h4>🎯 목표</h4>
            <p>
              손패를 가장 먼저 털면 승리! 완주 순서가 다음 라운드의 <strong>계급</strong>이 되고,
              계급이 높을수록 점수를 많이 받습니다.
            </p>
          </section>

          <section>
            <h4>🃏 카드 내기</h4>
            <ul>
              <li>
                <strong>같은 숫자</strong>의 카드를 1장 이상 묶어서 냅니다. 숫자가{' '}
                <strong>낮을수록 강한</strong> 카드입니다 (1 = 달무티가 최강).
              </li>
              <li>
                앞 사람이 낸 것과 <strong>같은 장수</strong>, 더 <strong>낮은 숫자</strong>로만
                받아칠 수 있습니다. 못 받으면 패스.
              </li>
              <li>전원이 패스하면 마지막에 낸 사람이 다음 트릭을 새로 리드합니다.</li>
              <li>
                <strong>광대(13)</strong> 2장은 와일드카드 — 아무 숫자에나 끼워 낼 수 있습니다.
              </li>
            </ul>
          </section>

          <section>
            <h4>💰 세금</h4>
            <p>
              라운드 시작 시 최하층(농노)은 <strong>가장 강한 카드</strong>를 달무티에게 상납하고
              (대농노 2장·소농노 1장), 달무티는 원하는 카드를 같은 장수만큼 돌려줍니다.
            </p>
          </section>

          <section>
            <h4>⚔ 혁명</h4>
            <p>
              세금 전, <strong>광대 2장</strong>을 쥔 사람은 혁명을 선언해 이번 라운드 세금을 없앨
              수 있습니다. 그 사람이 <strong>대농노라면 대혁명</strong> — 계급이 통째로
              역전됩니다!
            </p>
          </section>

          <section>
            <h4>👑 카드 한 벌 (80장)</h4>
            <p className="rules-ranks">
              {Array.from({ length: 13 }, (_, i) => i + 1).map((rank) => (
                <span key={rank} className="rules-rank">
                  {RANK_EMOJI[rank]} {rank === 13 ? '광대×2' : `${rank} ${RANK_NAMES_KO[rank]}×${rank}`}
                </span>
              ))}
            </p>
            <p className="overlay-note">숫자 N 카드는 N장씩 — 강한 카드일수록 귀합니다.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
