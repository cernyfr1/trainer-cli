#!/usr/bin/env node
import { Command, Option } from 'commander';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULTS, type Config } from '../domain/config.js';
import { FreeMode } from '../domain/modes/free-mode.js';
import { RouteMode } from '../domain/modes/route-mode.js';
import { WorkoutMode } from '../domain/modes/workout-mode.js';
import { RiderModel } from '../domain/physics.js';
import { ConfigFile } from '../infrastructure/config-file.js';
import { RouteLoader } from '../infrastructure/route/loader.js';
import { StravaClient, StravaTokenFile } from '../infrastructure/strava.js';
import { BleScanner } from '../infrastructure/trainer/ble.js';
import { WorkoutLoader } from '../infrastructure/workout/loader.js';
import { RideRunner, type RideOpts } from './ride-runner.js';
import { fmtTime } from './ui/RideView.js';

// composition root: long-lived adapters; RideRunner creates the per-ride ones (clock, trainer, store)
const config = new ConfigFile();
const strava = new StravaClient(StravaTokenFile.in(config.appDir));
const scanner = new BleScanner();
const runner = new RideRunner(config, strava, scanner);

const program = new Command()
  .name('trainer')
  .description('Terminal controller for Bluetooth FTMS smart trainers')
  .version('0.1.0');

const rideOptions = (c: Command) => c
  .option('--mock', 'use the built-in simulated trainer (no Bluetooth)')
  .option('-t, --trainer <name>', 'connect to the first trainer whose name contains this')
  .addOption(new Option('--speedup <x>', 'mock only: run time faster (e.g. 60)').default('1'))
  .option('--no-tui', 'plain log output instead of the dashboard')
  .option('--upload', 'upload to Strava when finished without asking')
  .option('--no-upload', 'never upload')
  .option('--name <name>', 'activity name for Strava')
  .option('--difficulty <pct>', 'route mode: scale grade, e.g. 70');

program.command('scan')
  .description('list nearby FTMS trainers')
  .option('-s, --seconds <n>', 'scan duration', '8')
  .action(async (o) => {
    console.log(`Scanning ${o.seconds}s for FTMS trainers… (pedal to wake it up)`);
    const found = await scanner.scan(Number(o.seconds), (t) => console.log(`  ${t.name.padEnd(24)} rssi ${t.rssi}  id ${t.id}`));
    if (!found.size) console.log('Nothing found. Is the trainer awake and not connected to another app?');
    else console.log(`\nUse: trainer ride <file> --trainer "${[...found.values()][0].info.name}"   (or set trainerName in config)`);
    process.exit(0);
  });

rideOptions(program.command('ride <route>')
  .description('ride a GPX/FIT course in simulation mode (grade → resistance)'))
  .action(async (file: string, o: RideOpts) => {
    const route = await new RouteLoader().load(file);
    console.log(`${route.name}: ${(route.totalDist / 1000).toFixed(1)} km, ↑ ${Math.round(route.ascent)} m, ${route.points.length} pts`);
    await runner.run((cfg, columns) => new RouteMode(route, {
      model: RiderModel.fromConfig(cfg),
      minGrade: cfg.minGrade, maxGrade: cfg.maxGrade, difficulty: cfg.difficulty, profileColumns: columns - 10,
    }), o);
  });

rideOptions(program.command('workout <file>')
  .description('structured workout in ERG mode (.yaml or Zwift .zwo)')
  .option('--ftp <watts>', 'override FTP'))
  .action(async (file: string, o: RideOpts) => {
    const workout = await new WorkoutLoader().load(file);
    const cfg = await config.load();
    const ftp = Number(o.ftp ?? workout.ftp ?? cfg.ftp);
    console.log(`${workout.name}: ${fmtTime(workout.totalS)}, ${workout.steps.length} steps @ FTP ${ftp} W`);
    await runner.run(() => new WorkoutMode(workout, ftp), o);
  });

rideOptions(program.command('free')
  .description('free ride: fixed ERG power or fixed grade (adjust with +/-)')
  .option('--erg <watts>', 'hold this power')
  .option('--grade <pct>', 'simulate this grade', '0'))
  .action(async (o: RideOpts & { erg?: string; grade?: string }) => {
    await runner.run((cfg) => new FreeMode({
      ergW: o.erg ? Number(o.erg) : undefined, gradePct: Number(o.grade), minGrade: cfg.minGrade, maxGrade: cfg.maxGrade,
    }), o);
  });

const stravaCmd = program.command('strava').description('Strava connection');
stravaCmd.command('auth')
  .description('connect your Strava account (needs your own API app: strava.com/settings/api, callback domain 127.0.0.1)')
  .option('--client-id <id>')
  .option('--client-secret <secret>')
  .action(async (o) => {
    const cfg = await config.load();
    const id = o.clientId ?? process.env.STRAVA_CLIENT_ID ?? cfg.stravaClientId;
    const secret = o.clientSecret ?? process.env.STRAVA_CLIENT_SECRET ?? cfg.stravaClientSecret;
    if (!id || !secret) throw new Error('Need --client-id and --client-secret (or STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET)');
    const t = await strava.auth(String(id), String(secret));
    console.log(`Connected${t.athlete?.firstname ? ` as ${t.athlete.firstname}` : ''}. Tokens saved.`);
    process.exit(0);
  });
stravaCmd.command('status').action(async () => console.log(await strava.status()));
stravaCmd.command('upload <fitFile>')
  .option('--name <name>')
  .option('--indoor', 'mark as trainer activity')
  .action(async (file: string, o) => {
    const r = await strava.upload(file, { name: o.name, indoor: !!o.indoor });
    console.log(`✔ ${r.url}`);
  });

program.command('config [assignments...]')
  .description('show config, or set values: trainer config ftp=265 riderMassKg=72 trainerName=D100')
  .action(async (assignments: string[]) => {
    if (!assignments.length) {
      console.log(`# ${config.path}`);
      const cfg = await config.load();
      for (const [k, v] of Object.entries(cfg)) if (!/secret/i.test(k)) console.log(`${k}: ${v}`);
      return;
    }
    const patch: Record<string, unknown> = {};
    for (const a of assignments) {
      const [k, ...rest] = a.split('=');
      const v = rest.join('=');
      if (!(k in DEFAULTS) && !['trainerName', 'stravaClientId', 'stravaClientSecret'].includes(k)) throw new Error(`Unknown key "${k}"`);
      patch[k] = typeof (DEFAULTS as any)[k] === 'number' ? Number(v) : v;
    }
    await config.save(patch as Partial<Config>);
    console.log('saved');
  });

program.command('activities')
  .description('list recorded FIT files')
  .action(async () => {
    const dir = config.activitiesDir;
    const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.fit')).sort();
    if (!files.length) return console.log(`No activities yet in ${dir}`);
    for (const f of files) console.log(`${f.padEnd(48)} ${((await stat(join(dir, f))).size / 1024).toFixed(0)} KB`);
  });

program.parseAsync().catch((e) => {
  console.error(`✖ ${e.message}`);
  process.exit(1);
});
