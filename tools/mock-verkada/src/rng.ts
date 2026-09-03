/**
 * Deterministic PRNG. Same --seed, same run, every time: a failure the
 * generator produced can be reproduced exactly while it is being fixed.
 */

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  bool(probability: number): boolean;
  /** Fisher-Yates, non-mutating. */
  shuffle<T>(items: readonly T[]): T[];
}

/** cyrb128: string seed -> four 32-bit words. */
function hashSeed(seed: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;

  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }

  return [
    (h1 ^ h2 ^ h3 ^ h4) >>> 0,
    (h2 ^ h1) >>> 0,
    (h3 ^ h1) >>> 0,
    (h4 ^ h1) >>> 0,
  ];
}

export function createRng(seed: string): Rng {
  let [a, b, c, d] = hashSeed(seed);

  // sfc32
  const next = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };

  // Discard the first few outputs so short seeds don't correlate.
  for (let i = 0; i < 12; i++) next();

  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error('pick() on an empty list');
      // Index is in range by construction; the assertion satisfies
      // noUncheckedIndexedAccess without widening the type.
      return items[Math.floor(next() * items.length)] as T;
    },
    bool: (probability) => next() < probability,
    shuffle: <T>(items: readonly T[]): T[] => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const a2 = copy[i] as T;
        const b2 = copy[j] as T;
        copy[i] = b2;
        copy[j] = a2;
      }
      return copy;
    },
  };

  return rng;
}
