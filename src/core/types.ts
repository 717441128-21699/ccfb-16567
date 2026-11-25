/**
 * 领域类型定义：航标、灯质、灯点轨迹、核查结果
 */

/** 四种灯色（IALA / 中国海区航标标准） */
export type LightColor = 'red' | 'green' | 'white' | 'yellow';

/**
 * 灯质种类
 * - fixed       常亮（灯坏时常见的故障态）
 * - single      单闪 Fl：每周期一次闪光
 * - group       联闪 Fl(n)：每周期 n 次闪光（n>=2）
 * - longFlash   长闪 LFl：单次闪光明时长 >= 2s
 * - quick       快闪 Q：闪光频率 >= 50 次/分钟
 * - alternating 互光 Al：两种颜色交替
 * - morse       莫尔斯 Mo：按莫尔斯码节奏
 */
export type LightKind =
  | 'fixed'
  | 'single'
  | 'group'
  | 'longFlash'
  | 'quick'
  | 'alternating'
  | 'morse';

/** 灯质描述（航标表里"应该是什么"，以及分析器"实测是什么"都用它） */
export interface LightCharacteristics {
  kind: LightKind;
  /** 联闪时的每组闪光次数；单闪/长闪为 1；其余可空 */
  groupCount?: number;
  /** 完整周期（秒） */
  periodSec: number;
  /** 每次明的时长（秒）；联闪时指单次闪光明时长 */
  onSec: number;
  /** 莫尔斯码字符（如 "A"、"U"），仅 morse */
  morseLetter?: string;
  /** 灯色；互光时为两种交替色，取第一种为主色 */
  color: LightColor;
  /** 互光的第二颜色，仅 alternating */
  alternateColor?: LightColor;
}

/** 航标表中的一条航标记录 */
export interface Beacon {
  id: string;
  /** 航标名称，如 "3 号灯浮" */
  name: string;
  /** 方位/位置描述 */
  location: string;
  /** 标称灯质 */
  nominal: LightCharacteristics;
  /** 备注，如灯器型号、电池更换日期 */
  note?: string;
}

/** 一帧上检测到的灯点（像素坐标基于分析用的缩放画面） */
export interface DetectedBlob {
  x: number;
  y: number;
  /** 亮斑总亮度（像素亮度和） */
  intensity: number;
  /** 亮斑半径（像素） */
  radius: number;
  /** 亮斑平均 RGB（0-255） */
  r: number;
  g: number;
  b: number;
}

/** 单帧采样结果 */
export interface FrameSample {
  /** 帧时间戳（秒，视频时间轴） */
  t: number;
  blobs: DetectedBlob[];
  width: number;
  height: number;
}

/** 一条被跟踪住的灯点轨迹（一个目标） */
export interface Track {
  id: number;
  /** 每帧位置；未命中的帧为 null（长度 = 采样帧数） */
  positions: (Readonly<{ x: number; y: number }> | null)[];
  /** 每帧亮度曲线（未命中为 0） */
  brightness: number[];
  /** 每帧平均颜色 RGB（未命中为 0,0,0） */
  colors: Readonly<{ r: number; g: number; b: number }>[];
  /** 每帧时间戳（秒） */
  times: number[];
  /** 首帧 / 末帧索引 */
  firstFrame: number;
  lastFrame: number;
  /** 命中帧数 */
  hits: number;
  /** 轨迹质心（缩放画面坐标） */
  cx: number;
  cy: number;
}

/** 明/暗区间 */
export interface OnOffInterval {
  /** true=明, false=暗 */
  on: boolean;
  startSec: number;
  endSec: number;
  get durationSec(): number;
}

/** 一条轨迹的灯质分析结果 */
export interface TrackAnalysis {
  trackId: number;
  measured: LightCharacteristics;
  /** 周期测量的中间量，供曲线页展示 */
  intervals: OnOffInterval[];
  /** 明暗阈值（亮度单位） */
  threshold: number;
  /** 估算占空比 */
  dutyCycle: number;
  /** 是否疑似干扰源（路灯/船灯/倒影） */
  isDistractor: boolean;
  /** 判定为干扰的依据 */
  distractorReasons: string[];
  /** 关联到的航标 id（自动或人工指定） */
  beaconId?: string;
}

/** 单座航标的核查结论 */
export type AuditVerdict = 'pass' | 'fail' | 'unmatched';

export interface AuditItem {
  beacon: Beacon;
  analysis?: TrackAnalysis;
  verdict: AuditVerdict;
  /** 不一致明细 */
  mismatches: string[];
}

/** 一次完整核查的汇总 */
export interface AuditReport {
  createdAt: string;
  videoName: string;
  durationSec: number;
  sampleFps: number;
  totalTracks: number;
  distractorTracks: number;
  items: AuditItem[];
}

/** 合成测试视频里一盏灯的真值 */
export interface GroundTruthLight {
  lightId: number;
  /** 画面归一化坐标 0-1 */
  nx: number;
  ny: number;
  characteristics: LightCharacteristics;
  /** 是否为干扰源（路灯/船灯/倒影），干扰源不参与达标统计 */
  distractor?: boolean;
  distractorKind?: 'street' | 'boat' | 'reflection' | 'steady';
}

export interface TestScenario {
  id: string;
  name: string;
  /** 浪高（米），决定画面抖动幅度 */
  waveHeightM: number;
  /** 雾浓度 0-1（0 晴朗，1 浓雾） */
  fog: number;
  durationSec: number;
  lights: GroundTruthLight[];
}

/** 分析器可调参数 */
export interface AnalyzerConfig {
  /** 分析画面缩放宽度 */
  analyzeWidth: number;
  /** 采样帧率 */
  sampleFps: number;
  /** 亮斑检测阈值（0-255 亮度）；0 表示逐帧 Otsu 自适应 */
  detectThreshold: number;
  /** 跟踪最大匹配距离（缩放画面像素） */
  maxMatchDistance: number;
  /** 轨迹允许丢失帧数 */
  maxLostFrames: number;
  /** 干扰判定：稳态亮度变异系数上限 */
  steadyCvLimit: number;
  /** 快闪频率下限（次/分钟） */
  quickRatePerMin: number;
  /** 长闪明时长下限（秒） */
  longFlashSec: number;
}

export const DEFAULT_CONFIG: AnalyzerConfig = {
  analyzeWidth: 480,
  sampleFps: 20,
  detectThreshold: 55,
  maxMatchDistance: 26,
  maxLostFrames: 6,
  steadyCvLimit: 0.08,
  quickRatePerMin: 50,
  longFlashSec: 2,
};
