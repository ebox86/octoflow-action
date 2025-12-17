import * as artifact from '@actions/artifact';
import * as core from '@actions/core';
import * as github from '@actions/github';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

type StepInfo = {
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
};

type JobNode = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  steps: StepInfo[];
};

type Edge = [string, string];

function ms(a?: string | null, b?: string | null): number | null {
  if (!a || !b) return null;
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.max(0, db - da);
}

function fmtDuration(msValue: number | null): string {
  if (msValue == null) return '—';
  const totalSeconds = Math.round(msValue / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function tryGetWorkflowPath(): string | null {
  const ref = process.env.GITHUB_WORKFLOW_REF;
  if (!ref) return null;
  const atIndex = ref.indexOf('@');
  const left = atIndex >= 0 ? ref.slice(0, atIndex) : ref;
  const parts = left.split('/');
  const dotGithub = parts.findIndex((part) => part === '.github');
  if (dotGithub < 0) return null;
  return parts.slice(dotGithub).join('/');
}

function parseNeedsEdges(workspace: string, workflowRelPath: string): Edge[] {
  const absPath = path.join(workspace, workflowRelPath);
  if (!fs.existsSync(absPath)) return [];
  const raw = fs.readFileSync(absPath, 'utf8');
  const doc = YAML.parse(raw);
  const jobs = (doc && typeof doc === 'object' ? (doc as Record<string, unknown>).jobs : null) as
    | Record<string, unknown>
    | null;
  if (!jobs) return [];
  const edges: Edge[] = [];
  for (const [jobId, jobDef] of Object.entries(jobs)) {
    const needs = (jobDef as Record<string, unknown>)?.needs;
    if (!needs) continue;
    const entries = Array.isArray(needs) ? needs : [needs];
    for (const dep of entries) {
      edges.push([String(dep), jobId]);
    }
  }
  return edges;
}

function mapJobIdToApiName(jobId: string, apiJobs: JobNode[]): string {
  const exact = apiJobs.find((job) => job.name === jobId);
  if (exact) return exact.name;
  const prefixed = apiJobs.find((job) => job.name.startsWith(jobId));
  if (prefixed) return prefixed.name;
  const bracket = apiJobs.find((job) => job.name.startsWith(`${jobId} (`));
  if (bracket) return bracket.name;
  return jobId;
}

function statusIcon(job: JobNode): string {
  const conclusion = job.conclusion?.toLowerCase() ?? '';
  if (job.status === 'in_progress') return '🟣';
  if (job.status === 'queued') return '⚪️';
  if (conclusion === 'success') return '✅';
  if (conclusion === 'skipped') return '⏭️';
  if (conclusion === 'neutral') return '⚪️';
  if (['failure', 'timed_out', 'cancelled', 'action_required'].includes(conclusion)) {
    return '❌';
  }
  return '⚪️';
}

function mermaidFlowLR(jobs: JobNode[], edges: Edge[]): string {
  if (jobs.length === 0) {
    return '```mermaid\nflowchart LR\n```';
  }

  const sanitizeId = (value: string) => value.replace(/[^a-zA-Z0-9_]/g, '_');
  const lines: string[] = ['flowchart LR'];

  for (const job of jobs) {
    const nodeId = `J_${sanitizeId(job.name)}_${job.id}`;
    const label = `${statusIcon(job)} ${job.name}\\n${job.conclusion ?? job.status}`;
    lines.push(`${nodeId}["${label}"]`);
  }

  for (const [from, to] of edges) {
    if (jobs.length === 0) break;
    const fromName = mapJobIdToApiName(from, jobs);
    const toName = mapJobIdToApiName(to, jobs);

    const fromJob = jobs.find((job) => job.name === fromName) ?? jobs[0];
    const toJob = jobs.find((job) => job.name === toName) ?? jobs[0];
    if (!fromJob || !toJob) continue;

    const fromNode = `J_${sanitizeId(fromJob.name)}_${fromJob.id}`;
    const toNode = `J_${sanitizeId(toJob.name)}_${toJob.id}`;
    lines.push(`${fromNode} --> ${toNode}`);
  }

  return '```mermaid\n' + lines.join('\n') + '\n```';
}

function buildNormalizedJobs(jobs: JobNode[]): Array<{ id: number; name: string; status: string; conclusion: string | null; started_at?: string | null; completed_at?: string | null; steps: StepInfo[] }> {
  return jobs.map((job) => ({
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    started_at: job.started_at,
    completed_at: job.completed_at,
    steps: job.steps.map((step) => ({
      name: step.name,
      status: step.status,
      conclusion: step.conclusion,
      started_at: step.started_at,
      completed_at: step.completed_at
    }))
  }));
}

function parseState(key: string): string | undefined {
  const value = core.getState(key);
  return value === '' ? undefined : value;
}

function toBoolean(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(normalized);
}

async function run(): Promise<void> {
  try {
    const token = parseState('token');
    const artifactEnabled = toBoolean(parseState('artifact'));
    const graphFormat = (parseState('graph') || 'mermaid').trim().toLowerCase();
    const title = parseState('title') || 'OctoFlow';
    const owner = parseState('owner');
    const repo = parseState('repo');
    const runIdString = parseState('run-id');
    const sha = parseState('sha');

    if (!token || !owner || !repo || !runIdString || !sha) {
      throw new Error('Missing run context in saved state.');
    }

    const runId = Number(runIdString);
    if (Number.isNaN(runId)) {
      throw new Error('Invalid run id stored in state.');
    }

    const octokit = github.getOctokit(token);

    const runResponse = await octokit.rest.actions.getWorkflowRun({
      owner,
      repo,
      run_id: runId
    });
    const runData = runResponse.data;

    const rawJobs = (await octokit.paginate(
      octokit.rest.actions.listJobsForWorkflowRun,
      { owner, repo, run_id: runId, per_page: 100 },
      (response) => response.data.jobs
    )) as Array<Record<string, unknown> | null>;
    const knownJobs = rawJobs.filter((job): job is Record<string, unknown> => Boolean(job));

    if (knownJobs.length === 0) {
      core.warning('No jobs were returned for the current workflow run.');
    }

    const jobs: JobNode[] = (knownJobs as any[]).map((job) => ({
      id: job.id,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      started_at: job.started_at,
      completed_at: job.completed_at,
      steps: (job.steps ?? []).map((step: any) => ({
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
        started_at: step.started_at,
        completed_at: step.completed_at
      }))
    }));

    const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
    const workflowPath = tryGetWorkflowPath();
    const edges = workflowPath ? parseNeedsEdges(workspace, workflowPath) : [];

    const mermaid = graphFormat === 'mermaid' || graphFormat === '' ? mermaidFlowLR(jobs, edges) : '';
    if (graphFormat !== 'mermaid' && graphFormat !== '') {
      core.warning(`Graph format '${graphFormat}' is not supported yet, defaulting to Mermaid.`);
    }

    const tableRows = jobs
      .map((job) => {
        const result = job.conclusion ?? job.status;
        return {
          name: job.name,
          result,
          started: job.started_at ? new Date(job.started_at).toISOString() : '—',
          duration: fmtDuration(ms(job.started_at, job.completed_at))
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryPath) {
      throw new Error('GITHUB_STEP_SUMMARY is not available in this environment.');
    }

    const runLink = runData.html_url ? `[${owner}/${repo} #${runId}](${runData.html_url})` : `${owner}/${repo} #${runId}`;
    let markdown = `## ${title}\n\n`;
    markdown += `**Run:** ${runLink}  \n`;
    markdown += `**Status:** ${runData.status} / ${runData.conclusion ?? '—'}  \n`;
    if (runData.run_started_at) {
      markdown += `**Started:** ${new Date(runData.run_started_at).toISOString()}  \n`;
    }
    markdown += '\n';

    markdown += '### Pipeline\n\n';
    markdown += mermaid || 'Mermaid graph is not available yet.';
    markdown += '\n\n';

    markdown += '### Jobs\n\n';
    markdown += '| Job | Result | Started | Duration |\n|---|---|---|---|\n';
    for (const row of tableRows) {
      markdown += `| ${row.name} | ${row.result} | ${row.started} | ${row.duration} |\n`;
    }
    markdown += '\n';

    fs.appendFileSync(summaryPath, markdown);

    if (artifactEnabled) {
      const payload = {
        version: 1,
        repo: `${owner}/${repo}`,
        run: {
          id: runId,
          name: runData.name ?? `#${runId}`,
          status: runData.status,
          conclusion: runData.conclusion,
          sha,
          created_at: runData.created_at,
          run_started_at: runData.run_started_at
        },
        jobs: buildNormalizedJobs(jobs),
        edges,
        workflow_path: workflowPath ?? undefined
      };
      fs.writeFileSync(path.join(workspace, 'octoflow.json'), JSON.stringify(payload, null, 2));
      const client = new artifact.DefaultArtifactClient();
      await client.uploadArtifact('octoflow', [path.join(workspace, 'octoflow.json')], workspace, {
        retentionDays: 14
      });
    }
  } catch (error: unknown) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

run();
