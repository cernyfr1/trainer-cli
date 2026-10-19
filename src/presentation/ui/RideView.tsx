import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { Session, Snapshot } from '../../application/session.js';

const BARS = '▁▂▃▄▅▆▇█';

export const fmtTime = (s: number) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
};
const km = (m: number) => (m / 1000).toFixed(2);
const sign = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;

function powerColor(w: number, target?: number | null): string {
  if (target == null) return 'white';
  const r = w / Math.max(1, target);
  return r < 0.92 ? 'yellow' : r > 1.08 ? 'red' : 'green';
}

function gradeColor(g: number): string {
  return g > 8 ? 'red' : g > 4 ? 'yellow' : g > 0.5 ? 'green' : g < -2 ? 'cyan' : 'white';
}

function Metric({ label, value, unit, sub, color = 'white' }: { label: string; value: string; unit: string; sub?: string; color?: string }) {
  return (
    <Box flexDirection="column" width={16} marginRight={1}>
      <Text dimColor>{label}</Text>
      <Text bold color={color}>{value}<Text dimColor> {unit}</Text></Text>
      <Text dimColor>{sub ?? ' '}</Text>
    </Box>
  );
}

export function Elevation({ profile, pos, width }: { profile: number[]; pos: number; width: number }) {
  const lo = Math.min(...profile), hi = Math.max(...profile);
  const span = Math.max(1, hi - lo);
  const cols = profile.length;
  const at = Math.min(cols - 1, Math.round(pos * (cols - 1)));
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>{String(Math.round(hi)).padStart(5)} m </Text>
        {profile.map((e, i) => {
          const ch = BARS[Math.min(7, Math.floor(((e - lo) / span) * 7.999))];
          return <Text key={i} color={i < at ? 'green' : i === at ? 'magentaBright' : 'gray'}>{ch}</Text>;
        })}
      </Text>
      <Text>
        <Text dimColor>{String(Math.round(lo)).padStart(5)} m </Text>
        {' '.repeat(at)}<Text color="magentaBright">▲</Text>
      </Text>
    </Box>
  );
}

function WorkoutStrip({ s, width }: { s: Snapshot; width: number }) {
  const w = s.workout!;
  const total = w.totalS;
  const cols = Math.max(20, width);
  const at = Math.min(cols - 1, Math.floor((w.elapsedS / total) * cols));
  // column → step index
  const colStep: number[] = [];
  let acc = 0, si = 0;
  for (let c = 0; c < cols; c++) {
    const t = (c + 0.5) * total / cols;
    while (si < w.steps.length - 1 && t > acc + w.steps[si].durationS) { acc += w.steps[si].durationS; si++; }
    colStep.push(si);
  }
  const kindChar: Record<string, string> = { warmup: '▃', cooldown: '▃', recovery: '▂', work: '▇', steady: '▅', free: '░' };
  const tg = w.target;
  const next = w.steps[tg.index + 1];
  return (
    <Box flexDirection="column">
      <Text>
        {colStep.map((st, c) => (
          <Text key={c} color={st === tg.index ? 'magentaBright' : c < at ? 'green' : 'gray'}>{kindChar[w.steps[st].kind] ?? '▄'}</Text>
        ))}
      </Text>
      <Text>{' '.repeat(at)}<Text color="magentaBright">▲</Text></Text>
      <Text>
        <Text bold>step {tg.index + 1}/{w.steps.length}</Text> {tg.step.label}
        <Text dimColor>  ·  </Text>{fmtTime(tg.stepRemainingS)} left
        {next ? <Text dimColor>  ·  next: {next.label} ({fmtTime(next.durationS)})</Text> : <Text dimColor>  ·  last step</Text>}
        <Text dimColor>  ·  total {fmtTime(total - w.elapsedS)} left</Text>
      </Text>
    </Box>
  );
}

