import * as core from '@actions/core';

import { Octokit } from '@octokit/rest';

import * as exec from '@actions/exec';

import * as fs from "fs";

import * as os from "os";

import * as pathModule from "path";

import * as streamBuffer from "stream-buffers";

interface Repository {
  owner: string,
  repo: string;
  labels: string[];
  token?: string;
}

type PR = any;

// Function to find .rej files recursively
function findRejFiles(dir: string) {
  let results = new Array<string>();
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = pathModule.resolve(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(findRejFiles(file));
    } else if (file.endsWith('.rej')) {
      results.push(file);
    }
  });
  return results;
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

    for (const repository of repositories) {
      const { repo, labels, token, owner } = repository;
      console.log(`Repository: ${repo}, Labels: ${labels.join(', ')}`);

      const octokit = new Octokit({
        auth: token,
      });

      // get pull requests from repository

      let pagesRemaining = true;
      let pullRequests = { data: new Array<PR> };
      let page = 0;
      while (pagesRemaining) {
        ++page;

        const pullRequestsPage = await octokit.rest.pulls.list({
          owner,
          repo,
          state: 'open',
          per_page: 100,
          page
        });

        const linkHeader = pullRequestsPage.headers.link;
        pagesRemaining = !!(linkHeader && linkHeader.includes(`rel=\"next\"`));

        console.log("Received page", page, "of PRs");
        pullRequests.data = pullRequests.data.concat(pullRequestsPage.data);
      }
      console.log(`Found ${pullRequests.data.length} open PRs`);

      for (const label of labels) {
        pullRequests.data = pullRequests.data.filter(pr => pr.labels.some((l: PR) => l.name === label));
      }

      console.log(`Found ${pullRequests.data.length} open PRs with required labels`);

      // get PR as a patch

      for (const pr of pullRequests.data) {
        const prNumber = pr.number;
        const prBranch = pr.head.ref;
        const prAuthor = pr.user.login;

        const patch = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: prNumber,
          mediaType: {
            format: 'diff'
          }
        });

        // apply patch to the repository

        const patchContent = patch.data as unknown as string;

        // create patch file in temp directory
        const patchFilePath = pathModule.join(os.tmpdir(), 'patch.diff');
        fs.writeFileSync(patchFilePath, patchContent);

        // const exec = require('@actions/exec');

        console.log("Current directory:", path);
        console.log("Current directory absolute: ", pathModule.resolve(path));

        const gitApplyStdout = new streamBuffer.WritableStreamBuffer();
        const gitApplyStderr = new streamBuffer.WritableStreamBuffer();

        const options: exec.ExecOptions = {
          cwd: path,
          outStream: gitApplyStdout,
          errStream: gitApplyStderr,
          ignoreReturnCode: true
        };

        console.log(`[!] Processing PR #${prNumber} from ${prAuthor} with branch ${prBranch}`);
        console.log("[!] Applying patch file:", patchFilePath);
        const res = await exec.exec(`git apply --reject --verbose ${patchFilePath}`, [], options);
        if (res !== 0) {
          console.log("Failed to apply the patch. Return code:", res);
          console.log("stderr:", gitApplyStderr.getContentsAsString('utf8'));
          console.log("stdout:", gitApplyStdout.getContentsAsString('utf8'));
          const rejFiles = findRejFiles(path);
          throw new Error("Failed to apply the patch. Found .rej files: " + rejFiles.join(", ") + ". Please take a look at these files. They contain the rejected parts of the patch.");
        }

        const gitApplyStdoutContentsString = gitApplyStdout.getContentsAsString('utf8');

        if (gitApplyStdoutContentsString === false) {
          throw new Error("Failed to read stdout of git apply");
        }

        console.log(gitApplyStdoutContentsString);

        // Find smth like Skipped patch 'src/logic/listeners/fatigueSystem.ts'.
        const skippedFiles = gitApplyStdoutContentsString.match(/Skipped patch '(.+?)'/g);

        if (skippedFiles) {
          throw new Error("Failed to apply the patch correctly. Skipped files: " + skippedFiles.join(", "));
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

        for (const pr of pullRequests.data) {
          buildMetadata.prs.push(pr);
        }

        const promises = pullRequests.data.map(async (pr) => {
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
