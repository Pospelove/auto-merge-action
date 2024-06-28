import * as core from '@actions/core';

import { Octokit } from '@octokit/rest';

import * as isomorphicGit from 'isomorphic-git';

import * as diff from "diff";

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

async function run() {
  try {
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

        console.log(`Processing PR #${prNumber} from ${prAuthor} with branch ${prBranch}`);

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
        console.log(`Applying patch to the repository`);

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

        const res = await exec.exec(`git apply --reject --verbose ${patchFilePath}`, [], options);
        сonsole.log("res: ", res);
        if (res !== 0) {
          const rejFiles = findRejFiles(path);
          console.error("Failed to apply the patch. Found .rej files: ", rejFiles);
          console.error("Please take a look at these files. They contain the rejected parts of the patch.");
          process.exit(1);
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
    }
  } catch (error) {
    core.setFailed(`Action failed with error: ${error}`);
  }
}

run();
