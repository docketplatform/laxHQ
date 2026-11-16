// Choice lists shared by the app's forms. Keep in step with functions/lib/player.js.

export const SPORTS = [
  { value: 'mlax', label: 'Boys / men’s lacrosse' },
  { value: 'wlax', label: 'Girls / women’s lacrosse' },
];

export const POSITIONS = {
  mlax: [
    { value: 'attack', label: 'Attack' }, { value: 'midfield', label: 'Midfield' },
    { value: 'defense', label: 'Defense' }, { value: 'lsm', label: 'Long-stick midfield' },
    { value: 'fogo', label: 'Face-off' }, { value: 'goalie', label: 'Goalie' },
  ],
  wlax: [
    { value: 'attack', label: 'Attack' }, { value: 'midfield', label: 'Midfield' },
    { value: 'defense', label: 'Defense' }, { value: 'draw', label: 'Draw specialist' },
    { value: 'goalie', label: 'Goalie' },
  ],
};

export const DIVISIONS = ['D1', 'D2', 'D3'];

export const CLUB_LEVELS = [
  { value: 'national', label: 'National' }, { value: 'regional', label: 'Regional' }, { value: 'local', label: 'Local' },
];

export const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');

/** Stats that matter for each position, shown on the profile and the recruiting card. */
export const STATS_BY_POSITION = {
  attack: ['goals', 'assists', 'groundBalls'],
  midfield: ['goals', 'assists', 'groundBalls', 'causedTO'],
  defense: ['groundBalls', 'causedTO'],
  lsm: ['groundBalls', 'causedTO', 'goals'],
  fogo: ['faceoffPct', 'groundBalls'],
  goalie: ['saves', 'savePct'],
  draw: ['drawControls', 'goals', 'assists'],
};

export const STAT_LABELS = {
  goals: 'Goals', assists: 'Assists', groundBalls: 'Ground balls', causedTO: 'Caused turnovers',
  saves: 'Saves', savePct: 'Save %', faceoffPct: 'Face-off %', drawControls: 'Draw controls',
};

export function positionLabel(sport, value) {
  return (POSITIONS[sport] || POSITIONS.mlax).find((p) => p.value === value)?.label || value || '';
}
