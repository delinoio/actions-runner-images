// SPDX-License-Identifier: Apache-2.0
import { Failure, invariant } from './common.mjs';

export class GitHub {
  constructor(token = process.env.GITHUB_TOKEN, fetcher = fetch) { this.token = token; this.fetcher = fetcher; }
  async request(path, options = {}) {
    invariant(path.startsWith('/') && !path.startsWith('//'), 'INVALID_API_PATH');
    let response;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        response = await this.fetcher(`https://api.github.com${path}`, {
          ...options, redirect: 'error', signal: AbortSignal.timeout(60_000),
          headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...options.headers },
        });
      } catch { if ((options.method ?? 'GET') !== 'GET' || attempt === 3) throw new Failure('GITHUB_REQUEST_FAILED'); }
      if (response && (response.status < 500 || (options.method ?? 'GET') !== 'GET')) break;
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
    }
    return response;
  }
  async json(path, options = {}) {
    const response = await this.request(path, options);
    if (!response.ok) throw new Failure('GITHUB_API_REJECTED', response.status);
    return response.status === 204 ? null : response.json();
  }
  async contents(path, revision, repo = 'actions/runner-images') {
    invariant(/^[a-f0-9]{40}$/.test(revision), 'PINNED_SOURCE_REVISION_REQUIRED');
    const result = await this.json(`/repos/${repo}/contents/${path}?ref=${revision}`);
    invariant(result.type === 'file' && result.encoding === 'base64', 'SOURCE_FILE_REQUIRED');
    return Buffer.from(result.content, 'base64').toString('utf8');
  }
}
