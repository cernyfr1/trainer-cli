#!/usr/bin/env node
import { Command, Option } from 'commander';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import React from 'react';
import { render } from 'ink';
import { activitiesDir, configPath, DEFAULTS, loadConfig, saveConfig, type Config } from './config.js';
import { findTrainer, scanTrainers } from './trainer/ble.js';
import { MockTrainer } from './trainer/mock.js';
import type { Trainer } from './trainer/types.js';
import type { Controller } from './controller/types.js';
import { findClicks } from './controller/zwiftClick.js';
import { loadRoute } from './route/route.js';
import { loadWorkout } from './workout/workout.js';
import { Session, type Mode, type Snapshot } from './session.js';
import { RideView, fmtTime } from './ui/RideView.js';
import { stravaAuth, stravaStatus, stravaUpload } from './strava.js';

interface RideOpts {
  mock?: boolean;
  trainer?: string;
  speedup?: string;
  tui: boolean;
  upload?: boolean;
  name?: string;
  ftp?: string;
  difficulty?: string;
  click: boolean;
}

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
  .option('--difficulty <pct>', 'route mode: scale grade, e.g. 70')
  .option('--no-click', "don't look for a Zwift Click handlebar remote");

program.command('scan')
  .description('list nearby FTMS trainers')
  .option('-s, --seconds <n>', 'scan duration', '8')
  .action(async (o) => {
    console.log(`Scanning ${o.seconds}s for FTMS trainers and Zwift Clicks… (pedal to wake it up)`);
    const show = (t: { name: string; rssi: number; id: string }) => console.log(`  ${t.name.padEnd(24)} rssi ${t.rssi}  id ${t.id}`);
    const found = await scanTrainers(Number(o.seconds), show, show);
    if (!found.size) console.log('Nothing found. Is the trainer awake and not connected to another app?');
    else console.log(`\nUse: trainer ride <file> --trainer "${[...found.values()][0].info.name}"   (or set trainerName in config)`);
    process.exit(0);
  });

rideOptions(program.command('ride <route>')
  .description('ride a GPX/FIT course in simulation mode (grade → resistance)'))
  .action(async (file: string, o: RideOpts) => {
    const route = await loadRoute(file);
    console.log(`${route.name}: ${(route.totalDist / 1000).toFixed(1)} km, ↑ ${Math.round(route.ascent)} m, ${route.points.length} pts`);
    await runSession({ kind: 'route', route }, o);
  });

rideOptions(program.command('workout <file>')
  .description('structured workout in ERG mode (.yaml or Zwift .zwo)')
  .option('--ftp <watts>', 'override FTP'))
  .action(async (file: string, o: RideOpts) => {
    const workout = await loadWorkout(file);
    const cfg = await loadConfig();
    const ftp = Number(o.ftp ?? workout.ftp ?? cfg.ftp);
    console.log(`${workout.name}: ${fmtTime(workout.totalS)}, ${workout.steps.length} steps @ FTP ${ftp} W`);
    await runSession({ kind: 'workout', workout, ftp }, o);
  });

rideOptions(program.command('free')
  .description('free ride: fixed ERG power or fixed grade (adjust with +/-)')
  .option('--erg <watts>', 'hold this power')
  .option('--grade <pct>', 'simulate this grade', '0'))
  .action(async (o: RideOpts & { erg?: string; grade?: string }) => {
    await runSession({ kind: 'free', ergW: o.erg ? Number(o.erg) : undefined, gradePct: Number(o.grade) }, o);
  });

const strava = program.command('strava').description('Strava connection');
strava.command('auth')
  .description('connect your Strava account (needs your own API app: strava.com/settings/api, callback domain 127.0.0.1)')
  .option('--client-id <id>')
  .option('--client-secret <secret>')
  .action(async (o) => {
    const cfg = await loadConfig();
    const id = o.clientId ?? process.env.STRAVA_CLIENT_ID ?? cfg.stravaClientId;
    const secret = o.clientSecret ?? process.env.STRAVA_CLIENT_SECRET ?? cfg.stravaClientSecret;
    if (!id || !secret) throw new Error('Need --client-id and --client-secret (or STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET)');
    const t = await stravaAuth(String(id), String(secret));
    console.log(`Connected${t.athlete?.firstname ? ` as ${t.athlete.firstname}` : ''}. Tokens saved.`);
    process.exit(0);
  });
strava.command('status').action(async () => console.log(await stravaStatus()));
strava.command('upload <fitFile>')
  .option('--name <name>')
  .option('--indoor', 'mark as trainer activity')
  .action(async (file: string, o) => {
    const r = await stravaUpload(file, { name: o.name, trainer: o.indoor });
    console.log(`✔ ${r.url}`);
  });

program.command('config [assignments...]')
  .description('show config, or set values: trainer config ftp=265 riderMassKg=72 trainerName=D100')
  .action(async (assignments: string[]) => {
    if (!assignments.length) {
      console.log(`# ${configPath()}`);
      const cfg = await loadConfig();
      for (const [k, v] of Object.entries(cfg)) if (!/secret/i.test(k)) console.log(`${k}: ${v}`);
      return;
    }
    const patch: Record<string, unknown> = {};
    for (const a of assignments) {
      const [k, ...rest] = a.split('=');
      const v = rest.join('=');
      if (!(k in DEFAULTS) && !['trainerName', 'clickName', 'stravaClientId', 'stravaClientSecret'].includes(k)) throw new Error(`Unknown key "${k}"`);
      patch[k] = typeof (DEFAULTS as any)[k] === 'number' ? Number(v) : v;
    }
    await saveConfig(patch as Partial<Config>);
    console.log('saved');
  });

