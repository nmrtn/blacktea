/**
 * Display helpers for text that came from an agent and is shown to a human.
 */

// C0 (0x00-0x1f), DEL (0x7f) and C1 (0x80-0x9f) control characters.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Replace every control character (newlines, carriage returns, tabs, escape)
 * with a single space, so agent-supplied text cannot forge extra lines or
 * terminal sequences in an approval prompt.
 */
export function sanitizeForDisplay(text: string): string {
  return text.replace(CONTROL_CHARS, " ");
}
