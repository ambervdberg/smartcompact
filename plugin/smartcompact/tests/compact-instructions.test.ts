import { describe, expect, test } from 'claude-code/testing';
import { JUDGE_INSTRUCTIONS, instructionsForRequest } from '../hooks/compact-instructions.ts';

describe('the compact instructions', () => {
  test('after a judge yes keep the goal, the next step and open decisions', () => {
    expect(JUDGE_INSTRUCTIONS).toBe('Keep the current goal, the next step and open decisions.');
  });

  test('after a tag name what the next step needs', () => {
    expect(instructionsForRequest('Write the docs.')).toBe(
      'Keep the current goal, open decisions and what this next step needs: Write the docs.',
    );
  });
});
