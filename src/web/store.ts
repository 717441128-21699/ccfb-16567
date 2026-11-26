/**
 * 全局应用状态：航标表、当前场景、分析结果、绑定关系。
 * 轻量发布订阅 store，四页共享。
 */
import { SAMPLE_AIDS, SCENARIO_PRESETS, buildScene, type ScenarioPreset } from '../core/sampleData';
import type {
  AidEntry,
  AuditResult,
  Classification,
  SceneConfig,
  Track,
  TrackAidMatch,
  WorkerOutput,
} from '../core/types';

export interface AppState {
  aids: AidEntry[];
  preset: ScenarioPreset;
  scene: SceneConfig;
  analysisFps: number;
  durationSec: number;
  running: boolean;
  progress: { frame: number; total: number; tracks: number };
  output: WorkerOutput | null;
  selectedTrackId: number | null;
  matches: TrackAidMatch[];
}

type Listener = (state: AppState) => void;

const listeners = new Set<Listener>();

const state: AppState = {
  aids: structuredClone(SAMPLE_AIDS),
  preset: SCENARIO_PRESETS[1]!,
  scene: buildScene(SCENARIO_PRESETS[1]!, { fps: 10, durationSec: 60 }),
  analysisFps: 10,
  durationSec: 60,
  running: false,
  progress: { frame: 0, total: 0, tracks: 0 },
  output: null,
  selectedTrackId: null,
  matches: [],
};

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState>): void {
  Object.assign(state, patch);
  for (const l of listeners) l(state);
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function setPreset(preset: ScenarioPreset): void {
  setState({
    preset,
    scene: buildScene(preset, { fps: state.analysisFps, durationSec: state.durationSec }),
    output: null,
    progress: { frame: 0, total: 0, tracks: 0 },
  });
}

export function setAnalysisParams(patch: { fps?: number; durationSec?: number }): void {
  const fps = patch.fps ?? state.analysisFps;
  const durationSec = patch.durationSec ?? state.durationSec;
  setState({
    analysisFps: fps,
    durationSec,
    scene: buildScene(state.preset, { fps, durationSec }),
    output: null,
  });
}

export function setOutput(output: WorkerOutput | null): void {
  setState({ output, selectedTrackId: output?.tracks[0]?.id ?? null });
}

export function selectedTrack(): Track | null {
  if (state.selectedTrackId === null || !state.output) return null;
  return state.output.tracks.find((t) => t.id === state.selectedTrackId) ?? null;
}

export function selectedClassification(): Classification | null {
  if (state.selectedTrackId === null || !state.output) return null;
  return state.output.classifications.find((c) => c.trackId === state.selectedTrackId)?.result ?? null;
}

export function auditForTrack(trackId: number): AuditResult | undefined {
  return state.output?.audits.find((a) => a.trackId === trackId);
}
