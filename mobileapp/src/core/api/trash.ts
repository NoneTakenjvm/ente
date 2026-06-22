import type { EnteFile } from "ente-media/file";
import { batched } from "@/lib/batched";
import type { HttpClient } from "./http";

/**
 * Move files to trash on remote (Ente trash, not permanent delete).
 */
export const moveToTrash = async (
    http: HttpClient,
    files: EnteFile[],
): Promise<void> => {
    if (!files.length) {
        return;
    }

    await batched(files, async (batchFiles) => {
        await http.authFetch("/files/trash", undefined, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                items: batchFiles.map((file) => ({
                    fileID: file.id,
                    collectionID: file.collectionID,
                })),
            }),
        });
    });
};
