// src/utils/stringUtils.ts

/**
 * Capitalizes the first letter of a string.
 * @param input - The string to capitalize
 * @returns The capitalized string, or empty string if input is falsy
 */
export function capitalize(input: string): string {
  if (!input) return '';
  return input.charAt(0).toUpperCase() + input.slice(1);
}

/**
 * Converts a string to camelCase.
 * Handles multiple spaces and trims leading/trailing spaces.
 * @param input - The string to convert
 * @returns The camelCase string
 * @example
 * toCamelCase('hello world') // returns 'helloWorld'
 * toCamelCase('Hello   World') // returns 'helloWorld'
 */
export function toCamelCase(input: string): string {
  if (!input) return '';
  
  // Trim leading and trailing spaces
  let result = input.trim();
  
  // Convert to lowercase first
  result = result.toLowerCase();
  
  // Replace spaces with uppercase next letter
  result = result.replace(/\s+([a-z])/g, (match, letter) => letter.toUpperCase());
  
  return result;
}
