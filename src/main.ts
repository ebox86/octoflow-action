import * as core from '@actions/core';
import * as github from '@actions/github';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function toBooleanString(input: string | undefined): 'true' | 'false' {
  if (!input) {
    return 'true';
  }
  const normalized = input.trim().toLowerCase();
  if (FALSE_VALUES.has(normalized)) {
    return 'false';
  }
  if (TRUE_VALUES.has(normalized)) {
    return 'true';
  }
  return 'true';
}

function run(): void {
  try {
    const token = core.getInput('github-token', { required: true });
    const artifact = toBooleanString(core.getInput('artifact'));
    const graph = (core.getInput('graph') || 'mermaid').trim();
    const title = core.getInput('title')?.trim() || 'OctoFlow';

    const { owner, repo } = github.context.repo;
    const runId = String(github.context.runId);
    const sha = github.context.sha;

    core.saveState('token', token);
    core.saveState('artifact', artifact);
    core.saveState('graph', graph);
    core.saveState('title', title);

    core.saveState('owner', owner);
    core.saveState('repo', repo);
    core.saveState('run-id', runId);
    core.saveState('sha', sha);
  } catch (error: unknown) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

run();
