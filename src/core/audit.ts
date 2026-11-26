/**
 * 核查：把分类结果与航标表逐条核对，输出不一致明细。
 * 匹配优先级：人工绑定 > 补偿坐标最近邻（未被占用的航标）。
 */
import type {
  AidEntry,
  AuditResult,
  Classification,
  LightColor,
  Mismatch,
  Track,
  TrackAidMatch,
} from './types';

export interface AuditTolerances {
  /** 周期允许绝对误差（秒） */
  periodTolSec?: number;
  /** 联闪组闪次允许误差（个） */
  groupTol?: number;
  /** 亮时允许误差（秒） */
  onDurationTolSec?: number;
}

const COLOR_ORDER: LightColor[] = ['red', 'green', 'white', 'yellow'];

function sameColorSet(expected: LightColor[], actual: LightColor[]): boolean {
  if (actual.length === 0) return false;
  const a = new Set(expected);
  return actual.every((c) => a.has(c)) && expected.every((c) => actual.includes(c));
}

function colorName(c: LightColor): string {
  return { red: '红', green: '绿', white: '白', yellow: '黄' }[c];
}

function charName(c: string): string {
  return {
    fixed: '常亮',
    'single-flash': '单闪',
    'group-flash': '联闪',
    'long-flash': '长闪',
    quick: '快闪',
    alternating: '互光',
    morse: '莫尔斯',
    unknown: '无法判读',
  }[c] ?? c;
}

/** 最近邻自动匹配（只给已确认且未被人工绑定的轨迹/航标配对） */
export function autoMatch(
  tracks: Track[],
  aids: AidEntry[],
  manual: TrackAidMatch[],
): TrackAidMatch[] {
  const manualTracks = new Set(manual.map((m) => m.trackId));
  const manualAids = new Set(manual.map((m) => m.aidId));
  const freeTracks = tracks.filter((t) => t.confirmed && !manualTracks.has(t.id) && t.rejected !== 'reflection');
  const freeAids = aids.filter((a) => !manualAids.has(a.id));
  const pairs: { t: Track; a: AidEntry; d: number }[] = [];
  for (const t of freeTracks) {
    const pos = lastKnownPos(t);
    if (!pos) continue;
    for (const a of freeAids) {
      // 自动匹配需要航标带参考坐标时才启用；无坐标则跳过（数据在 SceneConfig 场景里用映射）
      const ref = aidReferencePos(a);
      if (!ref) continue;
      pairs.push({ t, a, d: (pos.x - ref.x) ** 2 + (pos.y - ref.y) ** 2 });
    }
  }
  pairs.sort((p, q) => p.d - q.d);
  const usedT = new Set<number>();
  const usedA = new Set<string>();
  const out = [...manual];
  for (const p of pairs) {
    if (usedT.has(p.t.id) || usedA.has(p.a.id)) continue;
    // 自动匹配门限 120px
    if (p.d > 120 * 120) continue;
    usedT.add(p.t.id);
    usedA.add(p.a.id);
    out.push({ trackId: p.t.id, aidId: p.a.id });
  }
  return out;
}

function lastKnownPos(t: Track): { x: number; y: number } | null {
  for (let i = t.positions.length - 1; i >= 0; i--) {
    const p = t.positions[i];
    if (p) return p;
  }
  return null;
}

/** 航标参考坐标（可选扩展字段，存在 note 之外的 x/y 元数据时使用） */
function aidReferencePos(a: AidEntry): { x: number; y: number } | null {
  const ext = a as AidEntry & { refX?: number; refY?: number };
  if (typeof ext.refX === 'number' && typeof ext.refY === 'number') {
    return { x: ext.refX, y: ext.refY };
  }
  return null;
}

