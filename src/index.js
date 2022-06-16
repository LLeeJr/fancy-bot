/**
 * This is the main entrypoint to your Probot app
 * @param {import('probot').Probot} app
 */
// const {ProbotOctokit} = require("probot");
const fs = require("fs");
const yaml = require('js-yaml');
const { execSync } = require('child_process');

function getInstallationToken() {
  // TODO
  return "token";
}

function createDockerfile(yaml, token, branch, owner, repoName) {
  let dockerfile = `FROM node:16-slim\n`; // `FROM ${yaml.ci.language}`;
  dockerfile += "RUN apt-get update\nRUN apt-get install git\n"
  dockerfile += `RUN git clone --branch ${branch} https://x-access-token:${token}@github.com/${owner}/${repoName}.git\n`

  for (let step of yaml.ci.steps) {
    dockerfile += `RUN ${step}\n`;
  }

  fs.mkdirSync(`./Dockerfiles/${repoName}`, { recursive: true}, (err) => {
    app.log.error(err);
  });

  fs.writeFileSync(`./Dockerfiles/${repoName}/Dockerfile`, dockerfile);
}

module.exports = (app) => {
  // Your code here
  app.log.info("Yay, the app was loaded!");

  app.on("issues.opened", async (context) => {
    const issueComment = context.issue({
      body: "Thanks for opening this issue!",
    });
    return context.octokit.issues.createComment(issueComment);
  });

  app.on(["pull_request.opened", "pull_request.synchronize", "pull_request.reopened"] , async (context) => {
    const headSha = context.payload.pull_request.head.sha;
    const branch = context.payload.pull_request.head.ref;

    await createCommitStatus(context, headSha, "pending", "fetch yaml from branch", "custom-ci");

    // Get yaml file from pr branch and decode it
    const yaml = await context.octokit.rest.repos.getContent({
      owner: context.repo().owner,
      repo: context.repo().repo,
      path: 'ci_cd.yml',
      ref: branch
    })
        .then(result => readYaml(result.data.content))
        .catch(error => error.name);

    app.log.info(`After fetching yaml: ${yaml.toString()}`);

    // differentiate between two errors
    // one for failing to fetch yaml from repo
    if (yaml === "HttpError") {
      await createCommitStatus(context, headSha, "error", "failed fetching yaml from this branch", "custom-ci");
      return;
    // the other for failing to decoding or returning data as yaml
    } else if (yaml === "ValidationError") {
      await createCommitStatus(context, headSha, "error", "failed validating yaml", "custom-ci");
      return;
    }

    // TODO validation of yaml

    await createCommitStatus(context, headSha, "success", "successfully fetched and validated yaml", "custom-ci");

    // Check if a provider was chosen if not use own ci tool
    if (yaml.ci.provider === undefined) {
      app.log.info("chose custom ci");

      // Create Dockerfile with given data
      let token = getInstallationToken()

      createDockerfile(yaml, token, branch, context.repo().owner, context.repo().repo);

      return;
    }

    // Check which provider should be triggered for ci
    if (yaml.ci.provider === "github-actions") {
      app.log.info("chose github-actions")
      await createCommitStatus(context, headSha, "pending", "starting github actions workflow", "custom-ci/github-actions");
      // TODO maybe multiple workflows?
      await githubActionsCI(context, yaml.ci.workflow_file_name);
    }
  });

  app.on("workflow_run.completed", async (context) => {
    // TODO what happens when github action fails?
    if (context.payload.workflow_run.conclusion === "success") {
      await createCommitStatus(context, context.payload.workflow_run.head_sha, "success", "github actions workflow was successful", "custom-ci/github-actions")
    }

    app.log.info(`Conclusion: ${context.payload.workflow_run.conclusion}`)

    // TODO when CI is github actions, retrieve ci_cd.yml again and check how to do cd
  });
};

// callCommand('docker build -f ci/node.Dockerfile -t test .').then(() => {
//   console.info("Docker build done")
// }).catch(error => console.error(error));

async function callCommand(command) {
  return execSync('docker -v && git --version').toString();
}

function readYaml(content) {
  // Remove all line breaks
  const withoutLineBreaks = content.replace(/\n/g, "");

  // Decode base64 to string and return yaml, or throw exception on error
  try {
    const decoded = Buffer.from(withoutLineBreaks, 'base64').toString();
    return yaml.load(decoded);
  } catch (e) {
    console.log(e)
    // create custom error for choosing correct commit status text
    const error = new Error("validating failed");
    error.name = "ValidationError";
    throw error;
  }
}

async function githubActionsCI(context, workflow_id) {
  await context.octokit.actions.createWorkflowDispatch({
    owner: context.repo().owner,
    repo: context.repo().repo,
    workflow_id: workflow_id,
    ref: context.payload.pull_request.head.ref
  });
}

async function createCommitStatus(context, sha, state, description, contextString) {
  await context.octokit.rest.repos.createCommitStatus({
    owner: context.repo().owner,
    repo: context.repo().repo,
    sha: sha,
    state: state,
    description: description,
    context: contextString
  });
}
