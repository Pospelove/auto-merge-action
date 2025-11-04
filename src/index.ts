import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import * as exec from '@actions/exec';
import * as fs from "fs";
import * as pathModule from "path";
import * as streamBuffer from "stream-buffers";

interface Repository {
  owner: string,
  repo: string;
  labels: string[];
  token?: string;
}

type BuildMetadataPR = any;

interface RefInfo {
  ref: string;
  lastCommitSha: string;
  lastCommitMessage: string;
  lastCommitAuthor: string;
  lastCommitAuthorDate: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prTitle: string;
};

interface BuildMetadata {
  prs: BuildMetadataPR[];
  refs_info: Array<RefInfo>;
};

function sortPullRequests(pullRequests: any[]): any[] {
  return pullRequests.sort((a, b) => a.number - b.number);
}

async function handleMergeConflict(prNumber: number, stdout: string, stderr: string, path: string): Promise<never> {
  // Log detailed conflict information
  console.error(`\n${'='.repeat(80)}`);
  console.error(`MERGE CONFLICT DETECTED - PR #${prNumber}`);
  console.error(`${'='.repeat(80)}\n`);

  // Get list of conflicted files
  const conflictedFilesStdout = new streamBuffer.WritableStreamBuffer();
  const conflictStatusRes = await exec.exec('git status --porcelain', [], {
    cwd: path,
    ignoreReturnCode: true,
    outStream: conflictedFilesStdout
  });

  let conflictedFilesInfo = '';
  const conflictedFiles: string[] = [];
  
  if (conflictStatusRes === 0) {
    const statusOutput = conflictedFilesStdout.getContentsAsString('utf8') || '';
    conflictedFiles.push(...statusOutput
      .split('\n')
      .filter((line: string) => line.startsWith('UU ') || line.startsWith('AA ') || line.startsWith('DD '))
      .map((line: string) => line.substring(3).trim())
      .filter((file: string) => file.length > 0));

    if (conflictedFiles.length > 0) {
      console.error(`[!] Conflicted Files (${conflictedFiles.length}):`);
      conflictedFiles.forEach(file => console.error(`   - ${file}`));
      console.error('');
      conflictedFilesInfo = ` Conflicted files: ${conflictedFiles.join(', ')}.`;
    }
  }

  // Show conflict details for each conflicted file
  if (conflictedFiles.length > 0) {
    console.error(`[!] Conflict Details:\n`);
    for (const file of conflictedFiles) {
      try {
        const diffStdout = new streamBuffer.WritableStreamBuffer();
        const diffRes = await exec.exec('git', ['diff', file], {
          cwd: path,
          ignoreReturnCode: true,
          outStream: diffStdout
        });
        
        if (diffRes === 0) {
          const diffOutput = diffStdout.getContentsAsString('utf8') || '';
          if (diffOutput.trim()) {
            console.error(`${'-'.repeat(80)}`);
            console.error(`File: ${file}`);
            console.error(`${'-'.repeat(80)}`);
            console.error(diffOutput);
            console.error('');
          }
        }
      } catch (error) {
        console.error(`[!] Could not read conflict details for ${file}: ${error}\n`);
      }
    }
  }

  // Show git merge output
  console.error(`[!] Git Merge Output:`);
  console.error(`${'-'.repeat(80)}`);
  console.error(stdout);
  if (stderr.trim()) {
    console.error(`\n[!]  Stderr:`);
    console.error(stderr);
  }
  console.error(`${'-'.repeat(80)}\n`);

  // Reset the workspace to a clean state before throwing the error
  console.error(`[!] Resetting workspace to a clean state...`);
  await exec.exec('git reset --hard HEAD', [], { cwd: path });
  await exec.exec('git clean -fd', [], { cwd: path });

  console.error(`\n${'='.repeat(80)}`);
  console.error(`END OF CONFLICT REPORT`);
  console.error(`${'='.repeat(80)}\n`);

  // Throw the error to fail the action
  const errorMessage = `Merge of PR #${prNumber} resulted in conflicts.${conflictedFilesInfo}`;
  throw new Error(errorMessage);
}

