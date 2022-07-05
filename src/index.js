/**
 * This is the main entrypoint to your Probot app
 * @param {import('probot').Probot} app
 */
// const {ProbotOctokit} = require("probot");
const fs = require("fs");
const yaml = require("js-yaml");
const { execSync } = require("child_process");
const {Mutex} = require("async-mutex");
// const utils = require("./utils");

const tokenMap = new Map();
const yamlMap = new Map();
let cdRun = [];
let ciRunPR = new Map();
const mutex = new Mutex();

// Probot
module.exports = (app) => {
  // Your code here
  app.log.info("Yay, the app was loaded!");

  app.on("issues.opened", async (context) => {
    const issueComment = context.issue({
      body: "Thanks for opening this issue!",
    });
    return context.octokit.issues.createComment(issueComment);
  });

  app.on("push", async (context) => {
    //app.log.info(context.payload)

    const branch = context.payload.ref.split("/")[2];

    // Read yaml from main branch
    let yaml = await retrieveYaml(context, context.repo().repo);

    // if the push happened on the deploy branch then do cd
    let headSha = context.payload.after;
    if (yaml.cd.branch === branch) {
      await cd(yaml, context, headSha, branch);
    }
  })

  app.on(["pull_request.opened", "pull_request.synchronize", "pull_request.reopened"] , async (context) => {
    const headSha = context.payload.pull_request.head.sha;
    const branch = context.payload.pull_request.head.ref;
    const repoName = context.repo().repo;

    await createCommitStatus(context, headSha, "pending", "fetch yaml from branch", "custom-ci/pre-build");

    // Get yaml file from main branch and decode it
    const yaml = await retrieveYaml(context, repoName);

    app.log.info("After fetching yaml:");

    console.log(yaml)

    // differentiate between two errors
    // one for failing to fetch yaml from repo
    if (yaml === "HttpError") {
      await createCommitStatus(context, headSha, "error", "failed fetching yaml from this branch", "custom-ci/pre-build");
      return;
    // the other for failing to decoding or returning data as yaml
    } else if (yaml === "ValidationError") {
      await createCommitStatus(context, headSha, "error", "converting of yaml failed", "custom-ci/pre-build");
      return;
    }

    // Validation of yaml
    const isValid = validateYaml(yaml);

    if (!isValid) {
      await createCommitStatus(context, headSha, "error", "validation of yaml failed, please check the docs!", "custom-ci/pre-build");
      return;
    }

    // Cache the yaml
    let release = await mutex.acquire();
    try {
      yamlMap.set([context.repo().owner, repoName, branch].join('_'), yaml);
    } finally {
      release();
    }

    await createCommitStatus(context, headSha, "success", "successfully fetched and validated yaml", "custom-ci/pre-build");

    // Check if a provider was chosen if not use own ci tool
    if (yaml.ci.provider === undefined) {
      app.log.info("chose custom ci");

      await createCommitStatus(context, headSha, "pending", "starting build/test process", "custom-ci/build");

      // Create Dockerfile with given data
      let token = await getInstallationToken(context);
      createDockerfile(yaml, token, branch, context.repo().owner, repoName);

      // Create Image from Dockerfile and execute build/test commands
      let result = createImageAndLog(yaml.ci.steps, repoName, branch);
      // let result = {
      //   state: "success",
      //   description: "fake result only for dev purposes"
      // }

      await createCommitStatus(context, headSha, result.state, result.description, "custom-ci/build");

      // If ci failed, then bot creates comment on pr with part of error log
      if (result.state === "error") {
        const params = context.issue({ body: "ERROR LOG:\n" + result.log });

        await context.octokit.issues.createComment(params);

        return;
      }

      // merge pr when yaml says merge auto
      if (yaml.cd.merge === "auto") {
        await context.octokit.rest.pulls.merge({
          owner: context.repo().owner,
          repo: context.repo().repo,
          pull_number: context.payload.number
        })
      }

      return;
    }

    // Check which provider should be triggered for ci
    if (yaml.ci.provider === "github-actions") {
      app.log.info("chose github-actions")
      await createCommitStatus(context, headSha, "pending", "starting github actions workflow", "custom-ci/github-actions");
      // TODO maybe multiple workflows?
      const errorMsg = await doGithubActions(context, yaml.ci.workflow_file_name, branch).catch(error => error.message);

      if (errorMsg !== undefined) {
        const params = context.issue({body: "ERROR LOG:\n" + errorMsg});

        await context.octokit.issues.createComment(params);

        await createCommitStatus(context, headSha, "error", "something went wrong, please check error message", "custom-ci/github-actions");

        return;
      }

      release = await mutex.acquire();
      try {
        ciRunPR.set([context.repo().owner, repoName, branch, headSha].join('_'), context.payload.number);
      } finally {
        release();
      }
    }
  });

  app.on("workflow_run.completed", async (context) => {
    // TODO what happens if conclusion isn't success?
    app.log.info(`Conclusion: ${context.payload.workflow_run.conclusion}`);

    const identifier = [context.repo().owner, context.repo().repo, context.payload.workflow_run.head_branch].join('_');
    const headSha = context.payload.workflow_run.head_sha;

    let release = await mutex.acquire();
    let isCDRun = false;
    try {
      if (cdRun.indexOf(identifier) !== -1) {
        isCDRun = true;
        cdRun = cdRun.filter(entry => entry !== identifier);
      }
    } finally {
      release();
    }

    if (context.payload.workflow_run.conclusion === "success") {

      if (isCDRun) {
        await createCommitStatus(context, headSha, "success", "github actions workflow was successful", "custom-cd/github-actions");
        return;
      }

      await createCommitStatus(context, headSha, "success", "github actions workflow was successful", "custom-ci/github-actions");
    }

    // Read yaml from cache
    let yaml;
    release = await mutex.acquire();
    try {
      yaml = yamlMap.get(identifier);
    } finally {
      release();
    }

    // merge pr for which the ci run was executed
    if (yaml.cd.merge === "auto") {
      let pr;
      release = await mutex.acquire();
      try {
        pr = ciRunPR.get([identifier, headSha].join('_'));
      } finally {
        release();
      }

      await context.octokit.rest.pulls.merge({
        owner: context.repo().owner,
        repo: context.repo().repo,
        pull_number: pr
      }).then(async _ => {
        release = await mutex.acquire();
        try {
          ciRunPR.delete([identifier, headSha].join('_'));
        } finally {
          release();
        }
      })
    }
  });
};

