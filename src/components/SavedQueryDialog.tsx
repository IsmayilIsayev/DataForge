import { useEffect, useState } from "react";
import { looksLikeSecret, newSavedId } from "../savedQueries";
import { useAppStore } from "../store";
import type { SavedQuery, SavedQueryFolder } from "../types";

interface Props {
  query: SavedQuery | null;
  sql: string;
  defaultConnId: string | null;
  defaultDatabase: string | null;
  onClose: () => void;
  onSaved: (query: SavedQuery, newFolder?: SavedQueryFolder) => void;
}

const NEW_FOLDER = "__new__";

export default function SavedQueryDialog({
  query,
  sql,
  defaultConnId,
  defaultDatabase,
  onClose,
  onSaved,
}: Props) {
  const connections = useAppStore((state) => state.connections);
  const folders = useAppStore((state) => state.savedQueries.folders);

  const [name, setName] = useState(query?.name ?? "");
  const [description, setDescription] = useState(query?.description ?? "");
  const [folderId, setFolderId] = useState(query?.folder_id ?? "");
  const [newFolderName, setNewFolderName] = useState("");
  const [connId, setConnId] = useState(
    query?.conn_id ?? defaultConnId ?? "",
  );
  const [database, setDatabase] = useState(
    query?.database ?? defaultDatabase ?? "",
  );
  const [error, setError] = useState<string | null>(null);

  const activeSql = query?.sql ?? sql;
  const secretWarning = looksLikeSecret(activeSql);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("A name is required.");
      return;
    }

    let nextFolderId = folderId || undefined;
    let newFolder: SavedQueryFolder | undefined;
    if (folderId === NEW_FOLDER) {
      const folderName = newFolderName.trim();
      if (!folderName) {
        setError("A folder name is required.");
        return;
      }
      const existing = folders.find(
        (folder) => folder.name.toLowerCase() === folderName.toLowerCase(),
      );
      if (existing) {
        nextFolderId = existing.id;
      } else {
        newFolder = {
          id: newSavedId("f"),
          name: folderName,
          created_at: Date.now(),
        };
        nextFolderId = newFolder.id;
      }
    }

    const now = Date.now();
    onSaved(
      {
        id: query?.id ?? newSavedId("q"),
        name: trimmedName,
        description: description.trim() || undefined,
        folder_id: nextFolderId,
        sql: activeSql,
        conn_id: connId || undefined,
        database: connId ? database.trim() || undefined : undefined,
        created_at: query?.created_at ?? now,
        updated_at: now,
      },
      newFolder,
    );
  };

  return (
    <>
      <div
        onMouseDown={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 70, background: "var(--ov)" }}
      />
      <div
        style={{
          position: "fixed",
          left: "50%",
          top: "30%",
          transform: "translate(-50%, -30%)",
          zIndex: 71,
          width: 460,
          maxWidth: "92vw",
          maxHeight: "80vh",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: 16,
          background: "var(--sf)",
          border: "1px solid var(--bd2)",
          borderRadius: 8,
          boxShadow: "var(--sh)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <i
            className="icon-bookmark"
            style={{ fontSize: 15, color: "var(--ac)" }}
          />
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            {query ? "Edit saved query" : "Save query"}
          </span>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 11.5, color: "var(--mu)" }}>Name</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Query name"
            spellCheck={false}
            style={inputStyle}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 11.5, color: "var(--mu)" }}>Folder</span>
          <select
            value={folderId}
            onChange={(event) => setFolderId(event.target.value)}
            style={inputStyle}
          >
            <option value="">No folder</option>
            {folders
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            <option value={NEW_FOLDER}>New folder…</option>
          </select>
        </label>

        {folderId === NEW_FOLDER && (
          <input
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            placeholder="New folder name"
            spellCheck={false}
            style={inputStyle}
          />
        )}

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 11.5, color: "var(--mu)" }}>
            Description (optional)
          </span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What is this query for?"
            rows={2}
            style={{ ...inputStyle, height: "auto", padding: "6px 8px", resize: "vertical" }}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 11.5, color: "var(--mu)" }}>
            Connection (optional)
          </span>
          <select
            value={connId}
            onChange={(event) => {
              setConnId(event.target.value);
              if (!event.target.value) setDatabase("");
            }}
            style={inputStyle}
          >
            <option value="">Not linked</option>
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 11.5, color: "var(--mu)" }}>
            Database (optional)
          </span>
          <input
            value={database}
            onChange={(event) => setDatabase(event.target.value)}
            placeholder="Database name"
            spellCheck={false}
            disabled={!connId}
            style={{ ...inputStyle, opacity: connId ? 1 : 0.55 }}
          />
        </label>

        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--mu)",
            padding: "6px 8px",
            background: "var(--bg)",
            border: "1px solid var(--bd)",
            borderRadius: 4,
            maxHeight: 70,
            overflow: "hidden",
            whiteSpace: "pre-wrap",
          }}
        >
          {activeSql.length > 320
            ? `${activeSql.slice(0, 320)}…`
            : activeSql || "Empty query"}
        </div>

        {secretWarning && (
          <div
            style={{
              display: "flex",
              gap: 6,
              padding: "7px 9px",
              borderRadius: 4,
              background: "var(--zb)",
              border: "1px solid var(--wn)",
              color: "var(--wn)",
              fontSize: 11.5,
              lineHeight: 1.45,
            }}
          >
            <i className="icon-triangle-alert" style={{ fontSize: 13, flex: "none" }} />
            <span>
              This query looks like it contains a password or secret. Saved
              queries are stored as plain text in the app config folder.
            </span>
          </div>
        )}

        {error && (
          <div style={{ color: "var(--er)", fontSize: 11.5 }}>{error}</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="v2-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="v2-btn v2-btn-primary"
            onClick={save}
          >
            {query ? "Save changes" : "Save query"}
          </button>
        </div>
      </div>
    </>
  );
}

const inputStyle = {
  width: "100%",
  height: 28,
  padding: "0 8px",
  border: "1px solid var(--bd2)",
  borderRadius: 4,
  background: "var(--bg)",
  color: "var(--tx)",
  fontSize: 12.5,
};
