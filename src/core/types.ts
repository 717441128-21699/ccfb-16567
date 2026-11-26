/**
 * 全局共享类型定义（纯数据，无 DOM 依赖，Node 与 Worker 均可引用）。
 */

/** 灯质种类（对应航标表灯质字段与分类器输出） */
export type LightCharacteristic =
  | 'fixed' // 常亮（F）
  | 'single-flash' // 单闪（Fl）
  | 'group-flash' // 联闪（Fl(n)）
  | 'long-flash' // 长闪（LFl）
  | 'quick' // 快闪（Q，含连续快闪与联组快闪）
  | 'alternating' // 互光（Al，两色交替）
  | 'morse' // 莫尔斯码（Mo）
  | 'unknown'; // 无法判读（含节奏紊乱/坏灯）

/** 灯色：红绿白黄 */
export type LightColor = 'red' | 'green' | 'white' | 'yellow';

/** 航标表条目 */
export interface AidEntry {
  /** 航标编号，唯一主键 */
  id: string;
  /** 名称，如“3号灯浮” */
  name: string;
  /** 规定灯质 */
  characteristic: LightCharacteristic;
  /** 联闪组内闪次（联闪/联组快闪时有效），其余为 null */
  groupSize: number | null;
  /** 规定周期（秒） */
  periodSec: number;
  /** 规定灯色；互光时为两种交替色 */
  colors: LightColor[];
  /** 亮时（秒），单闪/长闪用；联闪给组内单次亮时；可选 */
  onDurationSec?: number;
  /** 备注 */
  note?: string;
}

/** 一帧像素：宽高 + 紧凑 RGBA 数据（每像素 4 字节） */
export interface Frame {
  width: number;
  height: number;
  /** 以帧序号对齐的时间戳（秒），从 0 开始 */
  timeSec: number;
  /** 帧序号 */
  index: number;
  data: Uint8ClampedArray;
}

/** 检测到的灯点（连通域） */
export interface Blob {
  id: number;
  cx: number;
  cy: number;
  /** 连通域像素数 */
  area: number;
  /** 外接框 */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** 平均亮度 0..255（灰度） */
  brightness: number;
  /** 平均颜色（亮像素） */
  r: number;
  g: number;
  b: number;
  /** 形态：高宽比（纵向拉长判定倒影用） */
  aspect: number;
  /** 填充率（面积/外接框面积），倒影通常偏低且碎 */
  extent: number;
}

/** 跟踪轨迹 */
export interface Track {
  id: number;
  /** 每帧平滑后的画面坐标（断航帧为 null） */
  positions: ({ x: number; y: number } | null)[];
  /** 每帧亮度采样（断航帧为 null），0..255 */
  brightness: (number | null)[];
  /** 每帧平均 RGB（断航帧为 null） */
  colors: ({ r: number; g: number; b: number } | null)[];
  /** 最近一次匹配到的帧序号 */
  lastSeenFrame: number;
  /** 首帧序号 */
  firstFrame: number;
  /** 命中帧数 */
  hitCount: number;
  /** 候选/确认标记：确认后才参与分类核查 */
  confirmed: boolean;
  /** 常亮特征（亮度稳定、占空极高）：常亮航标与路灯/船灯同形态，靠匹配航标表区分 */
  steady?: boolean;
  /** 干扰标记：常亮路灯/船灯/倒影等，核查时排除 */
  rejected?: TrackRejection | null;
}

export type TrackRejection =
  | 'steady-interference' // 常亮干扰（路灯/船灯）
  | 'reflection' // 海面倒影
  | 'too-short'; // 轨迹过短不可判读

