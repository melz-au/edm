import { useCallback, useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { api } from '../lib/api.js';

const when = (t) => new Date(t).toLocaleString();

function SaveAsDialog({ initial, onSave, onClose }) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? '');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({ name, description });
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };
  return (
    <Modal
      title="Save data model"
      subtitle="Saved in Lakebase with its proposed entities and diagram layout"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={saving || !name.trim()} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Service requests v1" autoFocus />
      </label>
      <label className="field">
        <span>Description</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this model for?" />
      </label>
      {error && <div className="error inline">{error}</div>}
    </Modal>
  );
}

function HistoryDialog({ model, onRestore, onClose }) {
  const [versions, setVersions] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.modelVersions(model.id).then(setVersions).catch((err) => setError(err.message));
  }, [model.id]);
  const restore = async (v) => {
    try {
      onRestore(await api.modelVersion(model.id, v.version));
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <Modal title={`History of ${model.name}`} subtitle="Every saved version" onClose={onClose}>
      {error && <div className="error inline">{error}</div>}
      {!versions ? (
        <p className="muted">Loading…</p>
      ) : (
        <table className="grid compact">
          <thead>
            <tr><th>Version</th><th>Saved</th><th>By</th><th className="num">Entities</th><th /></tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.version}>
                <td>v{v.version}{v.version === model.version && <span className="tag ok">current</span>}</td>
                <td>{when(v.saved_at)}</td>
                <td>{v.saved_by}</td>
                <td className="num">{v.entity_count}</td>
                <td>
                  {v.version !== model.version && (
                    <button className="btn small" onClick={() => restore(v)} title="Load this version as unsaved changes">
                      Restore
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

/**
 * Sidebar section for the data model of the current schema: proposed
 * entities, and saving, opening and versioning models in Lakebase.
 */
export default function ModelPanel({
  source,
  scope,
  canSave,
  me,
  saved,
  dirty,
  entityCount,
  getContent,
  onOpen,
  onSaved,
  onRestore,
  onClose,
  onAddEntity,
  onGenerateDdl,
  onImport,
  confirmDiscard,
}) {
  const [models, setModels] = useState([]);
  const importRef = useRef(null);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [imported, setImported] = useState(null); // { ok, message, name, description } of the last import
  const [saveAsInitial, setSaveAsInitial] = useState(null);

  const refresh = useCallback(() => {
    if (!canSave || !scope) return setModels([]);
    api.models(source, scope).then(setModels).catch((err) => setError(err.message));
  }, [canSave, source, scope]);
  useEffect(refresh, [refresh]);
  // An import message belongs to the schema it was made in.
  useEffect(() => setImported(null), [source, scope]);

  const open = async (id) => {
    if (!confirmDiscard()) return;
    setError(null);
    if (!id) return onClose();
    try {
      onOpen(await api.model(id));
    } catch (err) {
      setError(err.message);
    }
  };

  const save = async () => {
    if (!saved) return setDialog('saveAs');
    setBusy(true);
    setError(null);
    try {
      const row = await api.saveModel(saved.id, {
        name: saved.name,
        description: saved.description,
        content: getContent(),
        version: saved.version,
      });
      onSaved(row);
      refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const saveAs = async ({ name, description }) => {
    const row = await api.createModel({ name, description, source, scope, content: getContent() });
    setDialog(null);
    setSaveAsInitial(null);
    onSaved(row);
    refresh();
  };

  const remove = async () => {
    if (!window.confirm(`Delete the data model "${saved.name}" and its history? The schema itself is not changed.`)) return;
    setError(null);
    try {
      await api.deleteModel(saved.id);
      onClose();
      refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const exportJson = () => {
    const doc = { name: saved?.name ?? null, description: saved?.description ?? null, source, scope, ...getContent() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: `${(saved?.name ?? `${scope}-model`).replace(/[^\w.-]+/g, '_')}.json`,
    });
    a.click();
    URL.revokeObjectURL(url);
  };

  // Reads a model exported as JSON (here or from another schema) as unsaved changes.
  const importJson = async (file) => {
    setError(null);
    if (!file || !confirmDiscard()) return;
    try {
      const doc = JSON.parse(await file.text());
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('not a data model');
      const result = onImport(doc);
      setImported(result);
      // Go straight to saving it, so it shows in the Data model list.
      if (result.ok && canSave) {
        setSaveAsInitial({ name: result.name ?? file.name.replace(/\.json$/i, ''), description: result.description });
        setDialog('saveAs');
      }
    } catch (err) {
      setImported({ ok: false, message: `Could not import ${file.name}: ${err.message}` });
    } finally {
      if (importRef.current) importRef.current.value = '';
    }
  };

  const canDelete = saved && (me?.isSteward || saved.created_by?.toLowerCase() === (me?.user ?? '').toLowerCase());

  return (
    <section className="model-panel">
      <label className="label" htmlFor="data-model">Data model</label>
      {canSave && (
        <select id="data-model" value={saved?.id ?? ''} onChange={(e) => open(e.target.value && Number(e.target.value))}>
          <option value="">{saved ? 'Close model (schema only)' : 'Unsaved model'}</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.entity_count} proposed)
            </option>
          ))}
        </select>
      )}
      <div className="model-panel__status small">
        {saved ? (
          <>
            <strong>{saved.name}</strong> <span className="muted">v{saved.version}</span>
          </>
        ) : (
          <span className="muted">Not saved</span>
        )}
        {dirty && <span className="tag warn">unsaved changes</span>}
        <div className="muted">
          {entityCount} proposed entit{entityCount === 1 ? 'y' : 'ies'}
          {saved && ` · saved by ${saved.updated_by}, ${when(saved.updated_at)}`}
        </div>
      </div>
      <div className="model-panel__actions">
        <button className="btn small primary" onClick={onAddEntity}>+ Propose entity</button>
        {canSave && (
          <button className="btn small" disabled={busy || (saved && !dirty)} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        )}
        {canSave && (
          <button className="btn small" onClick={() => setDialog('saveAs')}>Save as…</button>
        )}
      </div>
      <div className="model-panel__links small">
        <button className="link" onClick={onGenerateDdl} disabled={!entityCount}>Generate DDL</button>
        <button className="link" onClick={exportJson}>Export JSON</button>
        <button className="link" onClick={() => importRef.current?.click()}>Import JSON</button>
        <input
          ref={importRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => importJson(e.target.files?.[0])}
          aria-label="Import a data model JSON file"
        />
        {saved && <button className="link" onClick={() => setDialog('history')}>History</button>}
        {canDelete && <button className="link danger" onClick={remove}>Delete</button>}
      </div>
      {!canSave && (
        <div className="muted small">Saving data models needs a Lakebase database connected to this app; you can still export them as JSON.</div>
      )}
      {error && <div className="error inline">{error}</div>}
      {imported && (
        <div className={imported.ok ? 'notice small model-panel__import' : 'error inline'} onClick={() => setImported(null)} title="Dismiss">
          {imported.message}
        </div>
      )}

      {dialog === 'saveAs' && (
        <SaveAsDialog
          initial={saveAsInitial ?? { name: saved ? `${saved.name} (copy)` : '', description: saved?.description }}
          onSave={saveAs}
          onClose={() => {
            setDialog(null);
            setSaveAsInitial(null);
          }}
        />
      )}
      {dialog === 'history' && saved && (
        <HistoryDialog
          model={saved}
          onRestore={(v) => {
            setDialog(null);
            onRestore(v);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}
