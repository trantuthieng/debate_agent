// src/utils/dateUtils.ts

/**
 * Formats a date object into a YYYY-MM-DD string format.
 * @param date - The date to format
 * @returns Formatted date string in YYYY-MM-DD format
 * @throws Will throw an error if date is invalid
 */
export function formatDate(date: Date): string {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    throw new Error('Invalid date provided');
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Checks if a given date is in the future compared to the current date.
 * @param date - The date to check
 * @returns true if the date is in the future, false otherwise
 * @throws Will throw an error if date is invalid
 */
export function isFutureDate(date: Date): boolean {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    throw new Error('Invalid date provided');
  }

  return date > new Date();
}
