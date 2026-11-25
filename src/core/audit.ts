/**
 * 核查比对：实测灯质 vs 航标表标称灯质，输出逐项不一致明细。
 * 容差按验收指标设定：周期 ±0.2s，灯色误判率由分类器保证，这里做硬比对。
 */
import type {
  AuditItem, AuditReport, Beacon, LightCharacteristics, TrackAnalysis,
} from './types';
import { COLOR_LABEL, describeKind } from './lightModel';

export interface AuditTolerance {
  periodSec: number;
  onSec: number;
}

export const DEFAULT_TOLERANCE: AuditTolerance = {
  periodSec: 0.2,
  onSec: 0.15,
};

export function compareCharacteristics(
  measured: LightCharacteristics,
  nominal: LightCharacteristics,
  tol: AuditTolerance = DEFAULT_TOLERANCE,
): string[] {
  const mismatches: string[] = [];
  if (measured.kind !== nominal.kind) {
    mismatches.push(`灯质种类不符：实测 ${describeKind(measured)}，应为 ${describeKind(nominal)}`);
  }
  if (
    nominal.kind === 'group'
    && measured.kind === 'group'
    && measured.groupCount !== nominal.groupCount
  ) {
    mismatches.push(`联闪次数不符：实测每组 ${measured.groupCount} 次，应为 ${nominal.groupCount} 次`);
  }
  if (
    nominal.kind === 'morse'
    && measured.kind === 'morse'
    && measured.morseLetter !== nominal.morseLetter
  ) {
    mismatches.push(`莫尔斯字符不符：实测 ${measured.morseLetter}，应为 ${nominal.morseLetter}`);
  }
  if (Math.abs(measured.periodSec - nominal.periodSec) > tol.periodSec) {
    mismatches.push(
      `周期不符：实测 ${measured.periodSec.toFixed(2)}s，标称 ${nominal.periodSec.toFixed(2)}s，`
      + `偏差 ${(measured.periodSec - nominal.periodSec).toFixed(2)}s 超过 ±${tol.periodSec}s`,
    );
  }
  if (
    nominal.kind !== 'fixed' && nominal.kind !== 'alternating'
    && Math.abs(measured.onSec - nominal.onSec) > tol.onSec
  ) {
    mismatches.push(
      `明时长不符：实测 ${measured.onSec.toFixed(2)}s，标称 ${nominal.onSec.toFixed(2)}s`,
    );
  }
  if (measured.color !== nominal.color) {
    mismatches.push(`灯色不符：实测 ${COLOR_LABEL[measured.color]}色，应为 ${COLOR_LABEL[nominal.color]}色`);
  }
  if (
    nominal.kind === 'alternating'
    && measured.kind === 'alternating'
    && measured.alternateColor !== nominal.alternateColor
  ) {
    mismatches.push(
      `互光副色不符：实测 ${COLOR_LABEL[measured.alternateColor ?? 'white']}色，`
      + `应为 ${COLOR_LABEL[nominal.alternateColor ?? 'white']}色`,
    );
  }
  return mismatches;
}

/**
 * 轨迹与航标自动配对：按画面位置（归一化坐标）最近邻。
 * 航标可选 nx/ny（存在 beacon.note 之外的扩展字段里，这里用 locationHint）。
 */
export function autoAssignBeacons(
  analyses: TrackAnalysis[],
  tracks: { id: number; cx: number; cy: number }[],
  beacons: Beacon[],
  frameWidth: number,
  frameHeight: number,
  hints?: Record<string, { nx: number; ny: number }>,
): Map<number, string> {
  const trackPos = new Map(tracks.map((t) => [t.id, t]));
  const assign = new Map<number, string>();
  const usedBeacons = new Set<string>();
  const entries = analyses
    .filter((a) => !a.isDistractor || true) // 全部参与，常亮坏灯也要配对核查
    .map((a) => {
      const tr = trackPos.get(a.trackId)!;
      return {
        analysis: a,
        nx: tr.cx / frameWidth,
        ny: tr.cy / frameHeight,
      };
    })
    // 有 hint 的航标优先匹配
    .sort((a, b) => a.ny - b.ny);

  for (const entry of entries) {
    let bestId: string | null = null;
    let bestD = Infinity;
    for (const beacon of beacons) {
      if (usedBeacons.has(beacon.id)) continue;
      const hint = hints?.[beacon.id];
      if (!hint) continue;
      const d = Math.hypot(entry.nx - hint.nx, entry.ny - hint.ny);
      if (d < bestD) {
        bestD = d;
        bestId = beacon.id;
      }
    }
    if (bestId && bestD < 0.25) {
      assign.set(entry.analysis.trackId, bestId);
      usedBeacons.add(bestId);
    }
  }
  // 无 hint 时按从上到下、从左到右顺序兜底配对
  if (assign.size === 0 && beacons.length > 0) {
    const ordered = [...entries].sort((a, b) => a.ny - b.ny || a.nx - b.nx);
    ordered.forEach((e, i) => {
      const beacon = beacons[i];
      if (beacon) assign.set(e.analysis.trackId, beacon.id);
    });
  }
  return assign;
}

export function buildAuditReport(
  beacons: Beacon[],
  analyses: TrackAnalysis[],
  meta: { videoName: string; durationSec: number; sampleFps: number; totalTracks: number; distractorTracks: number },
  assignment?: Map<number, string>,
): AuditReport {
  const byTrack = new Map(analyses.map((a) => [a.trackId, a]));
  const items: AuditItem[] = beacons.map((beacon) => {
    let analysis: TrackAnalysis | undefined;
    if (assignment) {
      for (const [trackId, beaconId] of assignment) {
        if (beaconId === beacon.id) analysis = byTrack.get(trackId);
      }
    }
    if (!analysis) {
      return { beacon, verdict: 'unmatched', mismatches: ['视频中未跟踪到对应灯点'] };
    }
    const mismatches = compareCharacteristics(analysis.measured, beacon.nominal);
    return {
      beacon,
      analysis,
      verdict: mismatches.length === 0 ? 'pass' : 'fail',
      mismatches,
    };
  });
  return {
    createdAt: new Date().toISOString(),
    ...meta,
    items,
  };
}