// Utilities
const createCatFile = (email, apiKey) => `cat >~/.netrc <<EOF
machine api.heroku.com
    login ${email}
    password ${apiKey}
machine git.heroku.com
    login ${email}
    password ${apiKey}
EOF`;

const addRemote = (appName) => {
  execSync("heroku git:remote -a " + appName);
  execSync("git push heroku main")
}

async function retrieveYaml(context, repoName) {
  return await context.octokit.rest.repos.getContent({
    owner: context.repo().owner,
    repo: repoName,
    path: 'ci_cd.yml'
  })
      .then(result => readYaml(result.data.content))
      .catch(error => error.name);
}

async function getGithubSecret(context, heroku_api_key_secret_name) {
  return await context.octokit.rest.actions.getRepoSecret({
    owner: context.repo().owner,
    repo: context.repo().repo,
    secret_name: heroku_api_key_secret_name
  }).then(result => console.log("result")).catch(error => console.error(error))
}

async function cd(yaml, context, headSha, branch) {
  const provider = yaml.cd.provider;

  // deploy to heroku
  if (provider === undefined) {
    console.log("chose custom cd");

    //let secret = await getGithubSecret(context, yaml.cd.heroku_secret);

    // execSync(createCatFile(yaml.cd.heroku_email, secret));

    return;
  }

  // Check which provider should be triggered for cd
  if (yaml.cd.provider === "github-actions") {
    console.log("chose github-actions for cd");

    const release = await mutex.acquire();
    try {
      cdRun.push([context.repo().owner, context.repo().repo, branch].join('_'));
    } finally {
      release()
    }

    await createCommitStatus(context, headSha, "pending", "starting github actions workflow", "custom-cd/github-actions");

    const errorMsg = await doGithubActions(context, yaml.cd.workflow_file_name, branch).catch(error => error.message);

    if (errorMsg !== undefined) {
      const params = context.issue({body: "ERROR LOG:\n" + errorMsg});

      await context.octokit.issues.createComment(params);

      await createCommitStatus(context, headSha, "error", "something went wrong, please check error message", "custom-cd/github-actions");
    }
  }
}

