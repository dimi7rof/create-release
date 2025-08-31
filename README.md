# GitHub Release & Notification Action

This GitHub Action automates the process of creating releases for your repository. It can be triggered by a tag push or manually via workflow dispatch. The action will:

- Create a release for a specified tag (and create the tag if triggered manually)
- Generate a changelog from merged PRs or commit messages between tags
- Attach specified files to the release (optional)
- Send a Microsoft Teams notification if a webhook is provided
- Handle edge cases like missing tags or PRs, always providing a changelog

## Inputs

- `version` (required): Release version
- `name` (required): Project name
- `Team_webhook` (optional): Microsoft Teams webhook URL
- `github-token` (required): GitHub token
- `files` (optional): Comma-separated list of files to attach to the release

## Example Usage

```yaml
- uses: dimi7rof/create-release@v3
  with:
    version: ${{ github.ref_name }}
    name: MyProject
    github-token: ${{ secrets.GITHUB_TOKEN }}
    files: "dist/app.zip,docs/readme.pdf"
    Team_webhook: ${{ secrets.TEAMS_WEBHOOK }}
```

## Notes

- If no PRs are merged between the last two tags, commit messages will be used for the changelog.
- Teams notification is sent only if `Team_webhook` is provided.