program.command('activities')
  .description('list recorded FIT files')
  .action(async () => {
    const dir = activitiesDir();
    const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.fit')).sort();
    if (!files.length) return console.log(`No activities yet in ${dir}`);
    for (const f of files) console.log(`${f.padEnd(48)} ${((await stat(join(dir, f))).size / 1024).toFixed(0)} KB`);
  });

async function getTrainer(o: RideOpts, cfg: Config): Promise<Trainer> {
  if (o.mock) return new MockTrainer(cfg.ftp * 0.8);
  const filter = o.trainer ?? cfg.trainerName;
  console.log(`Looking for trainer${filter ? ` "${filter}"` : ''}… (pedal to wake it)`);
  return findTrainer(filter);
}

async function runSession(mode: Mode, o: RideOpts) {
  const cfg = await loadConfig();
  if (o.difficulty) cfg.difficulty = Number(o.difficulty) / 100;
  const trainer = await getTrainer(o, cfg);
  await trainer.connect();
  const speedup = Number(o.speedup ?? 1);
  if (!o.mock && speedup !== 1) console.warn('--speedup is ignored with a real trainer');

  const tui = o.tui && process.stdout.isTTY && process.stdin.isTTY;
  const cols = Math.max(60, Math.min(120, (process.stdout.columns ?? 80) - 2));
  const session = new Session(trainer, mode, cfg, { speedup: o.mock ? speedup : 1, profileColumns: cols - 10 });

  const done = new Promise<void>((resolve) => session.once('finished', () => resolve()));
  let inkApp: ReturnType<typeof render> | undefined;
  if (tui) {
    inkApp = render(React.createElement(RideView, { session, onExit: () => undefined }), { exitOnCtrlC: false });
  } else {
    let last = -1;
    session.on('snapshot', (s: Snapshot) => {
      const bucket = Math.floor(s.elapsedS / 10);
      if (bucket === last && !s.finished) return;
      last = bucket;
      const extra = s.mode === 'route' ? `grade ${(s.gradePct ?? 0).toFixed(1)}%  ${(s.distanceM / 1000).toFixed(2)}/${((s.routeTotalM ?? 0) / 1000).toFixed(2)} km`
        : s.mode === 'workout' ? `target ${s.targetW ?? (s.finished ? 'done' : 'free')} W  step ${s.workout!.target.index + 1}/${s.workout!.steps.length}`
        : `${(s.distanceM / 1000).toFixed(2)} km`;
      console.log(`${fmtTime(s.elapsedS).padStart(8)}  ${String(s.powerW).padStart(4)} W  ${String(s.cadenceRpm).padStart(3)} rpm  ${s.speedKmh.toFixed(1).padStart(5)} km/h  ${extra}${s.paused || s.autoPaused ? '  [paused]' : ''}`);
    });
    process.once('SIGINT', () => session.stop());
  }

  session.start();

  // Zwift Click: scan in the background so ride start isn't delayed; the ride never depends on it
  const controllers: Controller[] = [];
  if (!o.mock && o.click) {
    findClicks(cfg.clickName, 20, (c) => {
      controllers.push(c);
      session.attachController(c);
      c.connect().catch((e: Error) => c.emit('log', `Zwift Click: ${e.message}`));
    }).catch((e: Error) => console.error(`Zwift Click scan: ${e.message}`));
  }

  await done;
  if (inkApp) { await new Promise((r) => setTimeout(r, 400)); inkApp.unmount(); }
  await Promise.all(controllers.map((c) => c.disconnect().catch(() => undefined)));
  await trainer.disconnect().catch(() => undefined);

  const rec = session.recorder;
  if (!rec.samples.length) { console.log('Nothing recorded.'); process.exit(0); }
  const now = session.now;
  const bytes = rec.toFit(now);
  await mkdir(activitiesDir(), { recursive: true });
  const stamp = rec.samples[0].time.toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const slug = rec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ride';
  const file = join(activitiesDir(), `${stamp}-${slug}.fit`);
  await writeFile(file, bytes);
  const s = rec.samples;
  const avgP = Math.round(s.reduce((a, x) => a + (x.powerW ?? 0), 0) / s.length);
  console.log(`\n✔ ${fmtTime(rec.timerSeconds)} · ${(s[s.length - 1].distanceM / 1000).toFixed(2)} km · avg ${avgP} W`);
  console.log(`  saved ${file}`);

  let upload = o.upload;
  if (upload === undefined && process.stdin.isTTY && !(await stravaStatus()).startsWith('not')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    upload = !/^n/i.test(await rl.question('Upload to Strava? [Y/n] '));
    rl.close();
  }
  if (upload) {
    try {
      const r = await stravaUpload(file, { name: o.name ?? rec.name, trainer: mode.kind !== 'route' });
      console.log(`✔ Strava: ${r.url}`);
    } catch (e: any) {
      console.error(`✖ Strava upload failed: ${e.message}\n  retry: trainer strava upload "${file}"`);
    }
  }
  process.exit(0);
}

program.parseAsync().catch((e) => {
  console.error(`✖ ${e.message}`);
  process.exit(1);
});
