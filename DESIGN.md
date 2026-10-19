# trainer-cli — design

A terminal-first controller for BLE smart trainers. Target hardware: Decathlon D100
(Bluetooth FTMS only), but anything that speaks the standard **Fitness Machine
Service** works. Runs on macOS / Linux (Node 22+).

## Goals

| # | Feature | MVP status |
|---|---------|-----------|
| 1 | Discover, connect and control a BLE FTMS trainer | ✅ |
| 2 | Simulate a ride from a GPX or FIT course (grade → resistance, virtual speed) | ✅ |
| 3 | Structured workouts (ERG mode, %FTP steps, ramps, repeats; YAML or Zwift `.zwo`) | ✅ |
| 4 | Record to FIT and upload to Strava | ✅ |
| 5 | Live full-screen TUI | ✅ |
| – | Heart-rate strap (BLE HRS 0x180D) | roadmap |
| – | ANT+ FE-C bridge for the Edge 550 | roadmap (separate firmware project) |

Non-goals: 3D world, multiplayer, power-curve analytics (Strava/intervals.icu do that).

## Architecture

Light **onion architecture**: four layers, dependencies point inwards only.

```
  ┌─────────────────────────────── presentation ───────────────────────────────┐
  │  cli.ts (commander, composition root) · RideRunner · ui/RideView.tsx (Ink) │
  │  ┌──────────────────────────── infrastructure ───────────────────────────┐  │
  │  │ BleScanner · BleFtmsTrainer · MockTrainer · FTMS codec · Real/SimClock│  │
  │  │ Route/WorkoutLoader + parsers · FitEncoder · FitFileStore             │  │
  │  │ StravaClient · ConfigFile                                             │  │
  │  │  ┌───────────────────────── application ──────────────────────────┐   │  │
  │  │  │ Session (1 Hz tick) + AutoPause · PowerStats · TrainerCommander│   │  │
  │  │  │ RideFinisher · ports: Trainer · Clock · ActivityStore ·        │   │  │
  │  │  │ ActivityUploader · RouteSource · WorkoutSource · ConfigStore   │   │  │
  │  │  │  ┌────────────────────────── domain ────────────────────────┐  │   │  │
  │  │  │  │ RideMode strategies (route · workout · free) · RiderModel │  │   │  │
  │  │  │  │ Route + RouteCursor · Workout · Power · Duration · Recorder│  │   │  │
  │  │  │  │ Config · TrainerData                                      │  │   │  │
  │  │  │  └───────────────────────────────────────────────────────────┘  │   │  │
  │  │  └─────────────────────────────────────────────────────────────────┘   │  │
  │  └─────────────────────────────────────────────────────────────────────────┘  │
  └────────────────────────────────────────────────────────────────────────────────┘
```

Rules (enforced by `test/architecture.test.ts`):

- **domain** imports only domain, and no packages at all: pure TypeScript, no I/O.
- **application** imports domain + its own ports (only `node:events` from outside).
- **infrastructure** implements the ports and may use any package; it never imports presentation.
- **presentation** creates the concrete adapters (`cli.ts` for long-lived ones, `RideRunner` for
  per-ride ones) and renders the UI.

Style: object-oriented. Behaviour lives on the object that owns the data (`workout.targetAt`,
`route.cursor()`, `model.stepSpeed`, `Power.parse`), file formats and services sit behind
interfaces, and `Session` composes small collaborators. Deliberately left as plain functions:
the FTMS codec (stateless byte transforms) and the Ink UI (function components + hooks).

Everything above the `Trainer` port is BLE-free, so the whole app runs and is testable with
`--mock`. The mock runs on a `SimClock` (speedable), the BLE trainer on a `RealClock`, and the
session doesn't know which one it has.

Adding things usually means one new file in one layer:

| Want | Add |
|------|-----|
| new ride mode | a `RideMode` in `domain/modes/` + a command in `cli.ts` |
| new workout/course format | a `WorkoutParser` / `RouteParser` class + one entry in its loader's parser list |
| new device (HR strap, ANT+) | an adapter in `infrastructure/` behind a port |
| new upload target | an `ActivityUploader` in `infrastructure/` |

### Modules

