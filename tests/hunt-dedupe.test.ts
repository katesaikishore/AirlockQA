import { describe, expect, it } from 'bun:test';
import { decide, findDuplicates, keywords, scoreMatches, similarity, type HuntIssue } from '../src/hunt/index.js';

const openIssue: HuntIssue = {
  number: 42,
  title: 'Checkout button ignores clicks on mobile Safari',
  body: 'On mobile Safari the checkout button does nothing; tapping it twice sometimes works. Repro: open /checkout in Safari.',
  state: 'open',
  html_url: 'https://github.com/acme/store/issues/42',
  isPullRequest: false,
};

describe('QA duplicate gate', () => {
  it('extracts significant keywords and ignores noise words', () => {
    expect(keywords('The checkout button is broken on mobile Safari')).toEqual(['checkout', 'button', 'mobile', 'safari']);
  });

  it('scores similar titles and bodies above unrelated ones', () => {
    expect(similarity('checkout button mobile safari', openIssue.title)).toBeGreaterThan(0.5);
    expect(scoreMatches('Checkout button does nothing on mobile Safari', 'Tapping checkout in Safari has no effect', [openIssue])).toHaveLength(1);
    expect(scoreMatches('Docs typo in README', 'The install command says bunx npx', [openIssue])).toHaveLength(0);
  });

  it('blocks an open similar issue and reviews a weak match', () => {
    const strong = scoreMatches('Checkout button does nothing on mobile Safari', '', [openIssue]);
    expect(decide(strong)).toBe('BLOCK');
    const weak: HuntIssue = { ...openIssue, title: 'Mobile Safari layout issue in settings', body: 'Settings page misaligned on iPhone.' };
    expect(decide(scoreMatches('Checkout button does nothing on mobile Safari', '', [weak]))).toBe('CLEAR');
  });

  it('returns a review result and links when GitHub search finds an open duplicate', async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({ total_count: 1, items: [{ number: 42, title: openIssue.title, body: openIssue.body, state: 'open', html_url: openIssue.html_url }] }),
      text: async () => '',
    })) as unknown as typeof fetch;
    const result = await findDuplicates('acme/store', 'Checkout button does nothing on mobile Safari', 'Tapping checkout in Safari does nothing', { fetchImpl: fakeFetch });
    expect(result.decision).toBe('BLOCK');
    expect(result.matches[0].issue.number).toBe(42);
    expect(result.checked).toBe(1);
    expect(result.error).toBeUndefined();
  });

  it('never reports clear when the search itself failed', async () => {
    const fakeFetch = (async () => ({ ok: false, status: 403, text: async () => 'rate limited', json: async () => ({}) })) as unknown as typeof fetch;
    const result = await findDuplicates('acme/store', 'Checkout button does nothing', '', { fetchImpl: fakeFetch });
    expect(result.decision).toBe('REVIEW');
    expect(result.error).toContain('HTTP 403');
  });
});
