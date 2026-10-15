import type { EventEmitter } from 'node:events';
import type { FtmsFeatures, IndoorBikeData } from '../ftms/codec.js';

export interface SimParams {
  gradePct: number;
  windMs?: number;
  crr?: number;
  cw?: number;
}

export interface DiscoveredTrainer { id: string; name: string; rssi: number }

/**
 * Anything the session engine can drive. Implementations: BleFtmsTrainer, MockTrainer.
 * Emits: 'data' (IndoorBikeData), 'disconnect', 'log' (string).
 */
export interface Trainer extends EventEmitter {
  readonly name: string;
  readonly features?: FtmsFeatures;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  setErgPower(watts: number): Promise<void>;
  setSimulation(p: SimParams): Promise<void>;
  /** Mock only: advance simulated time. Real trainers ignore it. */
  tick?(dtS: number): void;
}

export type TrainerData = IndoorBikeData;
