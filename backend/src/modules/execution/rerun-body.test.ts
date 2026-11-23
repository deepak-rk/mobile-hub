import { describe, it, expect } from 'vitest';
import { ValidationError } from '../../common/errors/app-error';
import { parseBody, rerunBody } from './execution.routes';

describe('rerun request body', () => {
  it('keeps the comment (a reference farm typed the body without it and lost every one)', () => {
    expect(rerunBody.parse({ failedOnly: true, comment: '  flaky network  ' })).toEqual({
      failedOnly: true,
      comment: 'flaky network',
    });
  });

  it('accepts an empty body and rejects an oversized or blank comment', () => {
    expect(rerunBody.parse({})).toEqual({});
    expect(() => rerunBody.parse({ comment: 'x'.repeat(501) })).toThrow();
    expect(() => rerunBody.parse({ comment: '   ' })).toThrow();
  });

  it('turns a body that fails the schema into a 400, not a 500', () => {
    expect(() => parseBody(rerunBody, { failedOnly: 'yes' })).toThrow(ValidationError);
  });
});
