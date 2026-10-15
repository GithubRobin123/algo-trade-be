import fs from 'fs';
import path from 'path';
import { Router } from 'express';

const router = Router();

// Written by scripts/deploy.sh at deploy time (commit, branch, time) — null for local/dev runs
const readBuildInfo = (): Record<string, unknown> | null => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../build-info.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};
const buildInfo = readBuildInfo();

router.get('/', (_req, res) => {
  res.json({
    success: true,
    status: 'ok',
    timestamp: new Date().toISOString(),
    build: buildInfo,
  });
});

export default router;