export function compareOne(aid: AidEntry, measured: Classification | null, tolerances: Required<AuditTolerances>): Mismatch[] {
  const mismatches: Mismatch[] = [];
  if (!measured) {
    mismatches.push({
      field: 'missing',
      expected: charName(aid.characteristic),
      actual: '未跟踪到灯点',
      detail: `航标 ${aid.id} 在视频中未形成有效轨迹，疑似熄灭/损坏或被遮挡`,
    });
    return mismatches;
  }

  if (measured.characteristic === 'unknown') {
    mismatches.push({
      field: 'rhythm',
      expected: charName(aid.characteristic),
      actual: '节奏紊乱/无法判读',
      detail: `周期变异系数 ${measured.periodVariation?.toFixed(2) ?? '?'}，自相关置信度 ${measured.confidence.toFixed(2)}`,
    });
  } else if (measured.characteristic !== aid.characteristic) {
    mismatches.push({
      field: 'characteristic',
      expected: charName(aid.characteristic),
      actual: charName(measured.characteristic),
      detail: `规定 ${charName(aid.characteristic)}，实测 ${charName(measured.characteristic)}`,
    });
  }

  if (measured.periodSec !== null && Math.abs(measured.periodSec - aid.periodSec) > tolerances.periodTolSec) {
    mismatches.push({
      field: 'period',
      expected: `${aid.periodSec.toFixed(1)}s`,
      actual: `${measured.periodSec.toFixed(2)}s`,
      detail: `周期偏差 ${(measured.periodSec - aid.periodSec).toFixed(2)}s，超过容差 ±${tolerances.periodTolSec}s`,
    });
  }

  if (aid.groupSize !== null && aid.groupSize !== undefined) {
    const actualGroup = measured.groupSize ?? 1;
    if (Math.abs(actualGroup - aid.groupSize) > tolerances.groupTol) {
      mismatches.push({
        field: 'groupSize',
        expected: `${aid.groupSize} 闪/组`,
        actual: `${actualGroup} 闪/组`,
        detail: '联闪组闪次不符',
      });
    }
  }

  if (!sameColorSet(aid.colors, measured.colors)) {
    mismatches.push({
      field: 'color',
      expected: aid.colors.map(colorName).join('+'),
      actual: measured.colors.map(colorName).join('+') || '未识别',
      detail: `规定灯色 ${aid.colors.map(colorName).join('/')}，实测 ${measured.colors.map(colorName).join('/')}`,
    });
  }

  if (
    aid.onDurationSec !== undefined &&
    measured.onDurationSec !== null &&
    Math.abs(measured.onDurationSec - aid.onDurationSec) > tolerances.onDurationTolSec &&
    // 周期正确时亮时小差异不单独报警，避免噪声
    measured.characteristic === aid.characteristic
  ) {
    mismatches.push({
      field: 'rhythm',
      expected: `亮 ${aid.onDurationSec.toFixed(1)}s`,
      actual: `亮 ${measured.onDurationSec.toFixed(2)}s`,
      detail: '亮时偏离规定值',
    });
  }

  return mismatches;
}

export function audit(
  aids: AidEntry[],
  tracks: Track[],
  classifications: { trackId: number; result: Classification }[],
  matches: TrackAidMatch[],
  tolerances: AuditTolerances = {},
): AuditResult[] {
  const tol: Required<AuditTolerances> = {
    periodTolSec: tolerances.periodTolSec ?? 0.2,
    groupTol: tolerances.groupTol ?? 0,
    onDurationTolSec: tolerances.onDurationTolSec ?? 0.3,
  };
  const classById = new Map(classifications.map((c) => [c.trackId, c.result]));
  const matchByAid = new Map(matches.map((m) => [m.aidId, m.trackId]));
  const matchedTracks = new Set(matches.map((m) => m.trackId));

  const results: AuditResult[] = aids.map((aid) => {
    const trackId = matchByAid.get(aid.id) ?? null;
    const measured = trackId === null ? null : (classById.get(trackId) ?? null);
    const mismatches = compareOne(aid, measured, tol);
    return { aid, trackId, measured, pass: mismatches.length === 0, mismatches };
  });

  // 未绑定到任何航标的轨迹作为补充线索（常亮且未匹配 → 疑似路灯/船灯干扰）
  const unmatched = tracks.filter((t) => !matchedTracks.has(t.id) && t.confirmed && t.rejected !== 'reflection');
  for (const t of unmatched) {
    const measured = classById.get(t.id) ?? null;
    if (!measured) continue;
    const isInterference = t.steady === true;
    results.push({
      aid: {
        id: `(未匹配轨迹#${t.id})`,
        name: isInterference ? '疑似干扰灯（路灯/船灯）' : '未匹配灯点',
        characteristic: 'unknown',
        groupSize: null,
        periodSec: 0,
        colors: [],
      },
      trackId: t.id,
      measured,
      pass: isInterference,
      mismatches: isInterference
        ? []
        : [
            {
              field: 'missing',
              expected: '航标表内航标',
              actual: `实测${charName(measured.characteristic)}`,
              detail: '该灯点无法与航标表绑定，可能为新增航标、未登记干扰灯或匹配失败',
            },
          ],
    });
  }
  return results;
}

export { COLOR_ORDER, charName, colorName };
