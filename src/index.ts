import * as core from '@actions/core';

import { Octokit } from '@octokit/rest';

import * as isomorphicGit from 'isomorphic-git';

import * as diff from "diff";

import * as exec from '@actions/exec';

import * as fs from "fs";

import * as os from "os";

import * as pathModule from "path";

interface Repository {
  owner: string,
  repo: string;
  labels: string[];
  token?: string;
}

type PR = any;

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

        const exec = require('@actions/exec');

        console.log("Current directory:", path);
        console.log("Current directory absolute: ", pathModule.resolve(path));

        const options = {
          cwd: path,
          outStream: process.stdout,
          errStream: process.stderr
        };

        // Adding the --reject option to git apply
        const res = await exec.exec(`git apply --reject ${patchFilePath}`, [], options);

        if (res !== 0) {
          console.log("Git exited with code ", res);
          throw new Error("Failed to apply the patch correctly.");
        } else {
          console.log("Patch applied successfully");
        }

      }
    }
  } catch (error) {
    core.setFailed(`Action failed with error: ${error}`);
  }
}

run();
