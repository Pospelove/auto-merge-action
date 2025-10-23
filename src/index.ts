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

async function run() {
  try {
    let buildMetadata: BuildMetadata | null = null;

    const generateBuildMetadata = core.getInput('generate-build-metadata');

    const repositories: Repository[] = JSON.parse(core.getInput('repositories'));

    let path: string = core.getInput('path');

    // important for replace 'a' and 'b' in diff
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

      const octokit = new Octokit({
        auth: token,
      });

      // get pull requests from repository
      const query = `repo:${owner}/${repo} is:pr is:open ${labels.map(label => `label:"${label}"`).join(' ')}`;
      console.log("Searching for PRs with query:", query);
      const searchResult = await octokit.search.issuesAndPullRequests({
        q: query
      });

      console.log(`Found ${searchResult.data.items.length} PRs with required labels`);

      const pullRequests = await Promise.all(searchResult.data.items.map(issue =>
        octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: issue.number
        })
      ));

      const pullRequestsData = sortPullRequests(pullRequests.map(pr => pr.data));

      console.log(`Found ${pullRequestsData.length} open PRs with required labels`);

      // get PR as a patch

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
        res = await exec.exec(`git merge ${prSha}`, [], {
          cwd: path,
          ignoreReturnCode: true,
          outStream: gitMergeStdout,
          errStream: gitMergeStderr
        });
        if (res !== 0) {
          const stdout = gitMergeStdout.getContentsAsString('utf8') || '';
          const stderr = gitMergeStderr.getContentsAsString('utf8') || '';
          // Check for merge conflicts
          const gitStatus = await exec.exec('git status --porcelain', [], { cwd: path });
          if (gitStatus !== 0) {
            throw new Error(`Merge of PR #${prNumber} failed and could not get git status. stdout: ${stdout}, stderr: ${stderr}`);
          }
          throw new Error(`Merge of PR #${prNumber} resulted in conflicts. Please resolve them manually. stdout: ${stdout}, stderr: ${stderr}`);
        }
      }

      // Generate build metadata for the current repo in the loop
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
    }
    else {
      console.log("Build metadata:", buildMetadata);
      const p = pathModule.normalize("build-metadata.json");
      console.log("Writing build metadata to " + p);
      fs.writeFileSync(p, JSON.stringify(buildMetadata, null, 2));
    }
  } catch (error) {
    core.setFailed(`Action failed with error: ${error}`);
  }
}

run();
