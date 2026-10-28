// Server clock alignment: every payload carries serverNow; devices render the timer
// against server time so all screens show the same second.
let offset = 0;
let samples: number[] = [];

export function syncClock(serverNow: number) {
  samples = [...samples.slice(-4), serverNow - Date.now()];
  // Network delay only ever makes a sample too small, so the largest recent one is the best estimate.
  offset = Math.max(...samples);
}

export const now = () => Date.now() + offset;
