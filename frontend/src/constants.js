// Event codes are produced by pipeline/build.py (EVENT_CODES) — keep in sync.
export const EV = { Position: 0, BotPosition: 1, Kill: 2, Killed: 3, BotKill: 4, BotKilled: 5, KilledByStorm: 6, Loot: 7 };
export const MOVEMENT = new Set([EV.Position, EV.BotPosition]);
export const DEATHS = new Set([EV.Killed, EV.BotKilled, EV.KilledByStorm]);

/** Marker category for each discrete event code. */
export const CATEGORY_OF = {
  [EV.Kill]: 'kill', [EV.BotKill]: 'kill',
  [EV.Killed]: 'death', [EV.BotKilled]: 'death',
  [EV.KilledByStorm]: 'storm',
  [EV.Loot]: 'loot',
};

export const COLORS = {
  human: '#4cc9ff', bot: '#ff8a3d',
  kill: '#ff3d6e', death: '#ffffff', storm: '#a06bff', loot: '#3ef0a5',
};

export const CATEGORIES = [
  { key: 'kill', label: 'Kills' },
  { key: 'death', label: 'Deaths' },
  { key: 'storm', label: 'Storm deaths' },
  { key: 'loot', label: 'Loot' },
];

/** Heatmap layers: which event codes feed each one. */
export const HEAT_LAYERS = [
  { key: 'off', label: 'Off', codes: [] },
  { key: 'traffic', label: 'Traffic', codes: [EV.Position, EV.BotPosition] },
  { key: 'kill', label: 'Kills', codes: [EV.Kill, EV.BotKill] },
  { key: 'death', label: 'Deaths', codes: [EV.Killed, EV.BotKilled, EV.KilledByStorm] },
  { key: 'storm', label: 'Storm', codes: [EV.KilledByStorm] },
  { key: 'loot', label: 'Loot', codes: [EV.Loot] },
  { key: 'flow', label: 'Flow ➜', codes: [] }, // not a heat layer: animated zone-to-zone arrows (see /flow)
];

/**
 * Human-readable description of an event, from the perspective of the file owner.
 * Every event row belongs to the player/bot whose file it came from.
 */
export function describeEvent(code, isBot) {
  if (isBot) {
    return {
      [EV.BotKill]: 'Bot got a kill', [EV.BotKilled]: 'Bot was killed', [EV.Kill]: 'Bot got a kill',
      [EV.Killed]: 'Bot was killed', [EV.KilledByStorm]: 'Bot died to storm', [EV.Loot]: 'Bot looted',
    }[code] ?? 'Event';
  }
  return {
    [EV.Kill]: 'Killed a player', [EV.Killed]: 'Killed by a player', [EV.BotKill]: 'Killed a bot',
    [EV.BotKilled]: 'Killed by a bot', [EV.KilledByStorm]: 'Died to the storm', [EV.Loot]: 'Picked up loot',
  }[code] ?? 'Event';
}

/** Gap (seconds) between position samples beyond which we don't draw/interpolate a line. */
export const PATH_GAP_S = 30;

export function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtDay(day) {
  // "February_10" -> "Feb 10"
  const [m, d] = day.split('_');
  return `${m.slice(0, 3)} ${d}`;
}

export const shortId = (id) => (/^\d+$/.test(id) ? `bot ${id}` : id.slice(0, 8));

// ---------------------------------------------------------------- dashboard helpers
export const prettyMap = (m) => m.replace(/([a-z])([A-Z])/g, '$1 $2');
/** Players filter ('humans' | 'bots' | 'both') -> API flags. */
export const playersFlags = (mode) => ({ humans: mode !== 'bots', bots: mode !== 'humans' });
export const cellId = (col, row) => `${'ABCDEFGH'[col]}${row + 1}`;

/** Zone tags assigned by the backend (backend/app/store.py `_tag`). Labels are playful; `blurb` is the plain-English rule. */
export const TAGS = {
  kill: { label: 'Meat grinder', emoji: '☠️', color: '#ff3d6e', blurb: 'Deaths here outpace foot traffic: players are funnelled into fights.' },
  farm: { label: 'Loot buffet', emoji: '🤑', color: '#3ef0a5', blurb: 'Loot-rich and rarely lethal: a low-risk place to stock up.' },
  storm: { label: 'Storm magnet', emoji: '🌩️', color: '#a06bff', blurb: 'A disproportionate share of storm deaths happen here.' },
  quiet: { label: 'Tumbleweed', emoji: '🌵', color: '#8f8fd6', blurb: 'Under 1% of movement: barely used.' },
  neutral: { label: 'Fair fight', emoji: '🥊', color: '#4cc9ff', blurb: 'Risk and reward roughly match the traffic.' },
  info: { label: 'Fun fact', emoji: '💡', color: '#ffe814', blurb: 'A map-wide observation.' },
  none: { label: 'No traffic', emoji: '·', color: '#3a3478', blurb: 'No recorded movement here.' },
};
/** Compare view: side A / side B colours (distinct from the human-cyan / bot-orange semantic colours). */
export const SIDE_COLORS = { A: '#ffe814', B: '#ff3df0' };
