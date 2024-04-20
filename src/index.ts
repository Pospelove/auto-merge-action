const core = require('@actions/core');

async function run() {
  try {
    const repositories = JSON.parse(core.getInput('repositories'));
    
    for (const repo of repositories) {
      const { repo: repositoryName, labels } = repo;
      console.log(`Repository: ${repositoryName}, Labels: ${labels.join(', ')}`);
      // ...
    }
  } catch (error) {
    core.setFailed(`Action failed with error: ${error}`);
  }
}

run();
