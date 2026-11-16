/** Smallest and largest of a list of numbers. Unlike Math.min(...list) these cope with any length (spreading more than about 100,000 values overflows the call stack). */
export function minOf(a: ArrayLike<number>): number { let m = Infinity; for (let i = 0; i < a.length; i++) if (a[i] < m) m = a[i]; return m; }
export function maxOf(a: ArrayLike<number>): number { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; }
