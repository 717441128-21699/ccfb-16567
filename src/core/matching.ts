/**
 * 合成场景下的轨迹-航标绑定：用场景已知的灯位与轨迹做最近邻一一匹配，
 * 并加灯质形态门控（常亮轨迹只配常亮航标、闪烁轨迹不配常亮航标）。
 * 真实视频走人工绑定，不用本模块。
 */
import type { LightCharacteristic, SceneConfig, Track, TrackAidMatch } from './types';

export interface ReferenceLight {
  aidId: string;
  x: number;
  y: number;
  characteristic: LightCharacteristic;
}

/** 取场景中航标灯的基准坐标与规定灯质（去掉干扰灯） */
export function sceneReferences(cfg: SceneConfig): ReferenceLight[] {
  return cfg.lights
    .filter((l) => l.aidId !== null)
    .map((l) => ({ aidId: l.aidId!, x: l.x, y: l.y, characteristic: l.characteristic }));
}

function trackAnchor(t: Track): { x: number; y: number } | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const p of t.positions) {
    if (p) {
      sx += p.x;
      sy += p.y;
      n++;
    }
  }
  return n ? { x: sx / n, y: sy / n } : null;
}

/** 灯质形态门控：常亮轨迹只配常亮航标，闪烁轨迹不配常亮航标 */
function characteristicCompatible(track: Track, ref: ReferenceLight): boolean {
  const refSteady = ref.characteristic === 'fixed';
  return track.steady === true ? refSteady : !refSteady;
}

/**
 * 最近邻贪心一一匹配。大浪下轨迹质心可能偏离基准位较多，门限放宽到 70px。
 * 灯质形态门控仅作软约束：先按门控匹配，未配出去的航标再用纯位置最近邻兜底，
 * 避免浓雾下 steady 误判导致闪烁灯漏配。
 */
export function matchByScene(
  tracks: Track[],
  refs: ReferenceLight[],
  maxDist = 70,
): TrackAidMatch[] {
  const eligible = tracks.filter(
    (t) => t.confirmed && t.rejected !== 'reflection' && t.rejected !== 'too-short',
  );
  const anchors = new Map(eligible.map((t) => [t.id, trackAnchor(t)]));

  const buildPairs = (useGate: boolean): { trackId: number; aidId: string; d: number }[] => {
    const pairs: { trackId: number; aidId: string; d: number }[] = [];
    for (const t of eligible) {
      const anchor = anchors.get(t.id);
      if (!anchor) continue;
      for (const r of refs) {
        const d = Math.hypot(anchor.x - r.x, anchor.y - r.y);
        if (d > maxDist) continue;
        if (useGate && !characteristicCompatible(t, r)) continue;
        pairs.push({ trackId: t.id, aidId: r.aidId, d });
      }
    }
    return pairs.sort((a, b) => a.d - b.d);
  };

  const greedy = (pairs: { trackId: number; aidId: string; d: number }[]): TrackAidMatch[] => {
    const usedTracks = new Set<number>();
    const usedAids = new Set<string>();
    const out: TrackAidMatch[] = [];
    for (const p of pairs) {
      if (usedTracks.has(p.trackId) || usedAids.has(p.aidId)) continue;
      usedTracks.add(p.trackId);
      usedAids.add(p.aidId);
      out.push({ trackId: p.trackId, aidId: p.aidId });
    }
    return out;
  };

  // 第一轮：带灯质门控
  const gated = greedy(buildPairs(true));
  // 第二轮：未匹配航标用纯位置最近邻兜底
  const matchedAids = new Set(gated.map((m) => m.aidId));
  const fallback = greedy(buildPairs(false).filter((p) => !matchedAids.has(p.aidId)));
  return [...gated, ...fallback];
}
