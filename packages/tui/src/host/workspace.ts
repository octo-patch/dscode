/**
 * Workspace reads and writes on the Host: the git inspection behind /diff,
 * /review and the status-line branch, and the /export file. The Host sees the
 * session's folder; a remote terminal may not, so these run where the session
 * lives in every mode.
 *
 * @module dsh-code/host/workspace
 */

import type { Context } from '@deepseek-ai/cordis'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { listReviewBranches, listReviewCommits, loadCommitDiff, loadGitDiff, mergeBaseWith } from '../git-workflow.ts'
import { RemoteFailure, type DscodeRemoteRegistry } from './registry.ts'

/** The working directory's branch, or '' outside a repository or on a detached HEAD. */
export async function readGitBranch(cwd: string): Promise<string> {
  try {
    const ref = (await readFile(join(cwd, '.git', 'HEAD'), 'utf8')).trim().match(/^ref: refs\/heads\/(.+)$/)
    return ref?.[1] ?? ''
  } catch {
    return ''
  }
}

const absolute = (path: string, label: string): string => {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new RemoteFailure('dscode/usage', `${label} must be an absolute path`)
  return path
}

export function registerWorkspace(_ctx: Context, registry: DscodeRemoteRegistry): (() => void)[] {
  return [
    registry.method('workspace/gitDiff', ({ cwd, argument }: { cwd: string; argument: string }, { signal }) => loadGitDiff(absolute(cwd, 'cwd'), argument ?? '', signal)),
    registry.method('workspace/commitDiff', ({ cwd, sha }: { cwd: string; sha: string }, { signal }) => loadCommitDiff(absolute(cwd, 'cwd'), sha, signal)),
    registry.method('workspace/mergeBase', async ({ cwd, branch }: { cwd: string; branch: string }, { signal }) => (await mergeBaseWith(absolute(cwd, 'cwd'), branch, signal)) ?? null),
    registry.method('workspace/reviewBranches', ({ cwd }: { cwd: string }, { signal }) => listReviewBranches(absolute(cwd, 'cwd'), signal)),
    registry.method('workspace/reviewCommits', ({ cwd }: { cwd: string }, { signal }) => listReviewCommits(absolute(cwd, 'cwd'), signal)),
    registry.method('workspace/gitBranch', ({ cwd }: { cwd: string }) => readGitBranch(absolute(cwd, 'cwd'))),
    // /export from a terminal that does not share the Host's filesystem.
    registry.method('workspace/writeText', async ({ path, text }: { path: string; text: string }) => {
      await writeFile(absolute(path, 'path'), text, 'utf8')
      return null
    }),
  ]
}
