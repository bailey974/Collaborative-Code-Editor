import * as Y from "yjs";

export function normalizePath(p?: string | null) {
  return (p ?? "").replaceAll("\\", "/");
}

export function getFilesMap(doc: Y.Doc) {
  return doc.getMap<Y.Text>("files");
}

export function getOrCreateYText(doc: Y.Doc, filePath: string) {
  const files = getFilesMap(doc);
  const key = normalizePath(filePath);

  let ytext = files.get(key);
  if (!ytext) {
    ytext = new Y.Text();
    files.set(key, ytext);
  }
  return ytext;
}
