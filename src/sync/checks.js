// Two checks about the copy in the workspace, merged into the Checks panel.
//
// Why they are here and not in `src/model/validate.js`: that file is mirrored
// byte for byte by `macos/Sources/IDEF0Core/Validate.swift` and pinned by the
// golden fixtures, so a rule added there has to be added twice and moves a
// golden. Neither of these rules is about the model — both are about this
// browser's relationship with a server the Swift port does not talk to yet
// (wave C) — so they are web-only checks that the Checks panel merges in, and
// the shared validator is left exactly as it was. When the Mac app grows a
// sync client, these two rules move into the shared validator together, in one
// pass that regenerates the goldens on purpose.
//
// The issues have the same shape as the validator's, because the panel renders
// them with the same code: { severity, code, message, diagramId, kind, id }.
// The voice is the validator's too — a full sentence saying what is wrong and
// what to do about it.

/**
 * `snapshot` is what `src/sync/index.js` knows after the last sync:
 *
 *   enabled        whether this browser syncs at all (nothing to say if not)
 *   repositoryIds  the live repositories the workspace holds
 *   repositoryId   the repository the current model is filed in, or null
 *   stale          records whose body does not read as an IDEF0 model,
 *                  as { id, name, origin }
 */
export function syncIssues(snapshot) {
  const s = snapshot || {};
  if (!s.enabled) return [];
  const issues = [];
  const known = new Set(s.repositoryIds || []);

  if (s.repositoryId && !known.has(s.repositoryId)) {
    issues.push(issue('sync-repository-unknown',
      `This model is filed in a repository this workspace does not hold (${s.repositoryId}). `
      + 'Sync again to fetch that repository, or file the model somewhere that exists with File ▸ Move to repository….'));
  }

  for (const record of s.stale || []) {
    const name = String(record.name ?? '').trim() || 'a model';
    const who = record.origin ? ` (last written by device ${record.origin})` : '';
    issues.push(issue('sync-body-stale',
      `The copy of “${name}” in the workspace does not read as an IDEF0 model${who}. `
      + 'Open it to see what is there before you overwrite it, or save this model over it once you know the work is safe.'));
  }

  return issues;
}

const issue = (code, message) => ({ severity: 'warning', code, message, diagramId: null, kind: null, id: null });
