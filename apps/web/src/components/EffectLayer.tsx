import { useEffect } from 'react';
import { useStore, type FxKind } from '../store';

const FX_DURATION_MS: Record<FxKind, number> = {
  myturn: 1900,
  trick: 1500,
  finish: 2800,
  revolution: 2600,
};

const CONFETTI_COLORS = ['#f1d982', '#e0455a', '#38d1c3', '#d4af37', '#f6e3a8'];
const CONFETTI = Array.from({ length: 14 }, (_, i) => ({
  left: `${(i * 7 + 4) % 100}%`,
  background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
  animationDelay: `${(i % 7) * 0.18}s`,
}));

/**
 * 게임 알림 이펙트 오버레이 — 내 차례 리본 / 트릭 승리 광선 / 완주 콘페티 / 혁명 플래시.
 * 조작을 가리지 않도록 전부 pointer-events: none, 이펙트당 지속 시간 후 자동 제거.
 */
export function EffectLayer() {
  const fx = useStore((s) => s.fx);
  const clearFx = useStore((s) => s.clearFx);

  useEffect(() => {
    if (!fx) return;
    const extra = fx.strong ? 600 : 0;
    const timer = setTimeout(() => clearFx(fx.id), FX_DURATION_MS[fx.kind] + extra);
    return () => clearTimeout(timer);
  }, [fx, clearFx]);

  if (!fx) return null;
  return (
    <div className="fx-layer" key={fx.id} aria-live="polite">
      {fx.kind === 'revolution' && (
        <div className={`fx-flash ${fx.strong ? 'fx-flash-great' : ''}`} />
      )}
      {fx.kind === 'trick' && <div className="fx-rays" />}
      {fx.kind === 'finish' && (
        <div className="fx-confetti" aria-hidden="true">
          {CONFETTI.map((style, i) => (
            <i key={i} style={style} />
          ))}
        </div>
      )}
      <div className={`fx-text fx-text-${fx.kind} ${fx.strong ? 'fx-strong' : ''}`}>
        {fx.text}
      </div>
    </div>
  );
}
