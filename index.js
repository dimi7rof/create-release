const core = require("@actions/core");
const github = require("@actions/github");
const { WebClient } = require("@slack/web-api");

async function run() {
  try {
    const version = core.getInput("version");
    const name = core.getInput("name");
    const webhookUrl = core.getInput("Team_webhook");
    const token = core.getInput("github-token");

    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    // Get all tags
    const { data: tags } = await octokit.rest.repos.listTags({ owner, repo });
    console.info(tags);
    console.info(JSON.stringify(tags));
    const tagExists = tags.some((tag) => tag.name === version);
    console.info(tagExists);

    if (!tagExists) {
      console.info("Creating tag");
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/tags/${version}`,
        sha: github.context.sha,
      });
    }

    // Get last two tags
    if (tags.length < 2) {
      core.setFailed("Not enough tags to generate changelog");
      return;
    }

    const { data: secondToLastTagInfo } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `tags/${tags[1].name}`,
    });
    console.info(JSON.stringify(secondToLastTagInfo));

    const { data: commitInfo } = await octokit.rest.git.getCommit({
      owner,
      repo,
      commit_sha: secondToLastTagInfo.object.sha,
    });
    console.info(JSON.stringify(commitInfo));

    const secondToLastTagDate = new Date(commitInfo.committer.date);
    console.info(secondToLastTagDate);

    const { data: pulls } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: "closed",
      per_page: 100,
    });
    console.info(JSON.stringify(pulls));

    const mergedPRs = pulls.filter(
      (pr) => pr.merged_at && new Date(pr.merged_at) > secondToLastTagDate
    ); // Only merged PRs after the second-to-last tag
    console.info(JSON.stringify(mergedPRs));

    const changeLog = mergedPRs
      .map(
        (pr) =>
          `- ${pr.title} by @${pr.user.login} in [#${pr.number}](${pr.html_url})`
      )
      .join("\n");
    console.info(changeLog);

    // Create release
    await octokit.rest.repos.createRelease({
      owner,
      repo,
      tag_name: version,
      name: `Release ${version}`,
      body: changeLog,
      draft: false,
      prerelease: false,
    });

    // Send notification if webhook is provided
    if (webhookUrl) {
      const slack = new WebClient(webhookUrl);
      await slack.chat.postMessage({
        text: `New release:\n\n*${name}:${version}*\n\n${changeLog}`,
        channel: "#team-notifications",
      });
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
