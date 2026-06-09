const { Octokit } = require('@octokit/rest');
const { execSync } = require('child_process');

let _octokit = null;

function getGhCliToken() {
  try {
    return execSync('gh auth token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function getOctokit() {
  if (!_octokit) {
    const token = process.env.GITHUB_TOKEN || getGhCliToken();
    if (!token) throw new Error('No GitHub token found. Set GITHUB_TOKEN or run: gh auth login');
    _octokit = new Octokit({ auth: token });
  }
  return _octokit;
}

async function getPR(owner, repo, prNumber) {
  const octokit = getOctokit();
  const { data } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  return data;
}

async function getPRFiles(owner, repo, prNumber) {
  const octokit = getOctokit();
  const files = [];
  for await (const { data } of octokit.paginate.iterator(
    octokit.pulls.listFiles,
    { owner, repo, pull_number: prNumber, per_page: 100 }
  )) {
    files.push(...data);
  }
  return files.filter(f => f.filename.endsWith('.md') && f.status !== 'removed');
}

async function getFileContent(owner, repo, filePath, ref) {
  const octokit = getOctokit();
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: filePath, ref });
    if (data.type !== 'file') throw new Error('Not a file');
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function commitChanges(owner, repo, branch, headSha, editedFiles) {
  const octokit = getOctokit();

  // Get current commit to find its tree
  const { data: currentCommit } = await octokit.git.getCommit({ owner, repo, commit_sha: headSha });

  // Create blobs for each edited file
  const blobs = await Promise.all(
    editedFiles.map(async ({ filePath, content }) => {
      const { data } = await octokit.git.createBlob({
        owner, repo,
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64',
      });
      return { path: filePath, mode: '100644', type: 'blob', sha: data.sha };
    })
  );

  // Create new tree
  const { data: newTree } = await octokit.git.createTree({
    owner, repo,
    base_tree: currentCommit.tree.sha,
    tree: blobs,
  });

  // Create commit
  const { data: newCommit } = await octokit.git.createCommit({
    owner, repo,
    message: 'docs(review): import review from business',
    tree: newTree.sha,
    parents: [headSha],
  });

  // Update branch ref
  await octokit.git.updateRef({
    owner, repo,
    ref: `heads/${branch}`,
    sha: newCommit.sha,
  });

  return newCommit.sha;
}

async function getCurrentHeadSha(owner, repo, branch) {
  const octokit = getOctokit();
  const { data } = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
  return data.object.sha;
}

module.exports = { getPR, getPRFiles, getFileContent, commitChanges, getCurrentHeadSha };
