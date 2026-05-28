// src/utils/arrayUtils.ts

/**
 * Returns an array with duplicate values removed.
 * @template T - The type of array elements
 * @param {T[]} array - The input array
 * @returns {T[]} A new array with unique values
 */
export function uniqueArray<T>(array: T[]): T[] {
  return Array.from(new Set(array));
}

/**
 * Returns a new array with elements shuffled in random order.
 * Uses the Fisher-Yates shuffle algorithm.
 * @template T - The type of array elements
 * @param {T[]} array - The input array
 * @returns {T[]} A new array with shuffled elements
 */
export function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const randomIndex = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[i]];
  }
  return shuffled;
}
