const logger = require('winston');
const handlebars = require('handlebars');
const packageJsonHelper = require('../helpers/package-json');
const npmHelper = require('../helpers/npm');
const yarnHelper = require('../helpers/yarn');

module.exports = {
  getParentBranch,
  ensureBranch,
};

async function getParentBranch(branchName, config) {
  // Check if branch exists
  if ((await config.api.branchExists(branchName)) === false) {
    logger.verbose(`Creating new branch ${branchName}`);
    return undefined;
  }
  logger.debug(`${branchName} already exists`);
  // Check if needs rebasing
  if (
    (config.automergeEnabled && config.automergeType === 'branch-push') ||
    config.rebaseStalePrs
  ) {
    const isBranchStale = await config.api.isBranchStale(branchName);
    if (isBranchStale) {
      logger.debug(`Branch ${branchName} is stale and needs rebasing`);
      return undefined;
    }
  }

  // Check for existing PR
  const pr = await config.api.getBranchPr(branchName);
  // Decide if we need to rebase
  if (!pr) {
    logger.debug(`No PR found for ${branchName}`);
    // We can't tell if this branch can be rebased so better not
    return branchName;
  }
  if (pr.isUnmergeable) {
    logger.debug('PR is unmergeable');
    if (pr.canRebase) {
      // Only supported by GitHub
      // Setting parentBranch back to undefined means that we'll use the default branch
      logger.debug(`Rebasing branch ${branchName}`);
      return undefined;
    }
    // Don't do anything different, but warn
    logger.verbose(`Cannot rebase branch ${branchName}`);
  }
  logger.debug(`Existing ${branchName} does not need rebasing`);
  return branchName;
}

// Ensure branch exists with appropriate content
async function ensureBranch(upgrades) {
  logger.debug(`ensureBranch(${JSON.stringify(upgrades)})`);
  // Use the first upgrade for all the templates
  const branchName = handlebars.compile(upgrades[0].branchName)(upgrades[0]);
  // parentBranch is the branch we will base off
  // If undefined, this will mean the defaultBranch
  const parentBranch = await module.exports.getParentBranch(
    branchName,
    upgrades[0]
  );
  const commitMessage = handlebars.compile(upgrades[0].commitMessage)(
    upgrades[0]
  );
  const api = upgrades[0].api;
  const cacheFolder = upgrades[0].yarnCacheFolder;
  const packageFiles = {};
  const commitFiles = [];
  for (const upgrade of upgrades) {
    if (upgrade.upgradeType === 'maintainYarnLock') {
      try {
        const newYarnLock = await yarnHelper.maintainLockFile(upgrade);
        if (newYarnLock) {
          commitFiles.push(newYarnLock);
        }
      } catch (err) {
        logger.debug(err);
        throw new Error('Could not maintain yarn.lock file');
      }
    } else {
      // See if this is the first time editing this file
      if (!packageFiles[upgrade.packageFile]) {
        // If we are rebasing then existing content will be from master
        packageFiles[upgrade.packageFile] = await api.getFileContent(
          upgrade.packageFile,
          parentBranch
        );
      }
      const newContent = packageJsonHelper.setNewValue(
        packageFiles[upgrade.packageFile],
        upgrade.depType,
        upgrade.depName,
        upgrade.newVersion
      );
      if (packageFiles[upgrade.packageFile] === newContent) {
        logger.debug('packageFile content unchanged');
        delete packageFiles[upgrade.packageFile];
      } else {
        logger.debug('Updating packageFile content');
        packageFiles[upgrade.packageFile] = newContent;
      }
    }
  }
  if (Object.keys(packageFiles).length > 0) {
    logger.debug(
      `${Object.keys(packageFiles).length} package file(s) need updating.`
    );
    for (const packageFile of Object.keys(packageFiles)) {
      logger.debug(`Adding ${packageFile}`);
      commitFiles.push({
        name: packageFile,
        contents: packageFiles[packageFile],
      });
      try {
        const yarnLockFile = await yarnHelper.getLockFile(
          packageFile,
          packageFiles[packageFile],
          api,
          cacheFolder
        );
        if (yarnLockFile) {
          // Add new yarn.lock file too
          logger.debug(`Adding ${yarnLockFile.name}`);
          commitFiles.push(yarnLockFile);
        }
      } catch (err) {
        logger.debug(err);
        throw new Error('Could not generate new yarn.lock file');
      }
      try {
        const packageLockFile = await npmHelper.getLockFile(
          packageFile,
          packageFiles[packageFile],
          api
        );
        if (packageLockFile) {
          // Add new package-lock.json file too
          logger.debug(`Adding ${packageLockFile.name}`);
          commitFiles.push(packageLockFile);
        }
      } catch (err) {
        // This will include if npm < 5
        logger.verbose(err);
        throw new Error('Could not generate new package-lock.json file');
      }
    }
  }
  if (commitFiles.length) {
    logger.debug(`Commit ${commitFiles.length} files to branch ${branchName}`);
    // API will know whether to create new branch or not
    await api.commitFilesToBranch(
      branchName,
      commitFiles,
      commitMessage,
      parentBranch
    );
  } else {
    logger.debug(`No files to commit to branch ${branchName}`);
  }
  if (!api.branchExists(branchName)) {
    // Return now if no branch exists
    return false;
  }
  const config = upgrades[0];
  if (config.automergeEnabled === false || config.automergeType === 'pr') {
    // No branch automerge
    return true;
  }
  logger.debug('Checking if we can automerge branch');
  const branchStatus = await api.getBranchStatus(branchName);
  if (branchStatus === 'success') {
    logger.info(`Automerging branch ${branchName}`);
    try {
      await api.mergeBranch(branchName, config.automergeType);
    } catch (err) {
      logger.error(`Failed to automerge branch ${branchName}`);
      logger.debug(JSON.stringify(err));
      throw err;
    }
  } else {
    logger.debug(
      `Branch status is "${branchStatus}" - skipping branch automerge`
    );
  }
  // Return true as branch exists
  return true;
}