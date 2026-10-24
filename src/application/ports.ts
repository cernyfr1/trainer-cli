import type { EventEmitter } from 'node:events';
import type { FinishedActivity } from '../domain/activity.js';
import type { Config } from '../domain/config.js';
import type { Route } from '../domain/route.js';
import type { SimParams, TrainerFeatures } from '../domain/trainer-data.js';
import type { Workout } from '../domain/workout.js';

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

/**
 * A handlebar remote (Zwift Click) whose buttons act like the +/- keys. Implementations: ZwiftClick, MockClick.
 * Emits: 'adjust' (1 | -1), 'connected', 'disconnect', 'log' (string).
 */
export interface Controller extends EventEmitter {
  readonly name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
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

/** Loads a course from a file (GPX, FIT, …). */
export interface RouteSource {
  load(path: string): Promise<Route>;
}

/** Loads a structured workout from a file (YAML, ZWO, …). */
export interface WorkoutSource {
  load(path: string): Promise<Workout>;
}

/** Persisted user settings. */
export interface ConfigStore {
  load(): Promise<Config>;
  save(patch: Partial<Config>): Promise<Config>;
}
