/**
 * This is the main entrypoint to your Probot app
 * @param {import('probot').Probot} app
 */
module.exports = (app) => {
  // Your code here
  app.log.info("Yay, the app was loaded!");

  app.log.info(callCommand())

  app.on("issues.opened", async (context) => {
    const issueComment = context.issue({
      body: "Thanks for opening this issue!",
    });
    return context.octokit.issues.createComment(issueComment);
  });

  app.on("pull_request", async (context) => {
    // check yamls for which provider should be called for testing
    app.log.info(context.payload)

    //const doc = readYaml();
  })

  app.on("workflow_run.completed", async (context) => {
    app.log.info(context.payload)
  })



  // For more information on building apps:
  // https://probot.github.io/docs/

  // To get your app running against GitHub, see:
  // https://probot.github.io/docs/development/
};

function callCommand() {
  const { execSync } = require('child_process');

  return execSync('docker -v && git --version').toString();
}

function readYaml() {
  const yaml = require('js-yaml');
  const fs   = require('fs');

// Get document, or throw exception on error
  try {
    const doc = yaml.load(fs.readFileSync('/yamls/github-actions.yml', 'utf8'));
    console.log(doc);
  } catch (e) {
    console.log(e);
  }
}
