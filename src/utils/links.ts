import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getAllMarkdownFiles } from "./files.js";
import { validateVaultPath } from "./path.js";
import { updateWikiLinks, createWikiLinkMap, WikiLinkMap } from "./wikilinks.js";

export interface LinkUpdateOptions {
    filePath: string;
    oldPath: string;
    newPath: string | null;  // Changed from optional to nullable
    isMovedToOtherVault?: boolean;
    isMovedFromOtherVault?: boolean;
    sourceVaultName?: string;
    destVaultName?: string;
}

interface LinkUpdateResult {
    updated: boolean;
    linkCount: number;
}

let cachedLinkMap: WikiLinkMap | null = null;
let lastUpdateTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Updates links in a single file
 */
export async function updateLinksInFile({
    filePath,
    oldPath,
    newPath,
    isMovedToOtherVault,
    isMovedFromOtherVault,
    sourceVaultName,
    destVaultName
}: LinkUpdateOptions): Promise<boolean> {
    try {
        const content = await fs.readFile(filePath, "utf-8");
        const oldName = path.basename(oldPath, ".md");
        
        const updatedContent = await updateWikiLinks(content, oldPath, newPath, {
            destVaultName,
            moveToOtherVault: isMovedToOtherVault
        });

        // Handle cross-vault moves if needed
        let finalContent = updatedContent;
        if (isMovedFromOtherVault && sourceVaultName && newPath) {
            finalContent = `${finalContent}\n\n> [!info] Note: Moved from ${sourceVaultName}`;
        }

        if (content !== finalContent) {
            await fs.writeFile(filePath, finalContent, "utf-8");
            return true;
        }

        return false;
    } catch (error) {
        if (error instanceof McpError) {
            throw error;
        }
        throw new McpError(
            ErrorCode.InternalError,
            `Failed to update links in file: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

/**
 * Gets or updates the cached link map
 */
async function getOrUpdateLinkMap(vaultPath: string, forceUpdate = false): Promise<WikiLinkMap> {
    const now = Date.now();
    if (
        !cachedLinkMap ||
        forceUpdate ||
        now - lastUpdateTime > CACHE_TTL
    ) {
        cachedLinkMap = await createWikiLinkMap(vaultPath);
        lastUpdateTime = now;
    }
    return cachedLinkMap;
}

/**
 * Updates all links in the vault after a note operation
 * @returns number of files updated
 */
export async function updateVaultLinks(
    vaultPath: string,
    oldPath: string | null | undefined,
    newPath: string | null | undefined,
    sourceVaultName?: string,
    destVaultName?: string
): Promise<number> {
    try {
        validateVaultPath(vaultPath, oldPath || newPath || vaultPath);

        const files = await getAllMarkdownFiles(vaultPath);
        let updatedFiles = 0;

        // Determine the type of operation
        const isMovedToOtherVault = Boolean(
            oldPath !== null && 
            newPath === null && 
            sourceVaultName && 
            destVaultName
        );
        const isMovedFromOtherVault = Boolean(
            oldPath === null && 
            newPath !== null && 
            sourceVaultName && 
            destVaultName
        );

        // Force link map update since files are changing
        await getOrUpdateLinkMap(vaultPath, true);

        for (const file of files) {
            // Skip the target file itself if it's a move operation
            if (newPath && file === path.join(vaultPath, newPath)) continue;

            try {
                const wasUpdated = await updateLinksInFile({
                    filePath: file,
                    oldPath: oldPath || "",
                    newPath: newPath || null,  // Convert undefined to null
                    isMovedToOtherVault,
                    isMovedFromOtherVault,
                    sourceVaultName,
                    destVaultName
                });

                if (wasUpdated) {
                    updatedFiles++;
                }
            } catch (error) {
                console.error(`Error updating links in ${file}:`, error);
                // Continue with other files
            }
        }

        return updatedFiles;
    } catch (error) {
        if (error instanceof McpError) {
            throw error;
        }
        throw new McpError(
            ErrorCode.InternalError,
            `Failed to update vault links: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

/**
 * Batch updates links across multiple files
 */
export async function batchUpdateLinks(
    vaultPath: string,
    updates: Array<{
        oldPath: string;
        newPath?: string;
        sourceVaultName?: string;
        destVaultName?: string;
    }>
): Promise<{ totalFiles: number; totalLinks: number }> {
    try {
        validateVaultPath(vaultPath, "");
        let totalFiles = 0;
        let totalLinks = 0;

        // Force link map update for batch operation
        await getOrUpdateLinkMap(vaultPath, true);

        // Sort updates by path depth (deepest first) to handle nested moves correctly
        const sortedUpdates = [...updates].sort((a, b) => {
            const depthA = a.oldPath.split('/').length;
            const depthB = b.oldPath.split('/').length;
            return depthB - depthA;
        });

        for (const update of sortedUpdates) {
            const filesUpdated = await updateVaultLinks(
                vaultPath,
                update.oldPath,
                update.newPath,
                update.sourceVaultName,
                update.destVaultName
            );
            totalFiles += filesUpdated;
            
            // Get affected links count from cached map
            const linkMap = await getOrUpdateLinkMap(vaultPath);
            const baseName = path.basename(update.oldPath, '.md');
            const links = linkMap[baseName] || [];
            totalLinks += links.reduce((sum, backlink) => sum + backlink.links.length, 0);
        }

        return { totalFiles, totalLinks };
    } catch (error) {
        if (error instanceof McpError) {
            throw error;
        }
        throw new McpError(
            ErrorCode.InternalError,
            `Failed to batch update links: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

/**
 * Validates and repairs broken links in the vault
 */
export async function validateVaultLinks(
    vaultPath: string
): Promise<{
    brokenLinks: number;
    repairedLinks: number;
    affectedFiles: number;
}> {
    try {
        validateVaultPath(vaultPath, "");
        let brokenLinks = 0;
        let repairedLinks = 0;
        let affectedFiles = 0;

        // Get fresh link map
        const linkMap = await getOrUpdateLinkMap(vaultPath, true);
        
        // Check each linked file
        for (const [targetFile, backlinks] of Object.entries(linkMap)) {
            const targetPath = path.join(vaultPath, `${targetFile}.md`);
            let targetExists = false;

            try {
                await fs.access(targetPath);
                targetExists = true;
            } catch {
                // Target doesn't exist
            }

            if (!targetExists) {
                // Update backlinks to mark broken links
                for (const backlink of backlinks) {
                    try {
                        const filePath = path.join(vaultPath, backlink.sourceFile);
                        let content = await fs.readFile(filePath, 'utf8');
                        let fileUpdated = false;

                        backlink.links.forEach(link => {
                            brokenLinks++;
                            // Add warning callout for broken link
                            const replacement = `${link.text}\n\n> [!warning] Broken link: Target file doesn't exist`;
                            content = content.replace(link.text, replacement);
                            repairedLinks++;
                            fileUpdated = true;
                        });

                        if (fileUpdated) {
                            await fs.writeFile(filePath, content, 'utf8');
                            affectedFiles++;
                        }
                    } catch (error) {
                        console.error(`Error repairing links in ${backlink.sourceFile}:`, error);
                    }
                }
            }
        }

        return { brokenLinks, repairedLinks, affectedFiles };
    } catch (error) {
        if (error instanceof McpError) {
            throw error;
        }
        throw new McpError(
            ErrorCode.InternalError,
            `Failed to validate vault links: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}