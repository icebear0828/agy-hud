const { execSync } = require('child_process');
const https = require('https');

function runCmd(cmd) {
  try {
    return execSync(cmd, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

function parseGithubUrl(url) {
  if (!url) return null;
  // Support both HTTPS and SSH format:
  // https://github.com/owner/repo.git
  // git@github.com:owner/repo.git
  let match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  return null;
}

function fetchPulls(owner, repo) {
  return new Promise((resolve, reject) => {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const headers = {
      'User-Agent': 'Node-Fetch-PRs',
    };
    if (token) {
      headers['Authorization'] = `token ${token}`;
    }
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/pulls?state=open`,
      headers
    };
    https.get(options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`GitHub API returned status ${res.statusCode}`));
        return;
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  const isGit = runCmd('git rev-parse --is-inside-work-tree') === 'true';
  if (!isGit) {
    console.error('Error: Current directory is not a git repository.');
    process.exit(1);
  }

  const remoteUrl = runCmd('git config --get remote.origin.url');
  if (!remoteUrl) {
    console.error('Error: No remote origin URL found for this git repository.');
    process.exit(1);
  }

  const parsed = parseGithubUrl(remoteUrl);
  if (!parsed) {
    console.error(`Error: Could not parse Owner/Repo from remote URL: ${remoteUrl}`);
    console.error('Currently only GitHub repositories are supported.');
    process.exit(1);
  }

  const { owner, repo } = parsed;
  console.log(`Repository: ${owner}/${repo}`);
  console.log('Fetching open Pull Requests from GitHub API...');

  try {
    const prs = await fetchPulls(owner, repo);
    if (prs.length === 0) {
      console.log('No open Pull Requests found for this repository.');
    } else {
      console.log(`Found ${prs.length} open Pull Request(s):`);
      prs.forEach((pr, i) => {
        console.log(`[#${pr.number}] ${pr.title}`);
        console.log(`  Url:  ${pr.html_url}`);
        console.log(`  User: ${pr.user.login}`);
      });
    }
  } catch (err) {
    console.error(`Failed to fetch PRs: ${err.message}`);
    console.log('\nTrying local github cli (gh) as a fallback...');
    try {
      const ghOutput = execSync('gh pr list --json number,title,htmlUrl,author --limit 30').toString().trim();
      const prs = JSON.parse(ghOutput);
      if (prs.length === 0) {
        console.log('No open Pull Requests found.');
      } else {
        console.log(`Found ${prs.length} open Pull Request(s) via gh CLI:`);
        prs.forEach(pr => {
          console.log(`[#${pr.number}] ${pr.title}`);
          console.log(`  Url:  ${pr.htmlUrl}`);
          console.log(`  User: ${pr.author ? pr.author.login : 'unknown'}`);
        });
      }
    } catch {
      console.error('gh CLI fallback failed or not installed.');
    }
  }
}

main();
