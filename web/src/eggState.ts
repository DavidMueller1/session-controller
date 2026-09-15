// Shared state between the easter eggs so they can interact — right now the helicopter's
// rotor downwash pushes the clouds. Plain module singleton (read/written from rAF loops, so
// no reactivity needed): the helicopter writes its position + downwash each frame, and the
// clouds read it as an extra repulsor when `active`.
export const heli = {
  active: false,
  x: -9999,
  y: -9999,
  r: 200, // downwash radius (px)
  force: 5200, // downwash push strength
};
