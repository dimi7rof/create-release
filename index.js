import { getInput, setFailed, warning } from "@actions/core";
import { getOctokit, context } from "@actions/github";
import https from "https";
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

    // Ensure all tags have commit info (fetch if missing)
    async function enrichTagWithCommit(tag) {
      if (tag.commit) return tag;
      try {
        const commitSha = tag.commit ? tag.commit.sha : tag.sha || tag.name;
        const { data: commit } = await octokit.rest.git.getCommit({
          owner,
          repo,
          commit_sha: commitSha,
        });
        return { ...tag, commit };
      } catch (e) {
        console.warn(
          `Could not fetch commit info for tag '${tag.name}'. commit_sha: ${
            tag.commit ? tag.commit.sha : tag.sha || tag.name
          }`
        );
        console.warn(`Error: ${e.message}`);
        return null;
      }
    }

    // Fetch commit info for tags missing it
    const tagsWithCommits = [];
    for (const tag of tags) {
      console.info("Tag:", JSON.stringify(tag));
      if (tag.commit) {
        tagsWithCommits.push(tag);
      } else {
        const enriched = await enrichTagWithCommit(tag);
        if (enriched) tagsWithCommits.push(enriched);
        console.info("Enriched:", JSON.stringify(enriched));
      }
    }

    // Now filter and sort as before
    const sortedTags = tagsWithCommits
      .map((tag) => ({ ...tag, _tagDate: getTagDate(tag) }))
      .filter((tag) => tag._tagDate)
      .sort((a, b) => b._tagDate - a._tagDate);
    console.info("Sorted Tags:", JSON.stringify(sortedTags));

    const tagExists = tags.some((tag) => tag.name === version);
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

    let secondToLastTagSha = null;
    let secondToLastTagDate = null;
    if (sortedTags.length >= 2) {
      // Get the commit SHA for the second-to-last tag
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
      secondToLastTagDate = new Date(commitInfo.commit.committer.date);
      console.info("Second to last tag date:", secondToLastTagDate);
    }

    let changeLog = "";
    if (!sortedTags.length) {
      setFailed("No valid tags with commit information found.");
      return;
    }
    const lastTagSha = sortedTags[0].commit && sortedTags[0].commit.sha;
    if (!lastTagSha) {
      setFailed("Latest tag does not have a commit SHA.");
      return;
    }
    if (secondToLastTagDate) {
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
              `- ${
                commit.commit.message.split("\n")[0]
              } (${commit.sha.substring(0, 7)})`
          )
          .join("\n");
        console.info("Changelog (commits):", changeLog);
      }
    } else {
      // Only one valid tag, use all commits up to that tag
      const { data: commits } = await octokit.rest.repos.listCommits({
        owner,
        repo,
        sha: lastTagSha,
      });
      changeLog = commits
        .map(
          (commit) =>
            `- ${commit.commit.message.split("\n")[0]} (${commit.sha.substring(
              0,
              7
            )})`
        )
        .join("\n");
      console.info("Changelog (commits, single tag):", changeLog);
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

    // Send notification if webhook is provided (Microsoft Teams)
    if (webhookUrl) {
      const teamsPayload = JSON.stringify({
        "@type": "MessageCard",
        "@context": "http://schema.org/extensions",
        summary: `New release: ${name} ${version}`,
        themeColor: "0076D7",
        title: `New release: ${name} ${version}`,
        text: changeLog || "No changelog available.",
      });
      const url = new URL(webhookUrl);
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(teamsPayload),
        },
      };
      await new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
          res.on("data", () => {});
          res.on("end", resolve);
        });
        req.on("error", reject);
        req.write(teamsPayload);
        req.end();
      });
      console.info("Teams notification sent.");
    }
  } catch (error) {
    setFailed(error.message);
    console.error("Full error:", error);
  }
}

run();
