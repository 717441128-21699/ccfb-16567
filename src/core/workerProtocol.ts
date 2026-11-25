/**
 * Worker 通信协议：主线程 <-> 分析 Worker
 */
import type { AnalyzerConfig, FrameSample, Track, TrackAnalysis } from './types';

export interface WorkerInitMsg {
  type: 'init';
  config: AnalyzerConfig;
  videoName: string;
}

export interface WorkerFrameMsg {
  type: 'frame';
  /** 已缩放到分析宽度的 RGBA 帧 */
  buffer: ArrayBuffer;
  width: number;
  height: number;
  t: number;
  /** 原始视频尺寸（用于轨迹坐标换算回显） */
  videoWidth: number;
  videoHeight: number;
}

export interface WorkerFinishMsg {
  type: 'finish';
}

export interface WorkerResetMsg {
  type: 'reset';
}

export type WorkerRequest = WorkerInitMsg | WorkerFrameMsg | WorkerFinishMsg | WorkerResetMsg;

export interface WorkerProgressMsg {
  type: 'progress';
  frameIndex: number;
  t: number;
  blobCount: number;
  trackCount: number;
  /** 最近一帧的检测结果，供跟踪页实时叠加 */
  lastSample: FrameSample;
}

export interface WorkerDoneMsg {
  type: 'done';
  tracks: Track[];
  analyses: TrackAnalysis[];
  frameCount: number;
  durationSec: number;
  analyzeWidth: number;
  analyzeHeight: number;
  videoWidth: number;
  videoHeight: number;
  sampleFps: number;
}

export interface WorkerErrorMsg {
  type: 'error';
  message: string;
}

export type WorkerResponse = WorkerProgressMsg | WorkerDoneMsg | WorkerErrorMsg;
