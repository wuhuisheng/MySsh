import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { api } from "../services/ipc";
import type { EditableFile } from "../types";

interface Props {
  sessionId: string;
  path: string;
  onClose: () => void;
  onSaved: () => void;
  onToast: (text: string, kind?: "info" | "error") => void;
}

/** Full editor modal with Ctrl/Cmd+S save back to the remote file. */
export default function FileEditorModal({ sessionId, path, onClose, onSaved, onToast }: Props) {
  const [file, setFile] = useState<EditableFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const contentRef = useRef("");
  const savingRef = useRef(false);
  const dirtyRef = useRef(false);

  useEffect(() => {
    let alive = true;
    setFile(null);
    setError(null);
    setContent("");
    setDirty(false);
    api
      .sftpReadForEdit(sessionId, path)
      .then((f) => {
        if (!alive) return;
        setFile(f);
        setContent(f.content);
        contentRef.current = f.content;
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [sessionId, path]);

  const save = useCallback(async () => {
    if (savingRef.current || !dirtyRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await api.sftpSaveFile(sessionId, path, contentRef.current);
      dirtyRef.current = false;
      setDirty(false);
      onToast("已保存 " + path);
      onSaved();
    } catch (e) {
      onToast(String(e), "error");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [sessionId, path, onSaved, onToast]);

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
  };

  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const close = () => {
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={() => close()}>
      <div className="modal modal-lg" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <strong>
              编辑{dirty ? " •" : ""}
            </strong>
            <span className="muted" title={path}>
              {path}
            </span>
          </div>
          <div className="modal-actions">
            <button className="btn btn-primary" disabled={!dirty || saving} onClick={save}>
              {saving ? "保存中…" : "保存 ⌘S"}
            </button>
            <button className="btn btn-icon" onClick={() => close()}>
              ✕
            </button>
          </div>
        </div>

        <div className="modal-body">
          {error && <div className="sftp-error">{error}</div>}
          {!error && !file && <div className="sftp-status">加载中…</div>}
          {file && (
            <Editor
              height="100%"
              language={file.language}
              value={content}
              theme="vs-dark"
              onMount={onMount}
              onChange={(v) => {
                const nv = v ?? "";
                contentRef.current = nv;
                setContent(nv);
                const d = nv !== file.content;
                dirtyRef.current = d;
                setDirty(d);
              }}
              options={{
                minimap: { enabled: true },
                fontSize: 13,
                automaticLayout: true,
                wordWrap: "off",
                scrollBeyondLastLine: false,
                tabSize: 4,
                insertSpaces: false,
              }}
            />
          )}
        </div>

        {confirmDiscard && (
          <div className="modal-backdrop" onMouseDown={() => setConfirmDiscard(false)}>
            <div className="modal modal-sm" onMouseDown={(e) => e.stopPropagation()}>
              <h3>放弃未保存的修改？</h3>
              <p className="muted">{path} 还有未保存的修改。</p>
              <div className="modal-actions">
                <button className="btn" onClick={() => setConfirmDiscard(false)}>
                  继续编辑
                </button>
                <button className="btn btn-danger" onClick={onClose}>
                  放弃并关闭
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