async function run() {
  try {
    let buildMetadata: BuildMetadata | null = null;

    const generateBuildMetadata = core.getInput('generate-build-metadata');
    const repositories: Repository[] = JSON.parse(core.getInput('repositories'));
    let path: string = core.getInput('path');

    if (!path.endsWith('/')) {
      path += '/';
    }

    const skipGitConfig = core.getInput('skip-git-config') === 'true';

    if (!skipGitConfig) {
      await exec.exec('git config --global user.name "github-actions[bot]"');
      await exec.exec('git config --global user.email "github-actions[bot]@users.noreply.github.com"');
    }

    for (const repository of repositories) {
      const { repo, labels, token, owner } = repository;
      console.log(`Repository: ${repo}, Labels: ${labels.join(', ')}`);

      // [FIX] Set the remote URL for 'origin' to the current repository in the loop
      const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
      console.log(`[!] Setting remote origin URL to: https://x-access-token:***@github.com/${owner}/${repo}.git`);
      await exec.exec('git remote set-url origin', [remoteUrl], { cwd: path });

      // [FIX] Fetch from the new origin to update local remote-tracking branches
      console.log('[!] Fetching from new origin');
      await exec.exec('git fetch origin', [], { cwd: path });

      const octokit = new Octokit({
        auth: token,
      });

      let foundItems = [];
      if (labels.length > 0) {
        const query = `repo:${owner}/${repo} is:pr is:open ${labels.map(label => `label:"${label}"`).join(' ')}`;
        console.log("Searching for PRs with query:", query);
        const searchResult = await octokit.search.issuesAndPullRequests({
          q: query,
        });
        foundItems = searchResult.data.items;
      } else {
        console.log('No labels supplied, not fetching any PRs');
      }

      console.log(`Found ${foundItems.length} PRs with required labels`);

      const pullRequests = await Promise.all(foundItems.map(issue =>
        octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: issue.number
        })
      ));

      const pullRequestsData = sortPullRequests(pullRequests.map(pr => pr.data));

      console.log(`Found ${pullRequestsData.length} open PRs with required labels`);

      for (const pr of pullRequestsData) {
        const prNumber = pr.number;
        const prBranch = pr.head.ref;
        const prAuthor = pr.user.login;
        const prSha = pr.head.sha;

        console.log(`[!] Processing PR #${prNumber} from ${prAuthor} with branch ${prBranch}`);

        const fetchStdout = new streamBuffer.WritableStreamBuffer();
        const fetchStderr = new streamBuffer.WritableStreamBuffer();

        const options: exec.ExecOptions = {
          cwd: path,
          ignoreReturnCode: true,
          outStream: fetchStdout,
          errStream: fetchStderr
        };

        // Fetch the PR branch
        console.log(`[!] Fetching PR #${prNumber} from remote`);
        // [FIX] 'origin' now correctly points to the right repo (from the fix above)
        let res = await exec.exec(`git fetch origin pull/${prNumber}/head:${prBranch}`, [], options);
        if (res !== 0) {
          const stdout = fetchStdout.getContentsAsString('utf8') || '';
          const stderr = fetchStderr.getContentsAsString('utf8') || '';
          throw new Error(`Failed to fetch PR #${prNumber}. stdout: ${stdout}, stderr: ${stderr}`);
        }

        // Merge the PR branch
        console.log(`[!] Merging branch ${prBranch} (${prSha})`);
        const gitMergeStdout = new streamBuffer.WritableStreamBuffer();
        const gitMergeStderr = new streamBuffer.WritableStreamBuffer();
        res = await exec.exec(`git merge ${prBranch}`, [], {
          cwd: path,
          ignoreReturnCode: true,
          outStream: gitMergeStdout,
          errStream: gitMergeStderr
        });
        
        if (res !== 0) {
          const stdout = gitMergeStdout.getContentsAsString('utf8') || '';
          const stderr = gitMergeStderr.getContentsAsString('utf8') || '';
          await handleMergeConflict(prNumber, stdout, stderr, path);
        }
      }

      // Generate build metadata
      if (generateBuildMetadata === 'true') {
        if (buildMetadata === null) {
          buildMetadata = {
            prs: [],
            refs_info: []
          };
        }
        console.log("Generating build metadata");

        for (const pr of pullRequestsData) {
          buildMetadata.prs.push(pr);
        }

        const promises = pullRequestsData.map(async (pr) => {
          const commit = await octokit.rest.git.getCommit({
            owner,
            repo,
            commit_sha: pr.head.sha
          });
          return {
            ref: pr.head.ref,
            info: {
              ref: pr.head.ref,
              lastCommitSha: pr.head.sha,
              lastCommitMessage: commit.data.message,
              lastCommitAuthor: commit.data.author.name,
              lastCommitAuthorDate: commit.data.author.date,
              repoOwner: owner,
              repoName: repo,
              prNumber: pr.number,
              prTitle: pr.title
            }
          };
        });

        const results = await Promise.all(promises);
        results.forEach(result => {
          buildMetadata?.refs_info.push(result.info);
        });
      }
    }

    if (buildMetadata === null) {
      console.log("No build metadata to write");
    } else {
      console.log("Build metadata:", buildMetadata);
      const p = pathModule.normalize(`${path}/build-metadata.json`);
      console.log("Writing build metadata to " + p);
      fs.writeFileSync(p, JSON.stringify(buildMetadata, null, 2));
    }
  } catch (error) {
    console.error(error);
    core.setFailed(`Action failed with error: ${error}`);
  }
}

run();
