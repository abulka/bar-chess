import type { Vec2 } from './types'

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt(dist2(ax, ay, bx, by))
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function vecEquals(a: Vec2, b: Vec2): boolean {
  return a.x === b.x && a.y === b.y
}

export function tileKey(x: number, y: number, cols: number): number {
  return y * cols + x
}
