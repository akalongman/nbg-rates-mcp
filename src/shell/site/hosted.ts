/**
 * Facts about the maintainer's hosted copy at nbg-rates.env.ge, not about the server. A self-hosted deployment runs
 * the same code under its own host, and none of these describe it.
 */
import type { Icon } from '@modelcontextprotocol/server';

export const SITE_HOST = 'nbg-rates.env.ge';
export const SITE_ORIGIN = `https://${SITE_HOST}`;
export const MCP_URL = `${SITE_ORIGIN}/mcp`;
export const REPOSITORY_URL = 'https://github.com/akalongman/nbg-rates-mcp';
export const ISSUES_URL = `${REPOSITORY_URL}/issues`;
export const OPERATOR = 'Avtandil Kikabidze';

/** The icon the hosted server lists in serverInfo, on its own origin. */
export const HOSTED_SERVER_ICONS: readonly Icon[] = [
    { src: `${SITE_ORIGIN}/icon.png`, mimeType: 'image/png', sizes: ['512x512'] },
];