/** 分类结果（单条轨迹） */
export interface Classification {
  characteristic: LightCharacteristic;
  /** 联闪组闪次（group-flash / 联组快闪），否则 null */
  groupSize: number | null;
  /** 实测周期（秒）；常亮/无法判读为 null */
  periodSec: number | null;
  /** 亮时（秒）；联闪给组内单次亮时；常亮为 null */
  onDurationSec: number | null;
  /** 暗时（秒） */
  offDurationSec: number | null;
  /** 实测灯色（互光给两种，按出现先后） */
  colors: LightColor[];
  /** 亮占比 0..1 */
  dutyCycle: number;
  /** 每分钟闪次（快闪判定用） */
  flashesPerMinute: number;
  /** 莫尔斯码解码字符串，如 "A"；非莫尔斯为 null */
  morseLetter: string | null;
  /** 周期稳定性（相邻周期变异系数），>0.25 视为节奏紊乱 */
  periodVariation: number | null;
  /** 自相关峰值强度 0..1，过低说明无稳定周期 */
  confidence: number;
}

/** 轨迹与航标表的匹配（人工绑定或位置自动匹配） */
export interface TrackAidMatch {
  trackId: number;
  aidId: string;
}

/** 单座航标的核查结论 */
export interface AuditResult {
  aid: AidEntry;
  trackId: number | null;
  measured: Classification | null;
  /** 是否与航标表一致 */
  pass: boolean;
  /** 不一致明细 */
  mismatches: Mismatch[];
}

export interface Mismatch {
  field: 'characteristic' | 'period' | 'color' | 'groupSize' | 'missing' | 'rhythm';
  expected: string;
  actual: string;
  detail: string;
}

/** 合成场景中单盏灯的真值 */
export interface GroundTruthLight {
  /** 对应航标表编号；干扰灯为 null */
  aidId: string | null;
  kind: 'aid' | 'street' | 'vessel';
  /** 世界坐标（画面内基准位置，像素，抖动前） */
  x: number;
  y: number;
  color: LightColor;
  /** 互光副色（alternating 时两色交替） */
  altColor?: LightColor;
  characteristic: LightCharacteristic;
  periodSec: number;
  groupSize: number | null;
  /** 注入故障 */
  fault?: 'none' | 'dead' | 'steady' | 'drift';
}

/** 合成场景参数（浪高/雾浓度等） */
export interface SceneConfig {
  width: number;
  height: number;
  fps: number;
  /** 视频时长（秒） */
  durationSec: number;
  /** 浪高等级 0..2（0 小浪 1 中浪 2 大浪），决定抖动幅度与倒影强度 */
  seaState: number;
  /** 雾浓度 0..2（0 无雾 1 轻雾 2 浓雾），决定对比度衰减与光晕 */
  fogLevel: number;
  seed: number;
  lights: GroundTruthLight[];
}

/** 合成场景导出的真值包 */
export interface GroundTruth {
  config: SceneConfig;
  /** 每盏 aid 灯逐帧亮灭（true 亮），按 lights 中 aid 顺序 */
  schedules: Record<string, boolean[]>;
}

/** Worker 与主线程的消息协议 */
export type WorkerRequest =
  | { type: 'start'; payload: WorkerJob }
  | { type: 'cancel' };

export interface WorkerJob {
  /** 合成模式参数；与导入视频二选一 */
  scene?: SceneConfig;
  /** 采样帧率（合成/抽帧均按此帧率分析） */
  analysisFps: number;
  /** 水天线位置（画面高度比例 0..1），倒影剔除用 */
  horizonRatio: number;
  /** 已绑定航标表 */
  aids: AidEntry[];
  /** 已有绑定关系（可空，自动位置匹配兜底） */
  matches: TrackAidMatch[];
}

export type WorkerResponse =
  | { type: 'progress'; payload: { frame: number; total: number; tracks: number } }
  | {
      type: 'frame';
      payload: {
        frame: Frame;
        blobs: Blob[];
        tracks: TrackSnapshot[];
        globalDx: number;
        globalDy: number;
      };
    }
  | { type: 'done'; payload: WorkerOutput }
  | { type: 'error'; payload: string };

export interface TrackSnapshot {
  id: number;
  x: number;
  y: number;
  confirmed: boolean;
  rejected: TrackRejection | null;
  brightness: number | null;
}

export interface WorkerOutput {
  tracks: Track[];
  classifications: { trackId: number; result: Classification }[];
  audits: AuditResult[];
  totalFrames: number;
  analysisTimeMs: number;
  videoTimeSec: number;
}
