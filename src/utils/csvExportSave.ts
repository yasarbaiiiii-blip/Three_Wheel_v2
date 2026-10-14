/**
 * Save exported CSV text where the operator can find it.
 *
 * Android: the system folder picker (Storage Access Framework) — the operator picks e.g.
 * Download once per app session and later exports reuse it. Elsewhere: the app's document
 * directory.
 */

import { Platform } from "react-native";
import * as FileSystem from "expo-file-system/legacy";

export type SavedCsvFile = { fileName: string; uri: string };

export type SaveCsvResult =
  | { status: "saved"; files: SavedCsvFile[]; location: string }
  | { status: "cancelled" };

/** Folder the operator granted this session (SAF tree URI). */
let grantedDirUri: string | null = null;

async function writeSaf(dirUri: string, fileName: string, text: string): Promise<string> {
  // SAF adds the extension from the MIME type, so pass the bare name.
  const uri = await FileSystem.StorageAccessFramework.createFileAsync(
    dirUri,
    fileName.replace(/\.csv$/i, ""),
    "text/csv"
  );
  await FileSystem.writeAsStringAsync(uri, text, { encoding: FileSystem.EncodingType.UTF8 });
  return uri;
}

function folderLabel(dirUri: string): string {
  // content://…/tree/primary%3ADownload → "Download"
  const tail = decodeURIComponent(dirUri.split("/tree/")[1] ?? "");
  return tail.split(":").pop() || "the chosen folder";
}

export async function saveCsvFiles(
  files: { fileName: string; text: string }[]
): Promise<SaveCsvResult> {
  if (Platform.OS === "android") {
    const tryWrite = async (dirUri: string) => {
      const out: SavedCsvFile[] = [];
      for (const f of files) out.push({ fileName: f.fileName, uri: await writeSaf(dirUri, f.fileName, f.text) });
      return out;
    };
    if (grantedDirUri) {
      try {
        return { status: "saved", files: await tryWrite(grantedDirUri), location: folderLabel(grantedDirUri) };
      } catch {
        // Permission revoked or folder gone — ask again below.
        grantedDirUri = null;
      }
    }
    const perm = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!perm.granted) return { status: "cancelled" };
    grantedDirUri = perm.directoryUri;
    return { status: "saved", files: await tryWrite(perm.directoryUri), location: folderLabel(perm.directoryUri) };
  }

  const dir = FileSystem.documentDirectory;
  if (!dir) throw new Error("No writable storage on this device.");
  const out: SavedCsvFile[] = [];
  for (const f of files) {
    const uri = `${dir}${f.fileName}`;
    await FileSystem.writeAsStringAsync(uri, f.text, { encoding: FileSystem.EncodingType.UTF8 });
    out.push({ fileName: f.fileName, uri });
  }
  return { status: "saved", files: out, location: "app documents" };
}