| Path | Responsibility |
|------|----------------|
| `src/domain/modes/*.ts` | `RideMode` strategy + `RouteMode`, `WorkoutMode`, `FreeMode`: trainer targets, motion, +/- behaviour, end condition, mode-specific snapshot. |
| `src/domain/physics.ts` | `RiderModel`: power ↔ speed on a given grade, speed integration. |
| `src/domain/route.ts` | `Route` (`fromPoints`, distance/ascent, `cursor()`), `RouteCursor` (smoothed grade lookup). |
| `src/domain/workout.ts` | `Workout` (validation, `targetAt(t)`), `Power` and `Duration` value objects. |
| `src/domain/activity.ts` | `Recorder`: samples, laps, timer pauses → `FinishedActivity`. |
| `src/domain/config.ts`, `trainer-data.ts`, `math.ts` | Config type + defaults, trainer data/feature types, `clamp`. |
| `src/application/ports.ts` | `Trainer`, `Clock`, `ActivityStore`, `ActivityUploader`, `RouteSource`, `WorkoutSource`, `ConfigStore`. |
| `src/application/session.ts` | `Session`: tick loop, pause state, recording, snapshots; delegates to the `RideMode`. |
| `src/application/auto-pause.ts`, `power-stats.ts`, `trainer-commander.ts` | Session collaborators: no-pedalling detection, 3 s/average power, throttled ERG/grade writes. |
| `src/application/ride.ts` | `RideFinisher`: close recording → store, upload. |
| `src/infrastructure/ftms/codec.ts` | Encode Control Point commands, decode Indoor Bike Data / responses / feature bits. Pure functions. |
| `src/infrastructure/trainer/ble.ts` | `BleScanner` (lazy noble, scan/find) and `BleFtmsTrainer` (GATT, 0x2AD2 notify, 0x2AD9 control). |
| `src/infrastructure/trainer/mock.ts` | Physics-based fake trainer driven by the clock (responds to ERG / sim commands, plausible cadence). |
| `src/infrastructure/clock.ts` | `RealClock`, `SimClock(speedup)`. |
| `src/infrastructure/route/*.ts`, `workout/*.ts` | `RouteLoader` / `WorkoutLoader` pick a `GpxRouteParser`, `FitRouteParser`, `YamlWorkoutParser` or `ZwoWorkoutParser` by extension. |
| `src/infrastructure/fit-encoder.ts`, `activity-store.ts` | `FitEncoder`: `FinishedActivity` → FIT bytes; `FitFileStore` writes `~/.trainer-cli/activities/*.fit`. |
| `src/infrastructure/strava.ts` | `StravaClient` (OAuth loopback, token refresh, upload + poll), `StravaTokenFile`. |
| `src/infrastructure/config-file.ts` | `ConfigFile`: `~/.trainer-cli` paths, config YAML load/save. |
| `src/presentation/ride-runner.ts` | `RideRunner`: connect → ride (TUI or log lines) → save → upload prompt. |
| `src/presentation/ui/*.tsx` | Ink components: header, big numbers, grade/elevation sparkline, workout bar. |
| `src/presentation/cli.ts` | Commands + composition root. |

## FTMS protocol notes

Service `0x1826`. Characteristics used:

| UUID | Name | Use |
|------|------|-----|
| `0x2ACC` | Fitness Machine Feature | read: which targets are supported |
| `0x2AD2` | Indoor Bike Data | notify: speed, cadence, power, HR… (flags-driven variable layout) |
| `0x2AD9` | Fitness Machine Control Point | write + indicate |
| `0x2ADA` | Fitness Machine Status | notify (optional, logged) |

Control Point opcodes used:

| Op | Name | Params |
|----|------|--------|
| `0x00` | Request Control | – (must precede everything) |
| `0x01` | Reset | – |
| `0x05` | Set Target Power | `sint16` W |
| `0x07` | Start/Resume | – |
| `0x08` | Stop/Pause | `uint8` 1=stop 2=pause |
| `0x11` | Set Indoor Bike Simulation | wind `sint16` 0.001 m/s · grade `sint16` 0.01 % · Crr `uint8` 0.0001 · Cw `uint8` 0.01 kg/m |

Responses arrive as indications `0x80, reqOp, result` (1 = success). Commands are
serialised through a queue — one in flight, 2 s timeout — because cheap trainers
(D100 included) drop writes that arrive while a previous one is pending.

Indoor Bike Data decoding follows the flags bitfield (bit 0 is *inverted*: 0 means
instantaneous speed **is** present). Fields decoded: speed, avg speed, cadence
(0.5 rpm), avg cadence, distance (uint24), resistance, power, avg power, energy,
HR, MET, elapsed, remaining.

### D100-specific expectations

- Bluetooth FTMS only, no ANT+. Advertises as `D100…` / `Decathlon…`.
- It's a wheel-on trainer with limited max resistance — expect it to **saturate on
  steep grades and high ERG targets at low cadence**. The engine clamps grade
  (default −10 … +15 %, configurable) and sends a `difficulty` scale factor
  (default 100 %) the user can turn down from the TUI.
- Spin-down calibration isn't exposed via FTMS on this unit; use the Decathlon app.

## Ride simulation (route mode)

Every tick (1 s):

1. Read latest power `P` from trainer.
2. Look up grade `g` at current virtual distance `d` (grade from 30 m smoothed
   elevation window to kill GPS noise; clamped; × difficulty).
