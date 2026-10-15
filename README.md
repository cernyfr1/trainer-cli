# trainer-cli

Control a Bluetooth FTMS smart trainer from the terminal — ride GPX/FIT courses in
simulation mode, run structured ERG workouts, record FIT files and push them to Strava.

Built and tuned for the **Decathlon D100**, works with any trainer that exposes the
standard Fitness Machine Service (Wahoo, Tacx, Elite, Zwift Hub, …).

```
 trainer-cli · ROUTE Synthetic climb loop                     ⏱ 4:52   ● D100 31257
 ───────────────────────────────────────────────────────────────────────────────────
 POWER            CADENCE          SPEED            GRADE            HR
 166 W            80 rpm           25.8 km/h        +1.7 %           134 bpm
 avg 161 W                         2.47 / 12.92 km  ↑ 12 m · 716 m
 ───────────────────────────────────────────────────────────────────────────────────
   908 m ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▂▂▂▃▃▄▄▄▄▄▅▆▆▆▆▇▇██████████████▇▇▇▇▆▆▆▆▅▅▅▅▄▄▄▃▃▃▂▂▂▁▁▁
   712 m                  ▲
 ───────────────────────────────────────────────────────────────────────────────────
 ● recording  difficulty 100%                                                 lap 1
 [space] pause  [+/-] difficulty  [l] lap  [q] finish
```

## Install

Requires Node ≥ 22. On macOS you need Xcode Command Line Tools for the BLE module.

```bash
npm install          # builds @abandonware/noble (optional; --mock works without it)
npm run build && npm link    # puts `trainer` on your PATH
# or run from source:  npx tsx src/cli.ts …
```

**macOS:** the first scan triggers a Bluetooth permission prompt for your terminal app
(iTerm/Terminal/VS Code). If it never appears: System Settings → Privacy & Security →
Bluetooth → enable it for the terminal.

## Quick start

```bash
trainer config ftp=250 riderMassKg=75 trainerName=D100
trainer scan                                   # pedal to wake the trainer
trainer free --erg 150                         # smoke test: hold 150 W
trainer ride examples/climb-loop.gpx           # route simulation
trainer workout examples/threshold-4x8.yaml    # ERG workout (YAML)
trainer workout examples/vo2-30-30.zwo         # Zwift workouts work too
```

No trainer handy? Add `--mock` (and `--speedup 60` to fast-forward):

```bash
trainer ride examples/climb-loop.gpx --mock --speedup 60
```

### Keys during a ride

| Key | Action |
|-----|--------|
| `space` / `p` | pause / resume (also auto-pauses when you stop pedalling) |
| `+` / `-` | route: difficulty ±10 % · workout: ERG offset ±5 W · free: power/grade |
| `l` | manual lap |
| `q` `q` | finish & save |
| Zwift Click `+` / `−` | same as `+` / `-` (see below) |

## Zwift Click

A Zwift Click (v1, or the v2 pair) works as a handlebar remote for the `+`/`-` keys. It
is picked up automatically: after the trainer connects, trainer-cli scans for ~20 s in
the background and connects any Click it finds. The header shows `● Click`, or `○ Click`
if it drops. Rides never wait for or depend on it.

- Several Clicks nearby? `trainer config clickName=<part of its name>`.
- Don't want it? `--no-click`. (`--mock` rides never scan.)
- `trainer scan` lists Clicks alongside trainers.
- **Firmware:** the Click needs firmware 1.1.0+ (update it in Zwift Companion). On 1.0.0
  it connects but never sends button presses; the TUI warns about this.
- Not working? Run with `TRAINER_CLI_DEBUG=1` and check `~/.trainer-cli/debug.log` for
  the raw Click traffic.
- **Click v2:** Zwift locks the left puck (with `−`) unless it was unlocked by riding in
  Zwift within the last ~24 h. When it's locked you'll see a warning; use **Z** on the
  right puck as `−` instead.
- A Click that drops mid-ride isn't reconnected; the keyboard keeps working.
- Zwift Play / Ride controllers aren't supported.

## Strava

1. Create an API app at <https://www.strava.com/settings/api>.
   Authorization Callback Domain: `127.0.0.1`.
2. `trainer strava auth --client-id 12345 --client-secret abc…` — a browser tab opens,
   approve "Upload your activities".
3. After each ride you're asked `Upload to Strava? [Y/n]` (or pass `--upload` / `--no-upload`).

Rides are always saved first to `~/.trainer-cli/activities/*.fit`, so a failed upload
can be retried: `trainer strava upload <file.fit>`. Route rides appear as *Virtual Ride*
(with the map), workouts as indoor rides.

## Workout format

```yaml
name: 4x8 threshold
steps:
  - warmup:   { duration: 10m, from: 50%, to: 75% }
  - repeat: 4
    steps:
      - work:     { duration: 8m, power: 100% }
      - recovery: { duration: 4m, power: 55% }
  - free:     { duration: 3m }                 # sim mode, 0 % grade
  - cooldown: { duration: 8m, from: 65%, to: 45% }
```

Durations: `90s`, `5m`, `1h30m`, `1:30`. Power: `75%` (of FTP) or `200W`.
Step kinds: `warmup`, `work`, `recovery`, `steady`, `cooldown`, `free`.

## D100 notes

- It's a wheel-on trainer with limited peak resistance: steep grades and high ERG targets
  at low cadence will saturate. Use `--difficulty 70` or `+/-` in the TUI, and keep
  `maxGrade` in config modest (default 15 %).
- Calibrate tyre pressure / roll-down in the Decathlon app; FTMS doesn't expose it here.
- Only one app can hold the BLE connection — close Decathlon/Zwift apps before riding.

## Development

```bash
npm test          # codec, physics, parsers, accelerated mock session → FIT
npm run typecheck
```

See [DESIGN.md](DESIGN.md) for architecture, protocol notes and roadmap.
