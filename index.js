/**
 * This is the main entrypoint to your Probot app
 * @param {import('probot').Probot} app
 */
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
    // check yamls for which provider should be called for testing
    //app.log.info(context.payload)

    const yaml = await context.octokit.rest.repos.getContent({
      owner: context.repo().owner,
      repo: context.repo().repo,
      path: 'ci_cd.yml',
      ref: context.payload.pull_request.head.ref
    })
        .then(result => readYaml(result.data.content))
        .catch(error => {
          // TODO create status with file not found or smth
          app.log.error(error);
        });

    app.log.info(yaml)

    // Check with provider is listed in ci
    if (yaml.ci.provider === "github-actions") {
      app.log.info("chose github-actions")
    } else {
      app.log.info("chose custom ci")
    }

  });

  app.on("workflow_run.completed", async (context) => {
    app.log.info(context.payload)
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

  // Decode base64 to string and return yaml as json format, or throw exception on error
  try {
    const decoded = atob(withoutLineBreaks);

    return yaml.load(decoded);
  } catch (e) {
    throw e
  }
}

function githubActionsCI() {

}
