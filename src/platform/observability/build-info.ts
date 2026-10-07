import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface BuildInfo {
  schemaVersion: number;
  packageVersion: string;
  revision: string | null;
  revisionSource: string;
  trackedChanges: boolean | null;
  sourceSha256: string;
  lockSha256: string;
  compiledSha256: string;
  nodeBuildVersion: string;
}

// Read once. Never derive the running binary's identity from a checkout edited later.
const location = join(__dirname, '../../build-info.json');
const build = existsSync(location)
  ? (JSON.parse(readFileSync(location, 'utf8')) as BuildInfo)
  : null;
export function publicBuildInfo() {
  return {
    status: build ? 'BUILD_IDENTIFICADO' : 'DESENVOLVIMENTO_SEM_MANIFESTO',
    version: build?.packageVersion ?? null,
    revision: build?.revision ?? null,
    revisionSource: build?.revisionSource ?? 'INDISPONIVEL',
    trackedChangesAtBuild: build?.trackedChanges ?? null,
    sourceSha256: build?.sourceSha256 ?? null,
    compiledSha256: build?.compiledSha256 ?? null,
    lockSha256: build?.lockSha256 ?? null,
    nodeBuildVersion: build?.nodeBuildVersion ?? null,
    nodeRuntimeVersion: process.version,
  };
}