3. Send `SetIndoorBikeSimulation(g, wind=0, Crr=0.004, Cw=0.51)` — only when grade
   changed by ≥ 0.1 % or 5 s elapsed (keeps BLE quiet).
4. Integrate virtual speed: `m·dv/dt = P/v − (½ρCdA·v² + Crr·m·g·cosθ + m·g·sinθ)`
   with rider+bike mass from config. Gives realistic coasting/acceleration rather
   than steady-state jumps.
5. `d += v·dt`; interpolate lat/lon/ele → recorder.

GPX: `<trkpt>` or `<rtept>` with `<ele>`. FIT: course or activity file, uses
`record` messages (`positionLat/Long`, `enhancedAltitude`/`altitude`, `distance`).
Missing distance is computed by haversine.

## Structured workouts (workout mode)

Native YAML format:

```yaml
name: 4x8 threshold
ftp: 250            # optional, CLI --ftp overrides
steps:
  - warmup: { duration: 10m, from: 50%, to: 75% }
  - repeat: 4
    steps:
      - work:     { duration: 8m, power: 100% }
      - recovery: { duration: 4m, power: 55% }
  - cooldown: { duration: 8m, from: 65%, to: 45% }
```

Power can be `%` of FTP or absolute `W`. Zwift `.zwo` (Warmup, SteadyState,
IntervalsT, Ramp, Cooldown, FreeRide) is also parsed. FreeRide steps switch to
sim mode at 0 % grade. ERG target is resent each tick only if it changed by ≥ 1 W
(ramps step smoothly). Each step = a FIT lap.

## Recording & Strava

- Samples at 1 Hz → FIT activity: `file_id(type=activity)`, `event(timer start/stop)`,
  `record[]` (timestamp, power, cadence, HR, speed, distance, altitude, position),
  `lap[]`, `session(sport=cycling, sub_sport=virtual_activity | indoor_cycling)`,
  `activity`. Route rides with GPS → Strava shows *Virtual Ride* on the map;
  workouts → *Indoor ride*.
- Files land in `~/.trainer-cli/activities/YYYY-MM-DD-HHMM-<name>.fit` even if upload
  fails — upload can be retried with `trainer strava upload <file>`.
- Strava: create your own API app at strava.com/settings/api (callback domain
  `127.0.0.1`). `trainer strava auth` opens the consent URL, catches the redirect
  on `http://127.0.0.1:8723/callback`, exchanges the code, stores tokens in
  `~/.trainer-cli/strava.json` (0600). Scope `activity:write`. Tokens refreshed
  automatically (6 h expiry). Upload = `POST /api/v3/uploads` multipart
  (`data_type=fit`), then poll `/uploads/{id}` until `activity_id` or `error`.

## TUI

```
 trainer-cli · ROUTE  Krkonoše loop               ⏱ 00:42:17   ● D100 connected
 ─────────────────────────────────────────────────────────────────────────────
   POWER        CADENCE      SPEED        GRADE        HR
   247 W        88 rpm       27.4 km/h    +4.2 %       – bpm
   3s avg 241   avg 86       dist 18.62 / 42.10 km    ↑ 412 m
 ─────────────────────────────────────────────────────────────────────────────
  elevation ▁▁▂▃▄▅▆▇█▇▆▅▄▃▂▁▁▂▃▄▅▅▆▆▇▇█▇▅▃▂▁   ▲ you are here
  [space] pause  [+/-] difficulty/ERG ±5  [l] lap  [q] finish & save
```

Workout mode replaces the elevation strip with the step list + progress bar and
shows `target → actual` power.

## Config

`~/.trainer-cli/config.yaml`:

```yaml
ftp: 250
riderMassKg: 75
bikeMassKg: 9
cda: 0.32
crr: 0.004
maxGrade: 15
minGrade: -10
difficulty: 1.0
trainerName: D100      # auto-connect filter; omit to pick from scan
```

## Testing strategy

- Pure units: FTMS codec (byte-exact fixtures), physics, parsers, workout resolver.
- Ride modes against a fake `RideContext`; `TrainerCommander`, `AutoPause`, `PowerStats`, loaders (no timers, no trainer).
- Architecture: layer dependency rule over `src/**` imports.
- Full ride headless: `trainer ride route.gpx --mock --speedup 60 --no-tui`
  produces a FIT; decode it back with the FIT SDK and assert record count/laps.
- Real hardware: `trainer scan` + `trainer free --erg 150` smoke test.

## Roadmap

1. BLE heart-rate strap.
2. Remember last device, auto-reconnect on drop (mid-ride resume).
3. `.erg/.mrc` workout import; intervals.icu workout download.
4. Course preview command (`trainer route info x.gpx` with ASCII profile).
5. ANT+ FE-C bridge (XIAO nRF52840) so the Edge 550 can control/record — separate repo.
