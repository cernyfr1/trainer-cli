import type { EventEmitter } from 'node:events';
import type { FinishedActivity } from '../domain/activity.js';
import type { SimParams, TrainerFeatures } from '../domain/trainer-data.js';

/**
 * Anything the session engine can drive. Implementations: BleFtmsTrainer, MockTrainer.
 * Emits: 'data' (TrainerData), 'disconnect', 'log' (string).
 */
export interface Trainer extends EventEmitter {
  readonly name: string;
  readonly features?: TrainerFeatures;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  setErgPower(watts: number): Promise<void>;
  setSimulation(p: SimParams): Promise<void>;
}

/** Source of time. Real wall clock for a real trainer; simulated (and speedable) for the mock. */
export interface Clock {
  /** Milliseconds since epoch, in clock time. */
  now(): number;
  /** Call fn every periodS seconds of clock time. Returns a cancel function. */
  every(periodS: number, fn: (dtS: number) => void): () => void;
}

/** Persists finished rides. Returns where the activity was stored. */
export interface ActivityStore {
  save(activity: FinishedActivity): Promise<string>;
}

export interface UploadResult { url: string }

/** Third-party service rides can be uploaded to (Strava today). */
export interface ActivityUploader {
  isConnected(): Promise<boolean>;
  upload(file: string, opts: { name?: string; indoor: boolean }): Promise<UploadResult>;
}
