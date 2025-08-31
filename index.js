import { getInput, setFailed, warning } from "@actions/core";
import { getOctokit, context } from "@actions/github";
import { WebClient } from "@slack/web-api";
import { existsSync, readFileSync } from "fs";

async function run() {
  try {
    const version = getInput("version");
    const name = getInput("name");
    const webhookUrl = getInput("Team_webhook");
    const token = getInput("github-token");
    const filesInput = getInput("files");

    const octokit = getOctokit(token);
    const { owner, repo } = context.repo;

    // Get all tags
    const { data: tags } = await octokit.rest.repos.listTags({ owner, repo });
    console.info("All tags:", JSON.stringify(tags));

    // Helper to get tag date safely
    function getTagDate(tag) {
      if (tag.commit && tag.commit.committer && tag.commit.committer.date) {
        return new Date(tag.commit.committer.date);
      }
      if (tag.commit && tag.commit.author && tag.commit.author.date) {
        return new Date(tag.commit.author.date);
      }
      return null;
    }

    // Filter out tags without a valid date, then sort
    const sortedTags = tags
      .map((tag) => ({ ...tag, _tagDate: getTagDate(tag) }))
      .filter((tag) => tag._tagDate)
      .sort((a, b) => b._tagDate - a._tagDate);

    const tagExists = sortedTags.some((tag) => tag.name === version);
    console.info(`Tag ${version} exists:`, tagExists);

    if (!tagExists) {
      console.info("Creating tag");
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/tags/${version}`,
        sha: context.sha,
      });
    }

    // Get last two tags
    if (sortedTags.length < 2) {
      setFailed("Not enough tags to generate changelog");
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
        if (!existsSync(filePath)) {
          warning(`${filePath} not found, skipping attachment`);
          continue;
        }
        try {
          const fileContent = readFileSync(filePath);
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
          warning(`Could not attach ${filePath} to release`);
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
    setFailed(error.message);
    console.error("Full error:", error);
  }
}

run();
