/** What the summarizer is told after a judge yes. */
export const JUDGE_INSTRUCTIONS = 'Keep the current goal, the next step and open decisions.';

/** What the summarizer is told after a tag. The tag's text says what the next step needs. */
export function instructionsForRequest(next: string): string {
  return `Keep the current goal, open decisions and what this next step needs: ${next}`;
}
