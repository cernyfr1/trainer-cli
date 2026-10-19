/** What a trainer reports. Field set mirrors FTMS Indoor Bike Data, but any trainer adapter can fill it. */
export interface TrainerData {
  speedKmh?: number;
  avgSpeedKmh?: number;
  cadenceRpm?: number;
  avgCadenceRpm?: number;
  totalDistanceM?: number;
  resistanceLevel?: number;
  powerW?: number;
  avgPowerW?: number;
  totalEnergyKcal?: number;
  energyPerHour?: number;
  energyPerMinute?: number;
  heartRateBpm?: number;
  met?: number;
  elapsedS?: number;
  remainingS?: number;
}

/** What a trainer can measure and be told to do. */
export interface TrainerFeatures {
  cadence: boolean;
  totalDistance: boolean;
  resistanceLevel: boolean;
  heartRate: boolean;
  power: boolean;
  targetResistance: boolean;
  targetPower: boolean;
  indoorBikeSimulation: boolean;
  spinDown: boolean;
}

export interface SimParams {
  gradePct: number;
  windMs?: number;
  crr?: number;
  cw?: number;
}

export interface DiscoveredTrainer { id: string; name: string; rssi: number }
