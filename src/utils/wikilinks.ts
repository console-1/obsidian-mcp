import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getAllMarkdownFiles } from "./files.js";
import { validateVaultPath } from "./path.js";

// Core interfaces for wikilink handling
export interface WikiLink {
    text: string;          // Original link text including brackets
    target: string;        // Link target (file or heading)
    alias?: string;        // Display alias if specified
    line: number;          // Line number in source file
    context: string;       // Full line containing the link
    isHeading?: boolean;   // Whether this links to a specific heading
    heading?: string;      // The heading being linked to
}

export interface Backlink {
    sourceFile: string;    // File containing the link
    links: WikiLink[];     // All links to the target in this file
}

export interface WikiLinkMap {
    [targetFile: string]: Backlink[];
}

// Regular expressions for different link formats
const WIKI_LINK_REGEX = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const HEADING_LINK_REGEX = /\[\[([^\]|#]+)#([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const EMBEDDED_LINK_REGEX = /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/**
 * Finds all wikilinks in content with context
 */
export async function findWikiLinks(content: string, filePath: string): Promise<WikiLink[]> {
    const lines = content.split('\n');
    const links: WikiLink[] = [];

    lines.forEach((line, index) => {
        // Find heading links first (more specific)
        let match: RegExpExecArray | null;
        
        // Find heading links first (more specific)
        while ((match = HEADING_LINK_REGEX.exec(line)) !== null) {
            const [fullMatch, target, heading, alias] = match;
            links.push({
                text: fullMatch,
                target,
                heading,
                alias,
                line: index + 1,
                context: line.trim(),
                isHeading: true
            });
        }

        // Reset regex state
        HEADING_LINK_REGEX.lastIndex = 0;

        // Find regular wikilinks
        while ((match = WIKI_LINK_REGEX.exec(line)) !== null) {
            const [fullMatch, target, alias] = match;
            // Skip if it's already been captured as a heading link
            if (!links.some(link => link.text === fullMatch)) {
                links.push({
                    text: fullMatch,
                    target,
                    alias,
                    line: index + 1,
                    context: line.trim(),
                    isHeading: false
                });
            }
        }

        // Reset regex state
        WIKI_LINK_REGEX.lastIndex = 0;

        // Find embedded links
        while ((match = EMBEDDED_LINK_REGEX.exec(line)) !== null) {
            const [fullMatch, target, alias] = match;
            links.push({
                text: fullMatch,
                target,
                alias,
                line: index + 1,
                context: line.trim(),
                isHeading: false
            });
        }

        // Reset regex state
        EMBEDDED_LINK_REGEX.lastIndex = 0;
    });

    return links;
}

/**
 * Finds all backlinks to a specific file
 */
export async function findBacklinks(
    vaultPath: string,
    targetPath: string
): Promise<Backlink[]> {
    try {
        validateVaultPath(vaultPath, targetPath);
        
        const backlinks: Backlink[] = [];
        const targetName = path.basename(targetPath, '.md');
        const files = await getAllMarkdownFiles(vaultPath);

        for (const file of files) {
            // Skip the target file itself
            if (file === targetPath) continue;

            try {
                const content = await fs.readFile(file, 'utf8');
                const links = await findWikiLinks(content, file);
                
                // Find links that point to our target
                const relevantLinks = links.filter(link => {
                    const linkTarget = path.basename(link.target, '.md');
                    return linkTarget === targetName;
                });

                if (relevantLinks.length > 0) {
                    backlinks.push({
                        sourceFile: path.relative(vaultPath, file),
                        links: relevantLinks
                    });
                }
            } catch (error) {
                console.error(`Error processing file ${file} for backlinks:`, error);
                // Continue with other files
            }
        }

        return backlinks;
    } catch (error) {
        if (error instanceof McpError) {
            throw error;
        }
        throw new McpError(
            ErrorCode.InternalError,
            `Failed to find backlinks: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

/**
 * Updates wikilinks in content after file operations
 */
export async function updateWikiLinks(
    content: string,
    oldPath: string,
    newPath: string | null,
    options: {
        destVaultName?: string;
        moveToOtherVault?: boolean;
    } = {}
): Promise<string> {
    const { destVaultName, moveToOtherVault } = options;
    const baseOldName = path.basename(oldPath, '.md');
    
    if (!newPath) {
        // Handle deletion - strike through links
        return content
            .replace(
                new RegExp(`\\[\\[${baseOldName}#[^\\]]*\\]\\]`, 'g'),
                match => `~~${match}~~`
            )
            .replace(
                new RegExp(`\\[\\[${baseOldName}(?:\\|[^\\]]*)?\\]\\]`, 'g'),
                match => `~~${match}~~`
            )
            .replace(
                new RegExp(`!\\[\\[${baseOldName}(?:\\|[^\\]]*)?\\]\\]`, 'g'),
                match => `~~${match}~~`
            );
    }

    const baseNewName = path.basename(newPath, '.md');
    let updatedContent = content;
    
    if (moveToOtherVault && destVaultName) {
        // Update with vault prefix for cross-vault moves
        const vaultPrefix = `${destVaultName}/`;
        
        // Update heading links
        updatedContent = updatedContent.replace(
            new RegExp(`\\[\\[${baseOldName}(#[^\\]|]+)(?:\\|([^\\]]+))?\\]\\]`, 'g'),
            (_, heading, alias) => `[[${vaultPrefix}${baseOldName}${heading}${alias ? `|${alias}` : ''}]]`
        );
        
        // Update regular links
        updatedContent = updatedContent.replace(
            new RegExp(`\\[\\[${baseOldName}(?:\\|([^\\]]+))?\\]\\]`, 'g'),
            (_, alias) => `[[${vaultPrefix}${baseOldName}${alias ? `|${alias}` : ''}]]`
        );
        
        // Update embedded links
        updatedContent = updatedContent.replace(
            new RegExp(`!\\[\\[${baseOldName}(?:\\|([^\\]]+))?\\]\\]`, 'g'),
            (_, alias) => `![[${vaultPrefix}${baseOldName}${alias ? `|${alias}` : ''}]]`
        );
    } else {
        // Regular move/rename within same vault
        // Update heading links first
        updatedContent = updatedContent.replace(
            new RegExp(`\\[\\[${baseOldName}(#[^\\]|]+)(?:\\|([^\\]]+))?\\]\\]`, 'g'),
            (_, heading, alias) => `[[${baseNewName}${heading}${alias ? `|${alias}` : ''}]]`
        );
        
        // Update regular links
        updatedContent = updatedContent.replace(
            new RegExp(`\\[\\[${baseOldName}(?:\\|([^\\]]+))?\\]\\]`, 'g'),
            (_, alias) => `[[${baseNewName}${alias ? `|${alias}` : ''}]]`
        );
        
        // Update embedded links
        updatedContent = updatedContent.replace(
            new RegExp(`!\\[\\[${baseOldName}(?:\\|([^\\]]+))?\\]\\]`, 'g'),
            (_, alias) => `![[${baseNewName}${alias ? `|${alias}` : ''}]]`
        );
    }

    return updatedContent;
}

/**
 * Creates a map of all wikilinks in the vault
 */
export async function createWikiLinkMap(vaultPath: string): Promise<WikiLinkMap> {
    try {
        const linkMap: WikiLinkMap = {};
        const files = await getAllMarkdownFiles(vaultPath);

        for (const file of files) {
            try {
                const content = await fs.readFile(file, 'utf8');
                const links = await findWikiLinks(content, file);
                
                // Group links by target
                links.forEach(link => {
                    const targetName = path.basename(link.target, '.md');
                    if (!linkMap[targetName]) {
                        linkMap[targetName] = [];
                    }
                    
                    // Find or create backlink entry for this source file
                    let backlink = linkMap[targetName].find(bl => bl.sourceFile === file);
                    if (!backlink) {
                        backlink = {
                            sourceFile: path.relative(vaultPath, file),
                            links: []
                        };
                        linkMap[targetName].push(backlink);
                    }
                    backlink.links.push(link);
                });
            } catch (error) {
                console.error(`Error processing file ${file} for link map:`, error);
                // Continue with other files
            }
        }

        return linkMap;
    } catch (error) {
        if (error instanceof McpError) {
            throw error;
        }
        throw new McpError(
            ErrorCode.InternalError,
            `Failed to create wikilink map: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

/**
 * Validates if a wikilink target exists in the vault
 */
export async function validateWikiLinkTarget(
    vaultPath: string,
    target: string
): Promise<boolean> {
    try {
        const targetPath = path.join(vaultPath, `${path.basename(target, '.md')}.md`);
        validateVaultPath(vaultPath, targetPath);
        
        try {
            await fs.access(targetPath);
            return true;
        } catch {
            return false;
        }
    } catch (error) {
        if (error instanceof McpError) {
            throw error;
        }
        throw new McpError(
            ErrorCode.InternalError,
            `Failed to validate wikilink target: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}