export interface Config {
  ftp: number;
  riderMassKg: number;
  bikeMassKg: number;
  cda: number;
  crr: number;
  maxGrade: number;
  minGrade: number;
  difficulty: number;
  trainerName?: string;
  clickName?: string;
  stravaClientId?: string;
  stravaClientSecret?: string;
}

export const DEFAULTS: Config = {
  ftp: 200,
  riderMassKg: 75,
  bikeMassKg: 9,
  cda: 0.32,
  crr: 0.004,
  maxGrade: 15,
  minGrade: -10,
  difficulty: 1,
};