async function getInstallationToken(context) {
  const installations = await context.octokit.rest.apps.listInstallations().then(r => r.data);

  console.log(installations);

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

    const release = await mutex.acquire();
    try {
      tokenMap.set(installation_id, data)
    } finally {
      release()
    }

    return data.token;
  } else {
    console.log("existing")
    return tokenMap.get(installation_id).token;
  }
}

function createDockerfile(yaml, token, branch, owner, repoName) {
  let dockerfile = `FROM ${yaml.ci.language}\n`;
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

function createImageAndLog(steps, repoName, branch) {
  let state, description, log;

  try {
    callCommand(`docker build -t ${repoName}/${branch} -f ./Dockerfiles/${repoName}/${branch}/Dockerfile .`, getLogOptions(repoName, branch));

    state = "success";
    description = 'Build and tests were successfully completed';
    try {
      callCommand(`docker image rm ${repoName}/${branch}`, {});
    } catch (e) {
      console.log("Help! Couldn't delete docker image");
    }
  } catch (e) {
    const errLog = fs.readFileSync(`./Dockerfiles/${repoName}/${branch}/err.log`, 'utf8');

    const outLog = fs.readFileSync(`./Dockerfiles/${repoName}/${branch}/out.log`, 'utf8')

    // Search for which step failed
    let stepIndex = -1;
    let stringIndex = -1;
    for (let step of steps) {
      if (outLog.indexOf(step) !== -1) {
        stepIndex++;
        stringIndex = outLog.indexOf(step);
      } else {
        break;
      }
    }

    const outLogShortened = outLog.substring(stringIndex + steps[stepIndex].length);

    log = errLog + outLogShortened;
    state = "error";
    description = `Failed building/ testing. See log comment for more details`;
  }

  return {
    state: state,
    description: description,
    log: log,
  }
}

function getLogOptions(repoName, branch) {
  return {stdio: [
    0,
    fs.openSync(`./Dockerfiles/${repoName}/${branch}/out.log`, 'w'),
    fs.openSync(`./Dockerfiles/${repoName}/${branch}/err.log`, 'w')
  ]
  }
}

function callCommand(command, logOptions) {
  return execSync(command, logOptions);
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

async function doGithubActions(context, workflow_id, branch) {
  await context.octokit.actions.createWorkflowDispatch({
    owner: context.repo().owner,
    repo: context.repo().repo,
    workflow_id: workflow_id,
    ref: branch
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

function validateYaml(yaml) {
  try {
    // check ci part
    // requirements for own ci
    if (yaml.ci.provider === undefined) {
      if (yaml.ci.language === undefined || yaml.ci.steps === undefined) {
        return false;
      }
      // github actions requirements
    } else if (yaml.ci.provider === "github-actions") {
      if (yaml.ci.workflow_file_name === undefined) {
        return false;
      }
    }

    // check cd part
    if (yaml.cd.branch === undefined) {
      return false;
    }

    // if merge option isn't undefined, then it should only equal auto or manual, if not merge option isn't valid
    if (yaml.cd.merge !== undefined && (yaml.cd.merge !== "auto" || yaml.cd.merge !== "manual")) {
      return false;
    }

    // requirements for own cd
    if (yaml.cd.provider === undefined) {
      if (yaml.cd.heroku_secret === undefined || yaml.cd.heroku_mail === undefined || yaml.cd.heroku_app === undefined) {
        return false;
      }
      // github actions requirements
    }else if (yaml.ci.provider === "github actions") {
      if (yaml.ci.workflow_file_name === undefined) {
        return false;
      }
    }
  } catch (e) {
    return false
  }

  return true;
}
