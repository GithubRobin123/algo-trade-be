import fs from 'fs';
import path from 'path';

export interface BuildInfo {
  commit?: string;
  branch?: string;
  deployedAt?: string;
}

// Written by scripts/deploy.sh at deploy time (commit, branch, time) — null for local/dev runs
const readBuildInfo = (): BuildInfo | null => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../build-info.json'), 'utf8')) as BuildInfo;
  } catch {
    return null;
  }
};

export const buildInfo = readBuildInfo();
