export type Verdict = {
  compact: boolean;
  reason: string;
};

/** Parses the model reply and checks its shape. Throws when the reply is not a verdict. */
export function verdictFrom(reply: string): Verdict {
  const verdict = JSON.parse(jsonPartOf(reply));

  if (typeof verdict?.compact !== 'boolean') {
    throw new Error('reply has no boolean compact field');
  }

  return { compact: verdict.compact, reason: String(verdict.reason ?? '').slice(0, 200) };
}

// A Claude model may wrap the JSON in a code fence, so only the outer braces are read.
function jsonPartOf(reply: string): string {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');

  return start >= 0 && end > start ? reply.slice(start, end + 1) : reply;
}
