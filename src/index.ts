import * as core from '@actions/core';

import { Octokit } from '@octokit/rest';

import * as isomorphicGit from 'isomorphic-git';

import * as diff from "diff";

import * as fs from "fs";

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

        diff.applyPatches(patchContent, {
          loadFile(index: diff.ParsedDiff, callback: (err: any, data: string) => void) {

            let oldFileName = index.oldFileName || "/dev/null";
            // replace 'a' with actual repository path
            oldFileName = oldFileName.replace(/a\//, path);

            console.log(`Loading file ${oldFileName}`);

            if (oldFileName === "/dev/null") {
              callback(null, "");
              return;
            }

            callback(null, fs.readFileSync(oldFileName, "utf8"));
          },
          patched(index: diff.ParsedDiff, content: string, callback: (err: any, data: string) => void) {
            let newFileName = index.newFileName || "/dev/null";
            // replace 'b' with actual repository path
            newFileName = newFileName.replace(/b\//, path);

            let oldFileName = index.oldFileName || "/dev/null";
            // replace 'a' with actual repository path
            oldFileName = oldFileName.replace(/a\//, path);

            console.log(`Patching file: new file name - ${newFileName}, old file name - ${oldFileName}`);

            if (newFileName === "/dev/null") {
              console.log(`Deleting file ${oldFileName}`);
              fs.unlinkSync(oldFileName);
              callback(null, content);
              return;
            }

            if (oldFileName !== newFileName && oldFileName !== "/dev/null") {
              console.log(`Renaming file ${oldFileName} to ${newFileName}`);
              fs.unlinkSync(oldFileName!);
              fs.writeFileSync(newFileName, content);
              callback(null, content);
              return;
            }

            console.log(`Writing to file ${newFileName}`);
            fs.writeFileSync(newFileName, content);
            callback(null, content);
          },
          complete(err: any) {
            if (err) {
              console.error(`Failed to apply patch: ${err}`);
              throw err;
            } else {
              console.log(`Patch applied successfully`);
            }
          }
        });

        console.log(`Patch applied successfully`);
      }
    }
  } catch (error) {
    core.setFailed(`Action failed with error: ${error}`);
  }
}

run();
