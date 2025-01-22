import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { validateVaultPath } from "../../utils/path.js";
import { getAllMarkdownFiles } from "../../utils/files.js";
import { updateVaultLinks } from "../../utils/links.js";
import { createToolResponse } from "../../utils/responses.js";
import { createTool } from "../../utils/tool-factory.js";

// Input validation schema with descriptions
const schema = z.object({
    vault: z.string()
        .min(1, "Vault name cannot be empty")
        .describe("Name of the vault containing the directory"),
    path: z.string()
        .min(1, "Directory path cannot be empty")
        .refine(dirPath => !path.isAbsolute(dirPath), 
            "Directory path must be relative to vault root")
        .describe("Path of the directory to remove (relative to vault root)"),
    permanent: z.boolean()
        .optional()
        .default(false)
        .describe("Whether to permanently delete instead of moving to trash (default: false)"),
    skipLinkUpdate: z.boolean()
        .optional()
        .default(false)
        .describe("Skip updating links in other notes (default: false). Use with caution.")
}).strict();

interface RemoveDirectoryResult {
    filesRemoved: number;
    linksUpdated: number;
    movedToTrash: boolean;
    destinationPath?: string;
}

/**
 * Gets list of all Markdown files in directory
 */
async function getDirectoryContents(dirPath: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const files: string[] = [];

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                const subFiles = await getDirectoryContents(fullPath);
                files.push(...subFiles);
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                files.push(fullPath);
            }
        }

        return files;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new McpError(
                ErrorCode.InvalidRequest,
                `Directory not found: ${dirPath}`
            );
        }
        throw error;
    }
}

/**
 * Creates trash metadata for a directory
 */
async function createTrashMetadata(
    originalPath: string,
    reason?: string
): Promise<string> {
    const metadata = {
        original_path: originalPath,
        deleted_at: new Date().toISOString(),
        reason: reason || "Directory removed via remove-directory tool"
    };

    return `---
trash_info:
${Object.entries(metadata)
    .map(([key, value]) => `  ${key}: ${value}`)
    .join('\n')}
---\n\nThis directory was moved to trash.\n`;
}

/**
 * Moves a directory to trash with metadata
 */
async function moveToTrash(
    vaultPath: string,
    dirPath: string
): Promise<string> {
    const trashPath = path.join(vaultPath, ".trash");
    await fs.mkdir(trashPath, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const trashDir = path.join(
        trashPath, 
        `${path.basename(dirPath)}_${timestamp}`
    );

    // Create metadata file in trash
    const metadataContent = await createTrashMetadata(dirPath);
    const metadataPath = path.join(trashDir, ".trash_info.md");
    
    // Move directory first
    await fs.mkdir(trashDir, { recursive: true });
    await fs.rename(dirPath, trashDir);

    // Write metadata after move
    await fs.writeFile(metadataPath, metadataContent, 'utf8');

    return trashDir;
}

/**
 * Removes a directory and handles related operations
 */
async function removeDirectory(
    vaultPath: string,
    dirPath: string,
    options: {
        permanent?: boolean;
        skipLinkUpdate?: boolean;
    } = {}
): Promise<RemoveDirectoryResult> {
    const { permanent = false, skipLinkUpdate = false } = options;
    const fullPath = path.join(vaultPath, dirPath);

    // Validate path is within vault
    validateVaultPath(vaultPath, fullPath);

    try {
        // Get all markdown files first
        const files = await getDirectoryContents(fullPath);
        
        if (files.length === 0) {
            // No markdown files, handle empty directory
            if (permanent) {
                await fs.rm(fullPath, { recursive: true, force: true });
            } else {
                await moveToTrash(vaultPath, fullPath);
            }
            return {
                filesRemoved: 0,
                linksUpdated: 0,
                movedToTrash: !permanent
            };
        }

        // Update links if requested
        let totalLinksUpdated = 0;
        if (!skipLinkUpdate) {
            for (const file of files) {
                const relativePath = path.relative(vaultPath, file);
                const updatedFiles = await updateVaultLinks(vaultPath, relativePath, null);
                totalLinksUpdated += updatedFiles;
            }
        }

        // Now handle the directory
        let trashPath: string | undefined;
        if (permanent) {
            await fs.rm(fullPath, { recursive: true, force: true });
        } else {
            trashPath = await moveToTrash(vaultPath, fullPath);
        }

        return {
            filesRemoved: files.length,
            linksUpdated: totalLinksUpdated,
            movedToTrash: !permanent,
            destinationPath: trashPath
        };
    } catch (error) {
        if (error instanceof McpError) {
            throw error;
        }
        throw new McpError(
            ErrorCode.InternalError,
            `Failed to remove directory: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

/**
 * Creates formatted result message
 */
function formatResult(
    dirPath: string,
    result: RemoveDirectoryResult
): string {
    const parts: string[] = [];

    // Main action
    if (result.movedToTrash) {
        parts.push(`Moved directory to trash: ${dirPath}`);
        if (result.destinationPath) {
            parts.push(`Location: ${result.destinationPath}`);
        }
    } else {
        parts.push(`Permanently deleted directory: ${dirPath}`);
    }

    // Stats
    parts.push(`Files removed: ${result.filesRemoved}`);
    if (result.linksUpdated > 0) {
        parts.push(`Updated ${result.linksUpdated} link${result.linksUpdated === 1 ? '' : 's'} in other files`);
    }

    return parts.join('\n');
}

export function createRemoveDirectoryTool(vaults: Map<string, string>) {
    return createTool<z.infer<typeof schema>>({
        name: "remove-directory",
        description: "Remove a directory and its contents, with option to move to trash",
        schema,
        handler: async (args, vaultPath, _vaultName) => {
            const result = await removeDirectory(vaultPath, args.path, {
                permanent: args.permanent ?? false,
                skipLinkUpdate: args.skipLinkUpdate ?? false
            });
            
            return createToolResponse(formatResult(args.path, result));
        }
    }, vaults);
}