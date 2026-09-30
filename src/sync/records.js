// What this app puts in the workspace, and how it is grouped.
//
// One model is one record. Four fields are sync-kit's whole contract — `id`,
// `updatedAt`, `deletedAt`, `origin` — and everything else on a record is
// ours and travels untouched, which is why a repository needs no change on
// the server: it is a record of its own (`idef0-repository/1`, a name and
// nothing else) and each model record carries the `repositoryId` of the one it
// is filed in. Renaming a repository is then one write rather than a rewrite
// of every model in it.
//
// `body` is the exact bytes `src/io/json.js` writes. Not a re-encoding of the
// model, not a subset: the same string the Save command puts in a file, so the
// copy in the cloud and the file on the disk are one artefact and either can
// be produced from the other. Nothing in this module touches the format.
//
// Everything here is pure: no DOM, no store, no clock of its own.

import { serialize, deserialize } from '../io/json.js';

/** The two record formats this app writes. The suffix is the version. */
export const MODEL_FORMAT = 'idef0-modeler/1';
export const REPOSITORY_FORMAT = 'idef0-repository/1';

/** The repository a first sync creates, so no model is ever filed nowhere. */
export const DEFAULT_REPOSITORY_NAME = 'My models';

/** What a model with no title is called, in the file name and in the record. */
export const UNTITLED = 'Untitled Model';

/** The bytes of a model: `serialize`, and never anything else. */
export const modelBody = (model) => serialize(model);

/**
 * A model record. `name` is the model's title, because that is what a person
 * scanning a list of models is looking for, and `repositoryId` is the grouping
 * — null for a model filed nowhere, which the grouping below shows on its own.
 */
export function modelRecord({ id, model, repositoryId = null, origin, at }) {
  return {
    id,
    type: 'document',
    format: MODEL_FORMAT,
    name: model.title?.trim() || UNTITLED,
    repositoryId: repositoryId ?? null,
    body: modelBody(model),
    updatedAt: at,
    deletedAt: null,
    origin,
  };
}

/** A repository record: a name, and nothing else. */
export function repositoryRecord({ id, name, origin, at }) {
  return {
    id,
    type: 'document',
    format: REPOSITORY_FORMAT,
    name: name?.trim() || DEFAULT_REPOSITORY_NAME,
    body: '',
    updatedAt: at,
    deletedAt: null,
    origin,
  };
}

/** A tombstone is still a row: the deletion has to travel. */
export const isAlive = (r) => !!r && r.deletedAt == null;
export const isModelRecord = (r) => r?.type === 'document' && r.format === MODEL_FORMAT;
export const isRepositoryRecord = (r) => r?.type === 'document' && r.format === REPOSITORY_FORMAT;

/**
 * Whether a record's body still reads as this app's format.
 *
 * A record whose body does not parse is not a crash and not a reason to hide
 * it: it is something to tell the modeller about, which is what the
 * `sync-body-stale` check in `checks.js` does.
 */
export function parsesAsModel(record) {
  try {
    deserialize(String(record?.body ?? ''));
    return true;
  } catch {
    return false;
  }
}

/** The name shown for a model or repository with no name of its own. */
const displayName = (r) => (String(r.name ?? '').trim() || UNTITLED);

/** Newest first, then by name, then by id: stable on every device. */
function byRecency(a, b) {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  const an = displayName(a).toLowerCase(), bn = displayName(b).toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/**
 * The workspace as a list to show: every live repository with the live models
 * filed in it, newest model first, and a last group for the models whose
 * `repositoryId` names no repository this workspace holds — a model written by
 * a device whose repository has not arrived yet, or one whose repository was
 * deleted. Those are not hidden: a model you cannot see is a model you lose.
 */
export function groupByRepository(records) {
  const all = [...(records || [])];
  const repositories = all.filter(isRepositoryRecord).filter(isAlive);
  const models = all.filter(isModelRecord).filter(isAlive);
  const known = new Set(repositories.map((r) => r.id));

  const groups = repositories
    .sort((a, b) => {
      const an = displayName(a).toLowerCase(), bn = displayName(b).toLowerCase();
      if (an !== bn) return an < bn ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    })
    .map((r) => ({
      id: r.id,
      name: displayName(r),
      repository: r,
      models: models.filter((m) => m.repositoryId === r.id).sort(byRecency),
    }));

  const loose = models.filter((m) => !m.repositoryId || !known.has(m.repositoryId)).sort(byRecency);
  if (loose.length) groups.push({ id: null, name: 'Not in a repository', repository: null, models: loose });
  return groups;
}

/** The repository ids the workspace actually holds; what the checks compare against. */
export function repositoryIds(records) {
  return (records || []).filter(isRepositoryRecord).filter(isAlive).map((r) => r.id);
}
