# trainer-cli — developer guide

A walkthrough of how the app actually works. We follow **one ride**, from typing
`trainer ride examples/climb-loop.gpx` to the FIT file on disk and the Strava upload,
and open each key file at the moment it matters.

[DESIGN.md](DESIGN.md) is the reference: the module table, the FTMS opcode tables, the
file formats and the roadmap. This guide is the tour, and it links back to DESIGN.md
instead of repeating those tables.

**Suggested reading order:** sections 1–4 give you the skeleton (the CLI, the runner and
the engine). Sections 5–6 cover the ride logic, and 7–10 cover the I/O edges. If you only
have 20 minutes, read [§4 Session](#4-the-engine--session) and
[§5 Ride modes](#5-ride-modes--the-strategy-pattern); everything else plugs into those two.

---

## 0. The big picture in 60 seconds

The code is split into four layers, and dependencies only point inwards
(this is enforced by [test/architecture.test.ts](test/architecture.test.ts)):

| Layer | Folder | Knows about | Typical content |
|-------|--------|-------------|-----------------|
| domain | [src/domain/](src/domain/) | nothing (pure TS, no packages) | physics, routes, workouts, ride modes, the recorder |
| application | [src/application/](src/application/) | domain + its own ports | the `Session` tick loop, ports (interfaces), small helpers |
| infrastructure | [src/infrastructure/](src/infrastructure/) | application + domain + any npm package | BLE, FTMS codec, clocks, file parsers, FIT encoder, Strava |
| presentation | [src/presentation/](src/presentation/) | everything | CLI commands, wiring, the Ink TUI |

How data moves during a ride:

```
 cli.ts ──builds──▶ RideRunner ──builds──▶ Session ◀──strategy──▶ RideMode (route | workout | free)
                                             │  ▲
               sendErg / sendGrade (throttled│  │ 'data' events (TrainerData)
                via TrainerCommander)        ▼  │
                                         Trainer port
                                    ┌────────┴────────┐
                              BleFtmsTrainer      MockTrainer
                              (noble + codec)     (virtual rider)

 Session ──'snapshot'──▶ RideView (Ink TUI)  or  RideRunner.logSnapshots (headless)
 Session.recorder ──finish──▶ FinishedActivity ──▶ FitEncoder ──▶ FitFileStore ──▶ StravaClient
```

Time comes from a `Clock` port: the real wall clock for a real trainer, and a simulated,
speedable clock for the mock. That one swap is why the whole app runs and tests without
Bluetooth.

---

## 1. Entry point & composition root — `cli.ts`

[src/presentation/cli.ts](src/presentation/cli.ts) is the `trainer` binary (see `bin` in
[package.json](package.json)). It uses [commander](https://github.com/tj/commander.js) for
argument parsing, and it is also the **composition root**: the one place where concrete
classes get chosen.

- **Long-lived adapters** are created once at the top
  ([cli.ts:18-22](src/presentation/cli.ts#L18-L22)): `ConfigFile`, `StravaClient`,
  `BleScanner` and the `RideRunner` that receives them. Per-ride objects (the clock, the
  trainer, the activity store) are created later by `RideRunner`, because which ones you
  need depends on the flags.
- **Shared ride flags** (`--mock`, `--trainer`, `--speedup`, `--no-tui`, `--upload`, …) are
  added to every ride command by `rideOptions`
  ([cli.ts:29-38](src/presentation/cli.ts#L29-L38)).
- **Ride commands** (`ride`, `workout`, `free`) all follow the same shape. They load their
  input, print a one-line summary, then call `runner.run(modeFactory, opts)`:

  ```ts
  // cli.ts:55-60
  const route = await new RouteLoader().load(file);
  await runner.run((cfg, model, columns) => new RouteMode(route, {
    model, minGrade: cfg.minGrade, maxGrade: cfg.maxGrade, difficulty: cfg.difficulty, profileColumns: columns - 10,
  }), o);
  ```

  **Why a factory, not a ready-made mode?** The mode needs the loaded config, the
  `RiderModel` and the terminal width. The command doesn't have those yet; the runner works
  them out. The `ModeFactory` type is declared in
  [ride-runner.ts:31](src/presentation/ride-runner.ts#L31).
- **Non-ride commands**: `scan`, `strava auth|status|upload`, `config` (prints the config, or
  sets values from `key=value` assignments, checked against `DEFAULTS`) and `activities`
  (lists the FIT files). They are thin wrappers around the infrastructure classes.
- Errors from any command end up in the single `.catch` at the bottom
  ([cli.ts:136-139](src/presentation/cli.ts#L136-L139)), which prints `✖ message` and
  exits with code 1.

---

## 2. One ride, end to end — `RideRunner`

[src/presentation/ride-runner.ts](src/presentation/ride-runner.ts) orchestrates a single
ride. `run()` ([ride-runner.ts:37-62](src/presentation/ride-runner.ts#L37-L62)) reads top to
bottom like a script:

1. **Load config.** `--difficulty 70` overrides `cfg.difficulty` (as a fraction, 0.7).
2. **Pick a clock.** `--mock` gives a `SimClock(speedup)`; otherwise a `RealClock`.
3. **Connect a trainer** (`connectTrainer`,
   [ride-runner.ts:64-74](src/presentation/ride-runner.ts#L64-L74)). A `SimClock` means mock
   mode, so the runner creates a `MockTrainer` driven by that clock with a base power of
   80 % of FTP. Otherwise `BleScanner.find(filter)` scans until a trainer whose name
   contains the `--trainer` value (or `trainerName` from config) shows up. Either way, it
   then calls `trainer.connect()`.
4. **Build the engine.** `RiderModel.fromConfig(cfg)` → `makeMode(cfg, model, cols)` →
   `new Session(trainer, mode, clock, { crr, cw })`.
   Then `connectControllers` starts a background Zwift Click scan (skipped with `--mock`
   or `--no-click`) and attaches every Click it finds to the session. It is not awaited,
   so the ride never waits for a Click (see [section 7](#handlebar-remotes--zwift-click)).
5. **Ride** (`ride()`, [ride-runner.ts:92-103](src/presentation/ride-runner.ts#L92-L103)).
   With a TTY it renders the Ink `RideView`. Without one, or with `--no-tui`, it attaches
   `logSnapshots` (one line per 10 s of ride time) and maps Ctrl-C to `session.stop()`.
   Then it calls `session.start()` and awaits the session's `finished` event.
6. **Tear down & save.** It disconnects any Clicks and the trainer, then
   `RideFinisher.save(session)` writes the FIT file and prints the summary.
7. **Upload** (`maybeUpload`, [ride-runner.ts:119-133](src/presentation/ride-runner.ts#L119-L133)).
   `--upload` / `--no-upload` decide without asking; otherwise it asks "Upload to Strava?
   [Y/n]", but only on a TTY and only if Strava is connected. A failed upload never loses
   the ride: the file is already saved, and the error prints the retry command.

The runner ends the process explicitly with `process.exit(0)`. noble and Ink both keep
handles open that would otherwise keep Node alive.

---

## 3. Loading routes and workouts

### The loader pattern

[src/infrastructure/format-loader.ts](src/infrastructure/format-loader.ts) has a tiny
abstract base class. A `FileFormat` declares `extensions` and a `parse(data, fallbackName)`
method. `FormatLoader.load(path)`
([format-loader.ts:16-21](src/infrastructure/format-loader.ts#L16-L21)) picks the format
whose extensions contain the file's extension, reads the file, and parses it. For an
unknown extension it throws an error listing the supported ones.

The two concrete loaders only differ in **how they read the file** and **which parsers
they register**:

- [RouteLoader](src/infrastructure/route/loader.ts#L10) reads bytes (`Uint8Array`, since FIT
  is binary) and registers `GpxRouteParser` and `FitRouteParser`.
- [WorkoutLoader](src/infrastructure/workout/loader.ts#L10) reads UTF-8 text and registers
  `YamlWorkoutParser` and `ZwoWorkoutParser`.

To add a format, write a parser class and add it to that loader's default list.

### Course parsers → `Route`

- [gpx.ts](src/infrastructure/route/gpx.ts) uses `fast-xml-parser` and collects `<trkpt>`s
  from every track segment. If there are none, it falls back to `<rtept>`s.
- [fit.ts](src/infrastructure/route/fit.ts) uses the Garmin FIT SDK and maps `record`
  messages. Lat/lon are stored as *semicircles* and converted with `180 / 2³¹`.

Both produce **raw points** where any field may be missing, then hand off to the domain
with `Route.fromPoints(name, raw)` ([route.ts:22-37](src/domain/route.ts#L22-L37)). That
function does the cleanup:

- **Missing distance** (typical for GPX) is accumulated with the haversine formula.
- **Missing elevation** carries the last known value forward.
- **Stationary or duplicate points** (distance not increasing) are dropped
  ([route.ts:33](src/domain/route.ts#L33)). This keeps the later interpolation free of
  division by zero.

### Workout parsers → `Workout`

- [yaml.ts](src/infrastructure/workout/yaml.ts) walks the `steps` list recursively. Each
  item is either `repeat: n` with nested `steps` (expanded inline, with labels prefixed
  `1/4 `, `2/4 `, …) or a single-key object whose key is one of `STEP_KINDS` (`warmup`,
  `work`, `recovery`, `cooldown`, `steady`, `free`). It accepts `power` for steady steps
  and `from`/`to` for ramps. `.json` works too, because YAML is a superset of JSON.
- [zwo.ts](src/infrastructure/workout/zwo.ts) parses Zwift XML with `preserveOrder: true`
  (step order matters) and maps `Warmup`/`Ramp`/`Cooldown`, `SteadyState`, `IntervalsT`
  (expanded into on/off pairs) and `FreeRide`.

The parsers lean on two **value objects** in [workout.ts](src/domain/workout.ts):

- `Power.parse` ([workout.ts:9-17](src/domain/workout.ts#L9-L17)) reads `"75%"` as an FTP
  fraction and `"200W"` as watts. A bare number ≤ 3 counts as a fraction, anything bigger
  as watts. `power.resolve(ftp)` turns it into watts at ride time, so `--ftp` can override
  it without re-parsing.
- `Duration.parse` ([workout.ts:26-39](src/domain/workout.ts#L26-L39)) accepts `90s`, `5m`,
  `1h30m`, `1:30` and `1:02:03`.

The `Workout` constructor validates the steps (none empty, every duration > 0) and
precomputes `totalS`. We look at `targetAt` in §6.

---

## 4. The engine — `Session`

[src/application/session.ts](src/application/session.ts) is the heart of the app. It has
no idea whether it is driving Bluetooth or a mock, whether time is real or simulated, or
which kind of ride this is. It runs a **1 Hz loop** and delegates everything specific.

### Construction ([session.ts:61-69](src/application/session.ts#L61-L69))

- It creates the `Recorder` (from the domain), and the `TrainerCommander`.
- It builds the `RideContext` once (more on this below).
- It subscribes to the trainer's events:
  - `data`: **merged** into `this.latest` (`{ ...latest, ...d }`), because a trainer may
    send partial packets. The arrival time is stored in `latestAt`, in *clock* time.
  - `log`: pushed into a 5-line rolling log shown in the TUI.
  - `disconnect`: sets `connected = false`, which the header shows in red.

### `start()` ([session.ts:71-78](src/application/session.ts#L71-L78))

```ts
this.recorder.start(this.now);
this.emitSnapshot();
this.mode.control(this.ctx)...;               // first target goes out immediately
this.cancelTick = this.clock.every(1, (dt) => void this.tick(dt));
```

The first `control()` call happens before the first tick, so the trainer gets its
resistance or ERG target straight away instead of a second later.

### One tick, line by line ([session.ts:145-177](src/application/session.ts#L145-L177))

1. **Freshness.** If no trainer data arrived in the last 3 s of clock time, power and
   cadence count as 0. This stops a dropped connection from recording a frozen 250 W
   forever.
2. **Auto-pause.** `AutoPause.update(power, cadence)`, then `applyPause()`. The recorder is
   paused if *either* the manual pause *or* the auto-pause is active.
3. **`mode.control(ctx)`.** The mode decides the trainer target and calls
   `ctx.sendErg` or `ctx.sendGrade`. Errors are logged, never thrown: one failed BLE write
   must not end the ride.
4. **`mode.advance(ctx, dt)`** returns a `Motion` (speed, distance, optional
   altitude/lat/lon). In a route ride this is the *virtual* bike's position.
5. **`PowerStats.add(power, recording)`** updates the 3 s and average power.
6. **`recorder.add(sample, dt)`**, only while recording. The sample merges the trainer's
   power, cadence and HR with the mode's motion.
7. **`emitSnapshot()`** builds the `Snapshot` the UI renders. Generic fields come from the
   session, and `...this.mode.snapshot(ctx)` adds the mode-specific ones.
8. **`mode.finishReason(ctx)`**: if it returns a string ("route finished", "workout
   finished"), the session logs it and calls `stop()`.

> Note: the clock callback is fire-and-forget (`void this.tick(dt)`), and step 3 awaits a
> BLE write that can take up to its 2 s timeout. On a real trainer, a slow write can make
> two ticks overlap. In practice writes take tens of milliseconds, but keep this in mind
> if you add async work to the tick.

### The `RideContext` trick ([session.ts:131-143](src/application/session.ts#L131-L143))

Modes see the session only through the
[`RideContext`](src/domain/modes/ride-mode.ts#L5-L15) interface. The session implements it
with **getters**, so `ctx.powerW` and `ctx.timerS` always return the current value, without
building a new object every tick. This keeps the domain layer free of any application
types: a mode can't reach into the session, the trainer or the clock, which makes modes
trivially testable with a fake context (see [test/modes.test.ts](test/modes.test.ts)).

### User actions

- `togglePause()` flips the manual pause flag.
- `adjust(±1)` is the `+`/`-` key. It calls `mode.adjust`, then
  `commander.invalidate()`, so the new target goes out on the next tick even if
  throttling would normally hold it back.
- `manualLap()` closes the current lap in the recorder.
- `attachController(c)` wires a handlebar remote: its `adjust` events call `adjust(±1)`,
  its `log` lines go to the session log, and `connected` / `disconnect` update the
  `controllers` list in the snapshot (the TUI header shows `● Click` / `○ Click`).
- `stop()` ([session.ts:80-86](src/application/session.ts#L80-L86)) cancels the tick and
  **freezes ride time** by storing `stoppedAt`. From then on, `session.now` returns that
  moment, so the last lap, the `finish()` timestamp and the FIT `endedAt` all agree even if
  the clock keeps moving while the app tears down. It emits `finished` exactly once.

### The session's helpers

- [trainer-commander.ts](src/application/trainer-commander.ts) keeps BLE quiet:
  - **ERG** is sent only when the target changes by ≥ 1 W.
  - **Grade** is rounded to 0.1 % and sent when it changes by ≥ 0.1 %, or at least every 5 s
    as a keep-alive.
  - Sending one kind clears the memory of the other, so switching between ERG and
    simulation (e.g. a workout's free-ride step) always sends.

  Cheap trainers like the D100 drop writes when they are flooded, which is why this class
  exists.
- [auto-pause.ts](src/application/auto-pause.ts) pauses after 3 consecutive seconds with
  power < 5 W **and** cadence < 5 rpm, and resumes on the first sample that breaks that
  condition. `update()` returns `true` only when the state *changes*, so the session logs
  each transition once.
- [power-stats.ts](src/application/power-stats.ts) keeps a 3-sample window for the 3 s
  power, and a sum/count over *recorded* seconds only. Pauses don't drag the average down.

---

## 5. Ride modes — the strategy pattern

Everything that differs between "ride a course", "do a workout" and "free ride" sits
behind one interface, [`RideMode`](src/domain/modes/ride-mode.ts#L43-L56):

| Method | Called | Job |
|--------|--------|-----|
| `control(ctx)` | every tick (+ once at start) | decide and send the trainer target |
| `advance(ctx, dt)` | every tick | move the rider, return `Motion` |
| `adjust(dir)` | `+`/`-` key | change difficulty / offset / target |
| `finishReason(ctx)` | every tick | return a reason to stop, or `undefined` |
| `snapshot(ctx)` | every snapshot | mode-specific dashboard fields (`ModeSnapshot`) |

Plus three readonly fields:
- `kind`: drives the UI layout.
- `title`: the activity name.
- `recordingKind`: `'virtual'` or `'indoor'`. This decides the FIT sub-sport and the Strava
  activity type.

### `RouteMode` ([route-mode.ts](src/domain/modes/route-mode.ts))

The trainer gets the road grade, and the bike's speed comes from physics.

- **What gets sent** ([route-mode.ts:35-39](src/domain/modes/route-mode.ts#L35-L39)):
  `clamp(roadGrade, minGrade, maxGrade) × difficulty`. The clamp protects trainers with
  limited resistance (see the D100 notes in DESIGN.md). Difficulty lets you take the edge
  off a climb.
- **Moving** ([route-mode.ts:41-49](src/domain/modes/route-mode.ts#L41-L49)): the next speed
  comes from `RiderModel.stepSpeed(v, power, roadGrade, dt)`. Note that this uses the
  **real** grade, not the sent one, so your virtual speed matches the actual course. If
  you're paused, the power is 0, so the bike coasts to a stop. Distance only grows while
  recording and is capped at the route length. Ascent is accumulated as you go.
- `+`/`-` changes difficulty by ±10 % (range 0–200 %). The ride finishes when
  `dist >= route.totalDist`.
- The TUI's elevation profile is computed **once** in the constructor
  (`cursor.profile(columns)`), sized to the terminal width.

### `WorkoutMode` ([workout-mode.ts](src/domain/modes/workout-mode.ts))

ERG mode: the trainer holds the wattage, no matter your cadence.

- **The target** is `workout.targetAt(ctx.timerS, ftp)`. It is driven by *timer* time, so
  pausing pauses the workout too.
- **Step changes** ([workout-mode.ts:21-25](src/domain/modes/workout-mode.ts#L21-L25)):
  when the step index changes, the mode calls `ctx.lap(nextStepLabel)`. Every step becomes
  one FIT lap.
- **Free-ride steps** (`watts === null`) switch the trainer to simulation at 0 % grade.
- **While paused**, the ERG target drops to at most 100 W
  ([workout-mode.ts:28](src/domain/modes/workout-mode.ts#L28)), so you don't restart
  against 300 W.
- `+`/`-` changes an ERG offset by ±5 W, added on top of every step's target.
- Speed and distance come from [`TrainerOdometer`](src/domain/modes/trainer-odometer.ts):
  the trainer's own reported speed, integrated while recording.

### `FreeMode` ([free-mode.ts](src/domain/modes/free-mode.ts))

Either fixed ERG (`--erg 150`, `+`/`-` = ±5 W, never below 0) or a fixed grade (`--grade 2`,
`+`/`-` = ±0.5 % within the min/max grade). It never finishes on its own; you quit with `q`.
It also uses `TrainerOdometer`.

| | route | workout | free |
|---|---|---|---|
| trainer target | grade (sim) | ERG (sim at 0 % on free steps) | ERG *or* grade |
| speed source | physics model | trainer | trainer |
| `+`/`-` | difficulty ±10 % | ERG offset ±5 W | ±5 W or ±0.5 % |
| finishes when | end of course | last step done | never (press `q`) |
| FIT sub-sport | virtual activity | indoor cycling | indoor cycling |

---

## 6. Domain models: physics, route cursor, workout targets

### `RiderModel` ([physics.ts](src/domain/physics.ts))

This is a one-dimensional model of a bike on a road.
`resistiveForce(v, grade)` ([physics.ts:19-25](src/domain/physics.ts#L19-L25)) adds up
three forces:

- **aero**: `½·ρ·CdA·v·|v|`
- **rolling**: `Crr·m·g·cosθ`. It is only applied above 0.05 m/s, so a stopped bike doesn't
  roll backwards.
- **gravity**: `m·g·sinθ`, with `θ = atan(grade/100)`

`stepSpeed` ([physics.ts:46-56](src/domain/physics.ts#L46-L56)) integrates
`m·dv/dt = P/v − F` with **10 explicit Euler sub-steps** per tick for stability. Three
details matter:

- `drive = P / max(v, 1)`: at very low speed, `P/v` would be enormous. Capping the divisor
  at 1 m/s makes starting from a standstill finite and realistic.
- `effMass = m + 1.5 kg` approximates the rotational inertia of the wheels.
- `v` is floored at 0.

So when you stop pedalling on a descent, you *accelerate*, and when you hit a climb at
speed, you bleed it off gradually. That's the "feel" of route mode.

`cw` ([physics.ts:17](src/domain/physics.ts#L17)) is `½·ρ·CdA` in kg/m, the unit FTMS
simulation expects. The session passes it, along with `crr`, to every grade command.
`steadySpeed` (a bisection search) is used only in tests, to check that the model is
plausible.

### `Route` and `RouteCursor` ([route.ts](src/domain/route.ts))

A `Route` is an immutable list of `{dist, ele, lat?, lon?}` points sorted by distance,
plus its `totalDist` and `ascent`. Lookups go through a `RouteCursor`:

- **A sequential cursor** ([route.ts:55-60](src/domain/route.ts#L55-L60)). The cursor
  remembers the segment index `i` and walks forward from it. Asking for a distance
  *behind* the cursor resets it to 0 and walks again from the start.
- **Smoothed grade** ([route.ts:73-81](src/domain/route.ts#L73-L81)). The grade is
  `(ele(d+15) − ele(d−15)) / 30 m`, a 30 m window that removes GPS elevation noise, which
  would otherwise make the resistance jitter. Each `at(d)` looks up `d`, then `d−15`, then
  `d+15`, then `d` again (line 78, "restore cursor position").
  - **Caveat:** whenever course points are closer together than 15 m, the `d−15` lookup
    lands behind the cursor and restarts the walk from index 0. So in practice a lookup
    costs O(n), not O(1) as the class comment says. That's harmless for courses with a few
    thousand points at 1 Hz. It's worth knowing if you ever call `at()` in a hot loop.
- `profile(columns)` samples the elevation at evenly spaced distances for the TUI
  sparkline.

### `Workout.targetAt` ([workout.ts:73-88](src/domain/workout.ts#L73-L88))

This walks the steps, adding up their durations, until it finds the step containing `t`.
Inside the step, `watts = from + (to − from) × (elapsed / duration)`, which gives a linear
ramp; steady steps have `from == to`. It returns the step, its index, the elapsed and
remaining time, and `watts` (`null` for free steps). Past the end, it returns
`done: true`, which is what `WorkoutMode.finishReason` checks.

---

## 7. Talking to the trainer

### The port ([ports.ts:12-19](src/application/ports.ts#L12-L19))

A `Trainer` is an `EventEmitter` with these methods:
- `connect()` and `disconnect()`
- `setErgPower(watts)`
- `setSimulation({gradePct, windMs?, crr?, cw?})`

It emits `data`, `log` and `disconnect`. Everything above this line is Bluetooth-free.

### The FTMS codec ([codec.ts](src/infrastructure/ftms/codec.ts))

These are pure functions with no BLE dependency, so they can be tested byte for byte.

**Decoding Indoor Bike Data** ([codec.ts:38-65](src/infrastructure/ftms/codec.ts#L38-L65)).
A packet is a 16-bit little-endian flags field followed by a *variable* list of fields.
Each set flag bit means "this field is present". Bit 0 is the exception: it is inverted,
and **0** means instantaneous speed *is* present. The decoder keeps an offset `o` and reads
the fields in the order the spec defines.

Worked example: a packet of `44 02 B4 0A B0 00 F7 00 86`

```
44 02    flags = 0x0244 → bits 2 (cadence), 6 (power), 9 (HR); bit 0 = 0 → speed present
B4 0A    speed   = 0x0AB4 = 2740 × 0.01  = 27.40 km/h
B0 00    cadence = 0x00B0 = 176  × 0.5   = 88 rpm
F7 00    power   = 0x00F7 = 247 W  (sint16)
86       HR      = 0x86   = 134 bpm
```

**Encoding commands** ([codec.ts:85-114](src/infrastructure/ftms/codec.ts#L85-L114)).
For example, `cmd.setSimulation(4.5, 0, 0.004, 0.51)` produces:

```
11       op 0x11 Set Indoor Bike Simulation
00 00    wind  0     (sint16, 0.001 m/s)
C2 01    grade 450   (sint16, 0.01 %)   → 4.50 %
28       crr   40    (uint8, 0.0001)    → 0.0040
33       cw    51    (uint8, 0.01 kg/m) → 0.51
```

`decodeControlResponse` parses the trainer's reply indication (`80 <reqOp> <result>`), and
`decodeFeatures` turns the two 32-bit feature bitfields into booleans. There is also
`encodeIndoorBikeData`, which exists only so the mock and the tests can produce real wire
bytes.

### The real trainer ([ble.ts](src/infrastructure/trainer/ble.ts))

**`BleScanner`** handles discovery.
- **Lazy noble** ([ble.ts:106-122](src/infrastructure/trainer/ble.ts#L106-L122)).
  `@abandonware/noble` is a native, *optional* dependency, loaded with a dynamic
  `import()` on first use. So `--mock`, the tests, and every non-BLE command work on
  machines where it never built. `ready()` also waits for the adapter to reach `poweredOn`.
- `scan()` collects every peripheral advertising service `0x1826` for N seconds. The scan
  is unfiltered, so it can also report Zwift Clicks it sees through an `onClick` callback.
- `find(filter)` resolves with the **first** match and stops scanning.
- `findClicks(filter, timeoutS, onFound)` discovers Zwift Clicks (next subsection).
- `norm()` ([ble-uuid.ts](src/infrastructure/ble-uuid.ts)) collapses 128-bit Bluetooth
  base UUIDs to the short form (`2ad2`), so characteristics can be compared regardless of
  how noble reports them. Both BLE adapters use it.

**`BleFtmsTrainer.connect()`** ([ble.ts:138-172](src/infrastructure/trainer/ble.ts#L138-L172))
runs the standard FTMS handshake:

1. Connect, and set up the `disconnect` handler.
2. Discover the FTMS service and its four characteristics.
3. Read **Feature (0x2ACC)** and log it.
4. Subscribe to **Indoor Bike Data (0x2AD2)**. Every notification is decoded and emitted as
   `data`.
5. Subscribe to **Machine Status (0x2ADA)**, if present. It is only logged.
6. Subscribe to **Control Point (0x2AD9)** indications. This is where command responses
   arrive.
7. Send `RequestControl` (it must come first), then `Start`.

**The command queue** ([ble.ts:187-202](src/infrastructure/trainer/ble.ts#L187-L202)) is
the most important piece of BLE code:

```ts
const run = () => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { this.pending = undefined; reject(/* timed out */); }, 2000);
  this.pending = { op: bytes[0], resolve, reject, timer };
  this.cp.writeAsync(Buffer.from(bytes), false)...;
});
const next = this.queue.then(run, run);   // chain after the previous command, success or failure
this.queue = next.catch(() => undefined); // a failed command never blocks the queue
return next;
```

Only **one write is in flight** at a time, and it is resolved by the matching indication.
`onControlResponse` ([ble.ts:204-213](src/infrastructure/trainer/ble.ts#L204-L213))
matches the reply's `requestOp` against `pending.op`. A reply that doesn't match is
ignored. Cheap trainers silently drop a write that arrives while the previous one is
pending, so the queue serialises them, and the 2 s timeout keeps one lost reply from
blocking everything after it. One tolerance is built in: a rejected `Start` still counts
as success, because many trainers reject it when they're already running.

`disconnect()` sends `Reset` (best effort) before dropping the link, so the trainer
doesn't stay locked at the last ERG target.

### The mock ([mock.ts](src/infrastructure/trainer/mock.ts))

`MockTrainer` is a fake trainer with a *virtual rider* attached. On each clock step
([mock.ts:48-71](src/infrastructure/trainer/mock.ts#L48-L71)):

- **Power target.** In ERG mode, the rider holds the target. In sim mode, they ride
  `basePower × (1 + 0.05 × grade%)`: 5 % harder per % of climb, easier on descents.
- **Rider response.** Power approaches the target with a lag, plus some noise.
- **Other outputs.** Speed comes from the same `RiderModel`, HR drifts towards
  `70 + 0.38·P`, and cadence follows a slow sine that drops on climbs.
- **Output path.** The result goes through `encodeIndoorBikeData` → `decodeIndoorBikeData`
  before being emitted, so every mock ride also exercises the real codec.

It registers itself with `clock.onStep`, not `clock.every`. The next section explains why.

### Handlebar remotes — Zwift Click

A **`Controller`** ([ports.ts:25-29](src/application/ports.ts#L25-L29)) is a second,
smaller port: an `EventEmitter` with `connect()` / `disconnect()` that emits `adjust`
(`1 | -1`), `connected`, `disconnect` and `log`. The session treats a button press exactly
like the `+`/`-` key, so ride modes know nothing about remotes.

- **Discovery** (`BleScanner.findClicks`). Clicks don't reliably advertise their service,
  so the scan is unfiltered and matches on manufacturer data (`parseZwiftAdvert`). It stops
  after 20 s, or once a Click v1 or both Click v2 pucks have been found.
- **The codec** ([zwift-codec.ts](src/infrastructure/controller/zwift-codec.ts)) is pure,
  like the FTMS codec: advert parsing, a minimal protobuf varint reader, button decoding for
  v1 (`0x37`) and v2 (`0x23`), and `ClickEdgeDetector`. The device repeats its button state,
  so only a released → pressed edge becomes an `adjust`.
- **`ZwiftClick.connect()`** ([zwift-click.ts](src/infrastructure/controller/zwift-click.ts))
  finds the Zwift service, subscribes to Async (buttons) and SyncTx (handshake reply),
  checks the firmware version, then writes the `RideOn` handshake, trying the known
  variants in turn. A locked Click v2 answers with `0xFF …`, which is logged as a warning.
- **`MockClick`** ([mock.ts](src/infrastructure/controller/mock.ts)) has a `press(dir)` for
  tests.
- **Debugging.** With `TRAINER_CLI_DEBUG=1`, `DebugLog`
  ([debug-log.ts](src/infrastructure/debug-log.ts)) appends the raw Click traffic to
  `~/.trainer-cli/debug.log`. The composition root creates it and hands it to `BleScanner`.

The protocol details are in [DESIGN.md](DESIGN.md#zwift-click-protocol-notes).

---

## 8. Time — `RealClock` and `SimClock`

[src/infrastructure/clock.ts](src/infrastructure/clock.ts) implements the `Clock` port
(`now()` and `every(periodS, fn)`).

- **`RealClock`** is `Date.now()` plus `setInterval`. There is nothing more to it.
- **`SimClock(speedup)`** keeps its own virtual time `t`, and advances it in **1 s steps**,
  `speedup` times per real second. Each step
  ([clock.ts:47-56](src/infrastructure/clock.ts#L47-L56)) works in two phases:
  1. It runs every **`onStep` hook** (the simulated devices, i.e. the mock produces its
     data).
  2. It runs every **`every` timer** that is due (the session's tick reads that data).

  Because of this ordering, the session always sees data from the *current* simulated
  second. That's what keeps a 60× (or, in tests, 2000×) ride deterministic. With two
  `setInterval`s racing each other, a fast-forwarded ride would randomly read stale data.
  Time only advances while at least one `every` timer is registered.

The `Session` uses `clock.now()` for everything: data freshness, timestamps and throttling.
So a 2-hour mock ride at `--speedup 60` takes 2 minutes and still produces a FIT file with
correct, 2-hour timestamps.

---

## 9. Recording → FIT → Strava

### `Recorder` ([activity.ts](src/domain/activity.ts#L31-L82))

This is the domain's model of a recording.
- It **starts paused**. `start(now)` and `pause(now)` push FIT-style timer events
  (`start` / `stopAll`), so the file shows where you paused.
- `add(sample, dt)` ignores samples while paused and adds `dt` to `timerS`. That gives two
  separate times: **timer time** (excludes pauses) and **elapsed time** (wall clock).
- **Laps** are index ranges into `samples`
  ([activity.ts:63-70](src/domain/activity.ts#L63-L70)). `lap(now, nextLabel)` closes the
  current lap and opens the next one. A lap with no samples isn't stored; only its label
  is updated. This is why a workout's very first step change doesn't produce an empty lap.
- `finish(now)` pauses, closes the last lap, and returns an immutable `FinishedActivity`.

### `RideFinisher` ([ride.ts](src/application/ride.ts))

This is the application-level "what happens after the ride".
- `save()` finishes the recorder, passes the activity to the `ActivityStore` port, and
  computes the summary shown in the terminal.
- `upload()` decides the Strava type: a `'virtual'` (route) ride is uploaded as a virtual
  ride, and everything else is flagged `trainer=1`.

### `FitEncoder` ([fit-encoder.ts](src/infrastructure/fit-encoder.ts))

This uses the Garmin FIT SDK `Encoder` to write messages in the order Strava and Garmin
Connect expect:

```
file_id → device_info → (event | record)* → lap* → session → activity
```

Details worth knowing:
- **Timer events are interleaved with records in time order**
  ([fit-encoder.ts:22-27](src/infrastructure/fit-encoder.ts#L22-L27)). Readers use them to
  compute moving time.
- **Positions** are converted from degrees to *semicircles* (`× 2³¹/180`).
- **Lap and session totals** come from `stats()`: average and max of power, HR, cadence
  and speed, ascent and descent, work, and calories. Calories are estimated from work at
  about 24 % efficiency. The last lap is tagged `sessionEnd`.
- **Sub-sport**: `virtualActivity` for routes (Strava shows a Virtual Ride on a map), and
  `indoorCycling` otherwise.

[activity-store.ts](src/infrastructure/activity-store.ts): `FitFileStore` encodes the
activity and writes it to `~/.trainer-cli/activities/YYYY-MM-DD-HH-MM-<slug>.fit`.

### `StravaClient` ([strava.ts](src/infrastructure/strava.ts))

- **`auth()`** ([strava.ts:38-68](src/infrastructure/strava.ts#L38-L68)) runs the OAuth
  authorization-code flow with a **loopback redirect**:
  1. It starts a one-shot HTTP server on `127.0.0.1:8723` and opens the consent URL in
     your browser.
  2. It catches the `/callback` request and checks both the random `state` value (for
     CSRF) and that the `activity:write` scope was granted.
  3. It exchanges the code for tokens.
  4. It saves the client ID, secret and tokens to `~/.trainer-cli/strava.json` with mode
     0600 (`StravaTokenFile`).
- **`accessToken()`** ([strava.ts:106-113](src/infrastructure/strava.ts#L106-L113))
  refreshes the token when it is within 120 s of expiry, and saves the new one.
- **`upload()`** ([strava.ts:79-103](src/infrastructure/strava.ts#L79-L103)) POSTs a
  multipart form to `/api/v3/uploads`. Strava processes uploads asynchronously, so it then
  polls `/uploads/{id}` every 2 s (at most 30 times) until it gets an `activity_id` or an
  `error`.

---

## 10. The TUI — `RideView.tsx`

[src/presentation/ui/RideView.tsx](src/presentation/ui/RideView.tsx) is written with
[Ink](https://github.com/vadimdemedes/ink), which is React for the terminal.

- **The UI is a function of the latest `Snapshot`.** A `useEffect`
  ([RideView.tsx:99-105](src/presentation/ui/RideView.tsx#L99-L105)) subscribes to the
  session's `snapshot` event and stores it in state. The UI keeps no other ride state of
  its own; anything new you want to display must first be added to `Snapshot` (generic)
  or `ModeSnapshot` (mode-specific).
- **Keys map directly to Session methods**
  ([RideView.tsx:107-117](src/presentation/ui/RideView.tsx#L107-L117)):
  - `space`/`p` → `togglePause()`
  - `+`/`=`/`↑` → `adjust(1)`
  - `-`/`_`/`↓` → `adjust(-1)`
  - `l` → `manualLap()`
  - `q`/`Esc`/`Ctrl-C` → `stop()`, but only on a **second press within 2.5 s**, so you
    can't end a ride by accident.
- **Layout.** A header, a row of `Metric` boxes, then a mode-specific strip: `Elevation`
  (an 8-level block-character sparkline with a `▲` "you are here" marker) for routes, and
  `WorkoutStrip` (one character per column, coloured by step kind, with the current step
  highlighted) for workouts. Last come the status line, the last two log lines and the
  key hints.
- **Power colour.** Power is coloured against the target: yellow below 92 %, red above
  108 %, green in between.

The headless alternative is `RideRunner.logSnapshots`
([ride-runner.ts:106-117](src/presentation/ride-runner.ts#L106-L117)). It listens to the same
`snapshot` event and prints one line per 10 s bucket.

---

## 11. Config & files on disk

- [src/domain/config.ts](src/domain/config.ts) defines the `Config` type and `DEFAULTS`
  (FTP 200, rider 75 kg, bike 9 kg, CdA 0.32, Crr 0.004, grade −10…+15 %, difficulty 1).
- [src/infrastructure/config-file.ts](src/infrastructure/config-file.ts) handles loading
  and saving.
  - `load()` merges `config.yaml` over the defaults. A missing file just means the
    defaults.
  - `save()` writes **only the values that differ from the defaults**, so the file stays
    short.
  - It is also the single owner of the app's paths: setting the `TRAINER_CLI_HOME`
    environment variable relocates everything (handy for testing).

```
~/.trainer-cli/
├── config.yaml          # non-default settings (0600)
├── strava.json          # API app credentials + OAuth tokens (0600)
├── debug.log            # raw Zwift Click traffic, only with TRAINER_CLI_DEBUG=1
└── activities/
    └── 2026-10-20-07-30-synthetic-climb-loop.fit
```

---

## 12. Tests as documentation

`npm test` runs [vitest](https://vitest.dev). Each test file pins down one layer:

| File | What it proves |
|------|----------------|
| [test/core.test.ts](test/core.test.ts) | FTMS and Zwift Click codecs byte-exact, physics plausibility, GPX/route grade, workout parsing (YAML repeats/ramps, ZWO), and a **full accelerated mock workout** that writes a FIT file, decodes it with the FIT SDK and checks laps/records/sub-sport |
| [test/modes.test.ts](test/modes.test.ts) | each `RideMode` against a fake `RideContext`: grade clamp × difficulty, moves only while recording, ERG offset, laps on step change, paused-ERG cap, free-mode limits |
| [test/application.test.ts](test/application.test.ts) | `TrainerCommander` throttling, `AutoPause`, `PowerStats`, loader extension dispatch, `Session` timing (first target at start, time frozen at stop), `SimClock` ordering, Click presses acting as `+`/`-` and Click disconnects |
| [test/architecture.test.ts](test/architecture.test.ts) | the onion rule: scans every import under `src/`; domain may use no packages, application only `node:events` |

To see a whole ride without hardware:

```bash
npx tsx src/presentation/cli.ts ride examples/climb-loop.gpx --mock --speedup 60 --no-tui --no-upload
npx tsx src/presentation/cli.ts workout examples/threshold-4x8.yaml --mock --speedup 60   # with the TUI
```

---

## 13. Trace it yourself

Good exercises for checking your understanding. Each one touches several layers.

1. **"I press `+` during a route ride."**
   `RideView.useInput` → `Session.adjust(1)` → `RouteMode.adjust` (difficulty +0.1, returns
   a log line) → `TrainerCommander.invalidate()` → `emitSnapshot` (the UI shows the new %)
   → next tick: `RouteMode.control` → `ctx.sendGrade(clamp(g) × difficulty)` →
   `TrainerCommander.sendGrade` (not throttled, because of `invalidate`) →
   `BleFtmsTrainer.setSimulation` → `cmd.setSimulation` bytes → queued Control Point write
   → the trainer's `80 11 01` indication resolves it.
2. **"I stop pedalling for 5 seconds in a workout."**
   Ticks 1–3 with power and cadence below 5 → `AutoPause` becomes active →
   `Session.applyPause` → `Recorder.pause` (a `stopAll` event is stored) →
   `ctx.recording` is false → `WorkoutMode.control` sends `min(100, target)`,
   `Workout.targetAt` stops advancing (timer time is frozen), and `PowerStats` stops
   averaging. The first pedal stroke → auto-resume → `Recorder.start` (a `start` event).
3. **"Where does the 'Virtual Ride' on Strava come from?"**
   `RouteMode.recordingKind = 'virtual'` → `Recorder.kind` → `FinishedActivity.kind` →
   `FitEncoder` sets `subSport = virtualActivity`, and `RideFinisher.upload` passes
   `indoor: false`.

For *adding* things (a new mode, file format, device or upload target), see the "Adding
things usually means one new file in one layer" table in [DESIGN.md](DESIGN.md#architecture).
