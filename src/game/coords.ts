/** Chess-style square names: files a,b,...,z,aa,... left→right; ranks from the bottom. */
export function fileLabel(x: number): string {
  let n = x + 1
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(97 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

export function rankLabel(y: number, height: number): string {
  return String(height - y)
}

export function coordName(x: number, y: number, height: number): string {
  return `${fileLabel(x)}${rankLabel(y, height)}`
}
