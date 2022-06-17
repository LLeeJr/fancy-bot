/**
 * This is the main entrypoint to your Probot app
 * @param {import('probot').Probot} app
 */
// const {ProbotOctokit} = require("probot");
const fs = require("fs");
const yaml = require("js-yaml");
const { execSync } = require("child_process");
// TODO create yaml or smth
const tokenMap = new Map();

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
    const repoName = context.repo().repo;

    await createCommitStatus(context, headSha, "pending", "fetch yaml from branch", "custom-ci/pre-build");

    // Get yaml file from pr branch and decode it
    const yaml = await context.octokit.rest.repos.getContent({
      owner: context.repo().owner,
      repo: repoName,
      path: 'ci_cd.yml',
      ref: branch
    })
        .then(result => readYaml(result.data.content))
        .catch(error => error.name);

    app.log.info(`After fetching yaml: ${yaml.toString()}`);

    // differentiate between two errors
    // one for failing to fetch yaml from repo
    if (yaml === "HttpError") {
      await createCommitStatus(context, headSha, "error", "failed fetching yaml from this branch", "custom-ci/pre-build");
      return;
    // the other for failing to decoding or returning data as yaml
    } else if (yaml === "ValidationError") {
      await createCommitStatus(context, headSha, "error", "failed validating yaml", "custom-ci/pre-build");
      return;
    }

    // TODO validation of yaml

    await createCommitStatus(context, headSha, "success", "successfully fetched and validated yaml", "custom-ci/pre-build");

    // Check if a provider was chosen if not use own ci tool
    if (yaml.ci.provider === undefined) {
      app.log.info("chose custom ci");

      await createCommitStatus(context, headSha, "pending", "starting build/test process", "custom-ci/build");

      // Create Dockerfile with given data
      let token = await getInstallationToken(context);
      createDockerfile(yaml, token, branch, context.repo().owner, repoName);

      // Create Image from Dockerfile and execute build/test commands
      let result = createImageAndLog(repoName, branch);

      await createCommitStatus(context, headSha, result.state, result.description, "custom-ci/build");

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

async function getInstallationToken(context) {
  const installations = await context.octokit.rest.apps.listInstallations().then(r => r.data);

  const installation_id = installations[0].id

  let nullOrExpired = true;

  // if token exists, check if it's still valid
  if (tokenMap.get(installation_id) !== undefined) {
    // Installation token expires after one hour
    let d1 = new Date();
    let d2 = new Date(tokenMap.get(installation_id).expires_at).setMinutes(0);

    nullOrExpired = d1 > d2;
  }

  // if token doesn't exist or is expired, get new token, save it and return it
  if (nullOrExpired) {
    console.log("null or expired")
    const data = await context.octokit.rest.apps.createInstallationAccessToken({
      installation_id: installation_id
    }).then(r => r.data);

    tokenMap.set(installation_id, data)

    return data.token;
  } else {
    console.log("existing")
    return tokenMap.get(installation_id).token;
  }
}

function createDockerfile(yaml, token, branch, owner, repoName) {
  let dockerfile = `FROM node:16-slim\n`; // `FROM ${yaml.ci.language}`;
  dockerfile += "RUN apt-get update\nRUN apt-get -y install git\n"
  dockerfile += `RUN git clone --branch ${branch} https://x-access-token:${token}@github.com/${owner}/${repoName}.git\n`

  // Remove next line to force error
  dockerfile += `WORKDIR ${repoName}/\n`

  for (let step of yaml.ci.steps) {
    dockerfile += `RUN ${step}\n`;
  }

  fs.mkdirSync(`./Dockerfiles/${repoName}/${branch}`, {recursive: true});

  fs.writeFileSync(`./Dockerfiles/${repoName}/${branch}/Dockerfile`, dockerfile);
}

function createImageAndLog(repoName, branch) {
  let result, state, description;
  try {
    result = callCommand(`docker build -t ${repoName}/${branch} -f ./Dockerfiles/${repoName}/${branch}/Dockerfile .`);

    fs.writeFileSync(`./Dockerfiles/${repoName}/${branch}/log.txt`, result);

    state = "success";
    description = 'Build and tests were successfully completed';

    try {
      callCommand(`docker image rm ${repoName}/${branch}`)
    } catch (e) {
      console.log("Help! Couldn't delete docker image")
    }
  } catch (e) {
    fs.writeFileSync(`./Dockerfiles/${repoName}/${branch}/log.txt`, e.message);

    let index1 = e.message.indexOf("------", 0);
    let index2 = e.message.indexOf("------", index1 + 1);

    state = "error";
    description = `Failed building/ testing at following line: ${e.message.substring(index1 + 7, index2)}`
  }

  return {
    state: state,
    description: description
  }
}

function callCommand(command) {
  return execSync(command).toString();
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
