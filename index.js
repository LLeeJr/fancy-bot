/**
 * This is the main entrypoint to your Probot app
 * @param {import('probot').Probot} app
 */
const {ProbotOctokit} = require("probot");
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
    await createCommitStatus(context, context.payload.pull_request.head.sha, "pending", "fetch yaml from branch", "custom-ci");

    // Get yaml file from pr branch and decode it
    const yaml = await context.octokit.rest.repos.getContent({
      owner: context.repo().owner,
      repo: context.repo().repo,
      path: 'ci_cd.yml',
      ref: context.payload.pull_request.head.ref
    })
        .then(result => readYaml(result.data.content))
        .catch(error => {
          return error.name;
        });

    app.log.info(`After fetching yaml: ${yaml}`);

    // differentiate between two errors
    // one for failing to fetch yaml from repo
    if (yaml === "HttpError") {
      await createCommitStatus(context, context.payload.pull_request.head.sha, "error", "failed fetching yaml from this branch", "custom-ci");
      return;
    // the other for failing to decoding or returning data as yaml
    } else if (yaml === "ValidationError") {
      await createCommitStatus(context, context.payload.pull_request.head.sha, "error", "failed validating yaml", "custom-ci");
      return;
    }

    await createCommitStatus(context, context.payload.pull_request.head.sha, "success", "succefully fetched yaml", "custom-ci");

    // Check with provider is listed in ci
    if (yaml.ci.provider === "github-actions") {
      app.log.info("chose github-actions")
      await createCommitStatus(context, context.payload.pull_request.head.sha, "pending", "starting github actions workflow", "custom-ci/github-actions");
      await githubActionsCI(context, yaml.ci.workflow_file_name);
    } else {
      app.log.info("chose custom ci")
    }

  });

  app.on("workflow_run.completed", async (context) => {
    if (context.payload.workflow_run.conclusion === "success") {
      await createCommitStatus(context, context.payload.workflow_run.head_sha, "success", "github actions workflow was successful", "custom-ci/github-actions")
    }

    app.log.info(`Conclusion: ${context.payload.workflow_run.conclusion}`)

    // TODO when CI is github actions, retrieve ci_cd.yml again and check how to do cd
  });

  // For more information on building apps:
  // https://probot.github.io/docs/

  // To get your app running against GitHub, see:
  // https://probot.github.io/docs/development/
};

function callCommand() {
  const { execSync } = require('child_process');

  return execSync('docker -v && git --version').toString();
}

function readYaml(content) {
  const yaml = require('js-yaml');

  // Remove all line breaks
  const withoutLineBreaks = content.replaceAll("\n", "");

  // Decode base64 to string and return yaml, or throw exception on error
  try {
    const decoded = atob(withoutLineBreaks);
    return yaml.load(decoded);
  } catch (e) {
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
