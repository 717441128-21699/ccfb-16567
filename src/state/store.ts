/**
 * 全局应用状态（轻量自研 store，无框架依赖）。
 * 四个页面共享：航标表、视频导入、灯点跟踪、核查结果。
 */
import { DEFAULT_TOLERANCE, compareCharacteristics } from '../core/audit';
import type {
  AnalyzerConfig, AuditItem, AuditReport, Beacon, Track, TrackAnalysis,
} from '../core/types';
import { DEFAULT_CONFIG } from '../core/types';

export type PageId = 'beacons' | 'import' | 'tracking' | 'results';

export interface LiveSample {
  t: number;
  blobs: { x: number; y: number; intensity: number; r: number; g: number; b: number }[];
  width: number;
  height: number;
}

export interface AppState {
  page: PageId;
  config: AnalyzerConfig;
  beacons: Beacon[];
  beaconHints: Record<string, { nx: number; ny: number }>;
  videoName: string;
  videoUrl: string | null;
  processing: boolean;
  progress: number;
  liveSample: LiveSample | null;
  tracks: Track[];
  analyses: TrackAnalysis[];
  assignment: Map<number, string>;
  report: AuditReport | null;
  analyzeSize: { width: number; height: number; videoWidth: number; videoHeight: number };
  selectedTrackId: number | null;
}

type Listener = (state: AppState) => void;

class Store {
  private state: AppState = {
    page: 'beacons',
    config: { ...DEFAULT_CONFIG },
    beacons: [],
    beaconHints: {},
    videoName: '',
    videoUrl: null,
    processing: false,
    progress: 0,
    liveSample: null,
    tracks: [],
    analyses: [],
    assignment: new Map(),
    report: null,
    analyzeSize: { width: 0, height: 0, videoWidth: 0, videoHeight: 0 },
    selectedTrackId: null,
  };

  private listeners = new Set<Listener>();

  getState(): AppState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  update(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  setPage(page: PageId): void {
    this.update({ page });
  }

  setBeacons(beacons: Beacon[], hints: Record<string, { nx: number; ny: number }>): void {
    this.update({ beacons, beaconHints: hints });
  }

  setVideo(name: string, url: string | null): void {
    if (this.state.videoUrl?.startsWith('blob:')) URL.revokeObjectURL(this.state.videoUrl);
    this.update({
      videoName: name,
      videoUrl: url,
      tracks: [],
      analyses: [],
      report: null,
      progress: 0,
      liveSample: null,
      assignment: new Map(),
    });
  }

  setConfig(patch: Partial<AnalyzerConfig>): void {
    this.update({ config: { ...this.state.config, ...patch } });
  }

  setAssignment(assignment: Map<number, string>): void {
    this.update({ assignment });
  }

  /** 人工调整配对：轨迹 -> 航标 */
  assignTrack(trackId: number, beaconId: string | null): void {
    const next = new Map(this.state.assignment);
    // 清除该航标原有配对
    for (const [tid, bid] of next) {
      if (bid === beaconId) next.delete(tid);
    }
    if (beaconId) next.set(trackId, beaconId);
    else next.delete(trackId);
    this.update({ assignment: next });
  }

  /** 用当前轨迹/分析/配对重建核查报告 */
  rebuildReport(extra?: { durationSec?: number; sampleFps?: number }): void {
    const { beacons, analyses, assignment, tracks, videoName } = this.state;
    const items: AuditItem[] = beacons.map((beacon) => {
      let analysis: TrackAnalysis | undefined;
      for (const [tid, bid] of assignment) {
        if (bid === beacon.id) analysis = analyses.find((a) => a.trackId === tid);
      }
      if (!analysis) {
        return { beacon, verdict: 'unmatched', mismatches: ['视频中未跟踪到对应灯点'] };
      }
      return {
        beacon,
        analysis,
        verdict: compareCharacteristics(analysis.measured, beacon.nominal, DEFAULT_TOLERANCE).length
          ? 'fail'
          : 'pass',
        mismatches: compareCharacteristics(analysis.measured, beacon.nominal, DEFAULT_TOLERANCE),
      };
    });
    const report: AuditReport = {
      createdAt: new Date().toISOString(),
      videoName,
      durationSec: extra?.durationSec ?? this.state.report?.durationSec ?? 0,
      sampleFps: extra?.sampleFps ?? this.state.report?.sampleFps ?? this.state.config.sampleFps,
      totalTracks: tracks.length,
      distractorTracks: analyses.filter((a) => a.isDistractor).length,
      items,
    };
    this.update({ report });
  }
}

export const store = new Store();
