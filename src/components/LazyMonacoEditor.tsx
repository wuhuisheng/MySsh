import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";

/**
 * Renders a Monaco editor after lazily pulling in the (large) local Monaco
 * bundle. Using this instead of importing Editor eagerly keeps Monaco out of
 * the startup chunk — it is only fetched the first time a preview/editor
 * modal opens.
 */
export default function LazyMonacoEditor(props: React.ComponentProps<typeof Editor>) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    import("../monaco")
      .then(() => alive && setReady(true))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <div className="sftp-status">编辑器加载失败：{error}</div>;
  if (!ready) return <div className="sftp-status">编辑器加载中…</div>;
  return <Editor {...props} />;
}