export function RideView({ session, onExit }: { session: Session; onExit: () => void }) {
  const [s, setS] = useState<Snapshot>();
  const [confirmQuit, setConfirmQuit] = useState(false);
  const quitTimer = useRef<NodeJS.Timeout>(undefined);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const width = Math.max(60, Math.min(120, ((stdout as NodeJS.WriteStream).columns ?? 80) - 2));

  useEffect(() => {
    const on = (snap: Snapshot) => setS(snap);
    const fin = () => setTimeout(() => { exit(); onExit(); }, 300);
    session.on('snapshot', on);
    session.once('finished', fin);
    return () => { session.off('snapshot', on); session.off('finished', fin); };
  }, [session]);

  useInput((input, key) => {
    if (input === ' ' || input === 'p') session.togglePause();
    else if (input === '+' || input === '=' || key.upArrow) session.adjust(1);
    else if (input === '-' || input === '_' || key.downArrow) session.adjust(-1);
    else if (input === 'l') session.manualLap();
    else if (input === 'q' || key.escape || (key.ctrl && input === 'c')) {
      if (confirmQuit) { clearTimeout(quitTimer.current); session.stop(); return; }
      setConfirmQuit(true);
      quitTimer.current = setTimeout(() => setConfirmQuit(false), 2500);
    }
  });

  if (!s) return <Text dimColor>connecting…</Text>;

  const state = s.finished ? <Text color="cyan">■ finished</Text>
    : s.paused ? <Text color="yellow">❚❚ paused</Text>
    : s.autoPaused ? <Text color="yellow">❚❚ auto-paused — start pedalling</Text>
    : <Text color="green">● recording</Text>;

  const adjustHint = s.mode === 'route' ? `difficulty ${Math.round((s.difficulty ?? 1) * 100)}%`
    : s.mode === 'workout' ? `ERG offset ${(s.ergOffsetW ?? 0) >= 0 ? '+' : ''}${s.ergOffsetW ?? 0} W`
    : s.targetW != null ? `ERG ${s.targetW} W` : `grade ${sign(s.sentGradePct ?? 0)} %`;

  const line = '─'.repeat(width);

  return (
    <Box flexDirection="column" width={width + 2} paddingX={1}>
      <Box justifyContent="space-between">
        <Text><Text bold color="magentaBright">trainer-cli</Text><Text dimColor> · </Text><Text bold>{s.mode.toUpperCase()}</Text> {s.title}</Text>
        <Text>⏱ {fmtTime(s.elapsedS)}   {s.connected ? <Text color="green">● {s.trainerName}</Text> : <Text color="red">✖ {s.trainerName} disconnected</Text>}</Text>
      </Box>
      <Text dimColor>{line}</Text>
      <Box>
        <Metric label="POWER" value={String(s.power3sW)} unit="W" color={powerColor(s.power3sW, s.targetW)}
          sub={s.targetW != null ? `target ${s.targetW} W` : `avg ${s.avgPowerW} W`} />
        <Metric label="CADENCE" value={String(s.cadenceRpm)} unit="rpm" />
        <Metric label="SPEED" value={s.speedKmh.toFixed(1)} unit="km/h"
          sub={`${km(s.distanceM)}${s.routeTotalM ? ` / ${km(s.routeTotalM)}` : ''} km`} />
        {s.mode === 'route'
          ? <Metric label="GRADE" value={sign(s.gradePct ?? 0)} unit="%" color={gradeColor(s.gradePct ?? 0)}
              sub={`↑ ${Math.round(s.ascentM ?? 0)} m · ${Math.round(s.altitudeM ?? 0)} m`} />
          : <Metric label="AVG POWER" value={String(s.avgPowerW)} unit="W" sub={`lap ${s.lap}`} />}
        <Metric label="HR" value={s.heartRateBpm ? String(Math.round(s.heartRateBpm)) : '–'} unit="bpm" />
      </Box>
      <Text dimColor>{line}</Text>
      {s.mode === 'route' && s.profile && (
        <Elevation profile={s.profile} pos={s.routeTotalM ? s.distanceM / s.routeTotalM : 0} width={width} />
      )}
      {s.mode === 'workout' && s.workout && <WorkoutStrip s={s} width={width - 2} />}
      {s.mode === 'free' && <Text>Free ride · {adjustHint}</Text>}
      <Text dimColor>{line}</Text>
      <Box justifyContent="space-between">
        <Text>{state}  <Text dimColor>{adjustHint}</Text></Text>
        <Text dimColor>lap {s.lap}</Text>
      </Box>
      {s.log.slice(-2).map((l, i) => <Text key={i} dimColor>{l}</Text>)}
      <Text color={confirmQuit ? 'yellow' : undefined} dimColor={!confirmQuit}>
        {s.finished ? 'saving…' : confirmQuit ? 'press q again to finish & save' : '[space] pause  [+/-] ' + (s.mode === 'route' ? 'difficulty' : s.mode === 'workout' ? 'ERG ±5W' : 'adjust') + '  [l] lap  [q] finish'}
      </Text>
    </Box>
  );
}
