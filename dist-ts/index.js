"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const artifact = __importStar(require("@actions/artifact"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const yaml_1 = __importDefault(require("yaml"));
function ms(a, b) {
    if (!a || !b)
        return null;
    const da = new Date(a).getTime();
    const db = new Date(b).getTime();
    if (Number.isNaN(da) || Number.isNaN(db))
        return null;
    return Math.max(0, db - da);
}
function fmtDuration(msv) {
    if (msv == null)
        return "—";
    const s = Math.round(msv / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m <= 0)
        return `${r}s`;
    return `${m}m ${r}s`;
}
function tryGetWorkflowPath() {
    // GITHUB_WORKFLOW_REF looks like: owner/repo/.github/workflows/ci.yml@refs/heads/main
    const ref = process.env.GITHUB_WORKFLOW_REF;
    if (!ref)
        return null;
    const at = ref.indexOf("@");
    const left = at >= 0 ? ref.slice(0, at) : ref;
    const parts = left.split("/");
    const idx = parts.findIndex((p) => p === ".github");
    if (idx < 0)
        return null;
    return parts.slice(idx).join("/");
}
function parseNeedsEdges(workspace, workflowRelPath) {
    const abs = node_path_1.default.join(workspace, workflowRelPath);
    if (!node_fs_1.default.existsSync(abs))
        return [];
    const doc = yaml_1.default.parse(node_fs_1.default.readFileSync(abs, "utf8"));
    const jobs = doc?.jobs;
    if (!jobs || typeof jobs !== "object")
        return [];
    const edges = [];
    for (const [jobId, jobDef] of Object.entries(jobs)) {
        const needs = jobDef?.needs;
        if (!needs)
            continue;
        const list = Array.isArray(needs) ? needs : [needs];
        for (const dep of list)
            edges.push([String(dep), String(jobId)]);
    }
    return edges;
}
// naive mapper: tries to match workflow job ids to job names returned by API
function mapJobIdToApiName(jobId, apiJobs) {
    const exact = apiJobs.find((j) => j.name === jobId);
    if (exact)
        return exact.name;
    const prefix = apiJobs.find((j) => j.name.startsWith(jobId));
    if (prefix)
        return prefix.name;
    const bracket = apiJobs.find((j) => j.name.startsWith(`${jobId} (`));
    if (bracket)
        return bracket.name;
    // fallback: just use id as label
    return jobId;
}
function mermaidFlowLR(apiJobs, edges) {
    const safe = (s) => s.replace(/[^a-zA-Z0-9_]/g, "_");
    const lines = [];
    lines.push("flowchart LR");
    // nodes
    for (const j of apiJobs) {
        const nid = `J_${safe(j.name)}_${j.id}`;
        const label = `${j.name}\\n${j.conclusion ?? j.status}`;
        lines.push(`${nid}["${label}"]`);
    }
    // edges (best effort): connect *one* matching node per jobId
    for (const [fromId, toId] of edges) {
        const fromName = mapJobIdToApiName(fromId, apiJobs);
        const toName = mapJobIdToApiName(toId, apiJobs);
        const fromNode = apiJobs.find((j) => j.name === fromName) ?? apiJobs[0];
        const toNode = apiJobs.find((j) => j.name === toName) ?? apiJobs[0];
        if (!fromNode || !toNode)
            continue;
        const fromN = `J_${safe(fromNode.name)}_${fromNode.id}`;
        const toN = `J_${safe(toNode.name)}_${toNode.id}`;
        lines.push(`${fromN} --> ${toN}`);
    }
    return "```mermaid\n" + lines.join("\n") + "\n```";
}
async function run() {
    try {
        const token = core.getInput("github-token", { required: true });
        const publish = core.getInput("publish") || "check";
        const viewerUrl = core.getInput("viewer-url") || "";
        const octokit = github.getOctokit(token);
        const { owner, repo } = github.context.repo;
        const runId = github.context.runId;
        // Get run + jobs
        const runResp = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
        const runData = runResp.data;
        const jobsResp = await octokit.rest.actions.listJobsForWorkflowRun({
            owner,
            repo,
            run_id: runId,
            per_page: 100
        });
        const apiJobs = jobsResp.data.jobs.map((j) => ({
            id: j.id,
            name: j.name,
            status: j.status,
            conclusion: j.conclusion,
            started_at: j.started_at,
            completed_at: j.completed_at,
            steps: (j.steps ?? []).map((s) => ({
                name: s.name,
                status: s.status,
                conclusion: s.conclusion,
                number: s.number,
                started_at: s.started_at,
                completed_at: s.completed_at
            }))
        }));
        // Try parse workflow yaml to get needs -> edges (best effort)
        const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
        const workflowRel = tryGetWorkflowPath();
        const edges = workflowRel ? parseNeedsEdges(workspace, workflowRel) : [];
        // Build summary
        const started = runData.run_started_at ?? runData.created_at ?? null;
        const created = runData.created_at ?? null;
        const tableRows = apiJobs
            .map((j) => {
            const dur = ms(j.started_at ?? null, j.completed_at ?? null);
            const wait = ms(created, j.started_at ?? null);
            return {
                name: j.name,
                conclusion: j.conclusion ?? j.status,
                wait: fmtDuration(wait),
                duration: fmtDuration(dur)
            };
        })
            .sort((a, b) => a.name.localeCompare(b.name));
        let md = "";
        md += `## OctoFlow\n\n`;
        md += `**Run:** ${runData.name}  \n`;
        md += `**Status:** ${runData.status} / ${runData.conclusion ?? "—"}  \n`;
        if (started)
            md += `**Started:** ${new Date(started).toISOString()}  \n`;
        md += `\n`;
        md += `### Pipeline\n\n`;
        md += mermaidFlowLR(apiJobs, edges) + "\n\n";
        md += `### Jobs\n\n`;
        md += `| Job | Result | Wait (approx) | Duration |\n|---|---|---:|---:|\n`;
        for (const r of tableRows) {
            md += `| ${r.name} | ${r.conclusion} | ${r.wait} | ${r.duration} |\n`;
        }
        md += `\n`;
        // JSON artifact for the web viewer
        const payload = {
            version: 1,
            repo: { owner, repo },
            run: {
                id: runId,
                name: runData.name,
                status: runData.status,
                conclusion: runData.conclusion,
                created_at: runData.created_at,
                run_started_at: runData.run_started_at
            },
            jobs: apiJobs,
            edges,
            workflow_path: workflowRel
        };
        node_fs_1.default.writeFileSync("octoflow.json", JSON.stringify(payload, null, 2));
        const client = new artifact.DefaultArtifactClient();
        await client.uploadArtifact("octoflow", ["octoflow.json"], process.cwd(), {
            retentionDays: 14
        });
        // Write summary
        node_fs_1.default.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
        // Optional: create a check run linking to viewer
        if (publish === "check" && viewerUrl) {
            const detailsUrl = `${viewerUrl.replace(/\/$/, "")}/run/${owner}/${repo}/${runId}`;
            await octokit.rest.checks.create({
                owner,
                repo,
                name: "OctoFlow",
                head_sha: github.context.sha,
                status: "completed",
                conclusion: runData.conclusion ?? "neutral",
                details_url: detailsUrl,
                output: {
                    title: "OctoFlow Viewer",
                    summary: `Open the interactive pipeline view: ${detailsUrl}`
                }
            });
        }
    }
    catch (err) {
        core.setFailed(err?.message ?? String(err));
    }
}
run();
