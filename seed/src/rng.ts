/**
 * VERITY — deterministic pseudo-random numbers.
 *
 * The seed data MUST be byte-identical on every generation. A demo that
 * produces different numbers each time cannot be rehearsed, screenshots stop
 * matching the live system, and the figures on the poster drift away from the
 * figures on the screen.
 *
 * `Math.random()` is therefore banned in seed/. Everything draws from here.
 */

/** mulberry32 — small, fast, and good enough for synthetic test data. */
export class Rng {
  private state: number;

  constructor(seed: number | string) {
    this.state = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** Uniform integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Uniform float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('cannot pick from an empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /**
   * Draw from a weighted distribution.
   * @param weights e.g. { 0: 0.70, 1: 0.20, 2: 0.07 } — need not sum to 1.
   */
  weighted<K extends string | number>(weights: Record<K, number>): K {
    const entries = Object.entries(weights) as Array<[K, number]>;
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let roll = this.next() * total;
    for (const [key, weight] of entries) {
      roll -= weight;
      if (roll <= 0) return key;
    }
    return entries[entries.length - 1]![0];
  }

  /** Fisher-Yates, in place, deterministic. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  }
}

function hashString(s: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return h >>> 0;
}
