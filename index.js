const core = require("@actions/core");
const github = require("@actions/github");
const { WebClient } = require("@slack/web-api");
const fs = require("fs");

async function run() {
  try {
    const version = core.getInput("version");
    const name = core.getInput("name");
    const webhookUrl = core.getInput("Team_webhook");
    const token = core.getInput("github-token");
    const filesInput = core.getInput("files");

    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    // Get all tags
    const { data: tags } = await octokit.rest.repos.listTags({ owner, repo });
    console.info("All tags:", JSON.stringify(tags));

    // Sort tags by date (descending) to ensure correct order
    const sortedTags = tags.sort(
      (a, b) =>
        new Date(b.commit.committer.date) - new Date(a.commit.committer.date)
    );

    const tagExists = sortedTags.some((tag) => tag.name === version);
    console.info(`Tag ${version} exists:`, tagExists);

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
    if (sortedTags.length < 2) {
      core.setFailed("Not enough tags to generate changelog");
      return;
    }

    // Get the commit SHA for the second-to-last tag
    let secondToLastTagSha;
    const secondToLastTag = sortedTags[1];

    try {
      // First try to get the tag object (for annotated tags)
      const { data: tagObject } = await octokit.rest.git.getTag({
        owner,
        repo,
        tag_sha: secondToLastTag.commit.sha,
      });
      secondToLastTagSha = tagObject.object.sha;
    } catch (error) {
      // If that fails, it's probably a lightweight tag - use the commit SHA directly
      console.info("Tag is not annotated, using commit SHA directly");
      secondToLastTagSha = secondToLastTag.commit.sha;
    }

    // Get the commit information
    const { data: commitInfo } = await octokit.rest.repos.getCommit({
      owner,
      repo,
      ref: secondToLastTagSha,
    });

    const secondToLastTagDate = new Date(commitInfo.commit.committer.date);
    console.info("Second to last tag date:", secondToLastTagDate);

    // Get merged PRs since the second-to-last tag
    const { data: pulls } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: 100,
    });

    const mergedPRs = pulls.filter(
      (pr) => pr.merged_at && new Date(pr.merged_at) > secondToLastTagDate
    );
    console.info("Merged PRs since last tag:", JSON.stringify(mergedPRs));

    let changeLog = "";
    if (mergedPRs.length > 0) {
      changeLog = mergedPRs
        .map(
          (pr) =>
            `- ${pr.title} by @${pr.user.login} in [#${pr.number}](${pr.html_url})`
        )
        .join("\n");
      console.info("Changelog (PRs):", changeLog);
    } else {
      // No merged PRs, use commit messages between the last two tags
      const lastTagSha = sortedTags[0].commit.sha;
      const prevTagSha = secondToLastTagSha;
      // Get commits between prevTagSha (exclusive) and lastTagSha (inclusive)
      const { data: commits } = await octokit.rest.repos.compareCommits({
        owner,
        repo,
        base: prevTagSha,
        head: lastTagSha,
      });
      changeLog = commits.commits
        .map(
          (commit) =>
            `- ${commit.commit.message.split("\n")[0]} (${commit.sha.substring(
              0,
              7
            )})`
        )
        .join("\n");
      console.info("Changelog (commits):", changeLog);
    }

    // Create release
    const { data: release } = await octokit.rest.repos.createRelease({
      owner,
      repo,
      tag_name: version,
      name: `Release ${version}`,
      body: changeLog,
      draft: false,
      prerelease: false,
    });

    // Attach files if provided
    if (filesInput) {
      // Support comma or newline separated list
      const files = filesInput
        .split(/[,\n]/)
        .map((f) => f.trim())
        .filter(Boolean);
      for (const filePath of files) {
        if (!fs.existsSync(filePath)) {
          core.warning(`${filePath} not found, skipping attachment`);
          continue;
        }
        try {
          const fileContent = fs.readFileSync(filePath);
          await octokit.rest.repos.uploadReleaseAsset({
            owner,
            repo,
            release_id: release.id,
            name: require("path").basename(filePath),
            data: fileContent,
          });
          console.info(`${filePath} attached to release`);
        } catch (error) {
          console.error(`Failed to attach ${filePath}:`, error.message);
          core.warning(`Could not attach ${filePath} to release`);
        }
      }
    }

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
    console.error("Full error:", error);
  }
}

run();
