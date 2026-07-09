import type { FigmaAssetFormat, FigmaRef } from "./types";

/** Typed capability/transport failures per design spec §4.4. */
export type FigmaClientErrorCode =
  | "NO_TOKEN"
  | "BAD_TOKEN"
  | "FORBIDDEN"
  | "REQUIRES_ENTERPRISE"
  | "RATE_LIMITED"
  | "RENDER_FAILED"
  | "NODE_NOT_FOUND"
  | "HTTP_ERROR";

export class FigmaClientError extends Error {
  readonly code: FigmaClientErrorCode;
  readonly status?: number;

  constructor(code: FigmaClientErrorCode, message: string, status?: number) {
    super(message);
    this.name = "FigmaClientError";
    this.code = code;
    this.status = status;
  }
}

/** Injectable fetch so tests never touch the network. */
export type FigmaFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<Response>;

export interface RenderNodeOptions {
  format: FigmaAssetFormat;
  scale?: number;
}

export interface RenderedNode {
  /** short-lived figma CDN url — freeze it immediately */
  url: string;
  ext: FigmaAssetFormat;
}

export interface FigmaVariablePayload {
  name: string;
  key?: string;
  resolvedType?: string;
  valuesByMode?: Record<string, unknown>;
  variableCollectionId?: string;
}

export interface FigmaVariablesResult {
  variables: Record<string, FigmaVariablePayload>;
  variableCollections: Record<string, unknown>;
}

export interface FigmaStyleMeta {
  key: string;
  name: string;
  style_type: string;
  node_id?: string;
  description?: string;
}

/** Raw figma node document from GET /v1/files/:key/nodes. Field-level shape
 *  is consumed by nodeToHtml; kept loose here on purpose — consumers narrow
 *  children/fills/etc themselves. */
export interface FigmaNodeDocument {
  id: string;
  name: string;
  type: string;
  [field: string]: unknown;
}

export interface FigmaFileVersion {
  version: string;
  lastModified: string;
}

export interface FigmaClient {
  renderNode(ref: FigmaRef, opts: RenderNodeOptions): Promise<RenderedNode>;
  imageFills(fileKey: string): Promise<Map<string, string>>;
  variables(fileKey: string): Promise<FigmaVariablesResult>;
  styles(fileKey: string): Promise<FigmaStyleMeta[]>;
  nodeTree(ref: FigmaRef): Promise<FigmaNodeDocument>;
  fileVersion(fileKey: string): Promise<FigmaFileVersion>;
}

export interface FigmaClientOptions {
  token: string;
  fetch?: FigmaFetch;
  baseUrl?: string;
  /** Injectable delay for 429 backoff — tests pass a no-op so retries don't
   *  actually wait. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Max 429 retries before giving up. Default 3. */
  maxRetries?: number;
}

/** Read scope each endpoint needs, named exactly as figma's PAT settings UI
 *  lists them — so a 403 tells the user which checkbox to tick, not just
 *  "some read scope". The styles endpoint's `library_content:read` is the one
 *  the setup docs used to omit (it 403s even with file content + metadata). */
const SCOPE_HINTS = {
  fileContent: "File content: Read-only",
  fileMetadata: "File metadata: Read-only",
  libraryContent: "Library content: Read-only (library_content:read)",
} as const;

/** Parse a Retry-After header (figma sends integer seconds; the HTTP spec
 *  also allows a date) into ms, or null when absent/unparseable. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (raw === null) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function requireNodeId(ref: FigmaRef): string {
  if (!ref.nodeId) throw new Error(`figma ref ${ref.fileKey} has no nodeId`);
  return ref.nodeId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toVariablePayload(payload: unknown): FigmaVariablePayload | null {
  if (!isRecord(payload) || typeof payload.name !== "string") return null;
  return {
    name: payload.name,
    key: optionalString(payload.key),
    resolvedType: optionalString(payload.resolvedType),
    valuesByMode: isRecord(payload.valuesByMode) ? payload.valuesByMode : undefined,
    variableCollectionId: optionalString(payload.variableCollectionId),
  };
}

export function createFigmaClient(options: FigmaClientOptions): FigmaClient {
  const token = options.token.trim();
  if (token === "") {
    throw new FigmaClientError(
      "NO_TOKEN",
      [
        "FIGMA_TOKEN is missing. One-time setup:",
        "  1. figma.com/settings → Security → Personal access tokens → Generate new token",
        "  2. Scopes (read-only is all this integration ever needs — it never writes to figma):",
        "       File content: Read-only   ·   File metadata: Read-only",
        "       Library content: Read-only  (needed for the `tokens` published-styles fallback)",
        "       Variables: Read-only      (optional — brand variables, requires figma Enterprise;",
        "                                  without it `tokens` falls back to published styles)",
        '  3. export FIGMA_TOKEN="figd_…"  — add it to your shell profile or the project .env',
        "     so future sessions skip this step",
        "Then re-run this command.",
      ].join("\n"),
    );
  }
  const doFetch: FigmaFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const base = options.baseUrl ?? "https://api.figma.com";
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = options.maxRetries ?? 3;

  interface GetOptions {
    /** 403 → REQUIRES_ENTERPRISE (variables) rather than FORBIDDEN. */
    enterpriseGated?: boolean;
    /** scope named in a FORBIDDEN message so the user knows which to add. */
    scopeHint?: string;
  }

  /** Throw the typed error for a non-ok response (no-op when res.ok). */
  function throwForStatus(res: Response, path: string, opts: GetOptions): void {
    if (res.ok) return;
    if (res.status === 401)
      throw new FigmaClientError(
        "BAD_TOKEN",
        "figma rejected the token (401) — it is expired or revoked. Re-mint at figma.com/settings → Security, then update FIGMA_TOKEN.",
        401,
      );
    if (res.status === 403 && opts.enterpriseGated)
      throw new FigmaClientError(
        "REQUIRES_ENTERPRISE",
        "figma variables require an Enterprise plan (403) — fall back to styles",
        403,
      );
    if (res.status === 403) {
      const scopeLine = opts.scopeHint
        ? `This endpoint needs the "${opts.scopeHint}" scope — add it at figma.com/settings → Security → Personal access tokens.`
        : "The token is missing a read scope, or your account can't view this file. Check File content: Read-only + File metadata: Read-only at figma.com/settings → Security.";
      throw new FigmaClientError(
        "FORBIDDEN",
        `figma denied access (403). ${scopeLine} Also confirm the file is visible to your account.`,
        403,
      );
    }
    if (res.status === 429)
      throw new FigmaClientError(
        "RATE_LIMITED",
        `figma rate limit hit (429) and still limited after ${maxRetries} retries — wait a minute and re-run, or import fewer nodes per call.`,
        429,
      );
    throw new FigmaClientError(
      "HTTP_ERROR",
      `figma request failed: HTTP ${res.status} ${path}`,
      res.status,
    );
  }

  async function get(path: string, opts: GetOptions = {}): Promise<unknown> {
    // Retry 429 with backoff before surfacing RATE_LIMITED — figma's limit is
    // per-minute, so a couple of imports in quick succession hit it and a
    // short wait clears it. Honor Retry-After when present, else exponential.
    let res: Response;
    for (let attempt = 0; ; attempt += 1) {
      res = await doFetch(`${base}${path}`, { headers: { "X-Figma-Token": token } });
      if (res.status !== 429 || attempt >= maxRetries) break;
      const wait = retryAfterMs(res) ?? 1000 * 2 ** attempt;
      await sleep(wait);
    }
    throwForStatus(res, path, opts);
    return res.json();
  }

  return {
    async renderNode(ref, opts) {
      const nodeId = requireNodeId(ref);
      const params = new URLSearchParams({ ids: nodeId, format: opts.format });
      if (opts.scale !== undefined) params.set("scale", String(opts.scale));
      const body = await get(`/v1/images/${ref.fileKey}?${params}`, {
        scopeHint: SCOPE_HINTS.fileContent,
      });
      const images = isRecord(body) && isRecord(body.images) ? body.images : {};
      const url = images[nodeId];
      if (typeof url !== "string" || url === "")
        throw new FigmaClientError(
          "RENDER_FAILED",
          `figma could not render node ${nodeId} as ${opts.format}`,
        );
      return { url, ext: opts.format };
    },

    async imageFills(fileKey) {
      const body = await get(`/v1/files/${fileKey}/images`, { scopeHint: SCOPE_HINTS.fileContent });
      const meta = isRecord(body) && isRecord(body.meta) ? body.meta : {};
      const images = isRecord(meta.images) ? meta.images : {};
      const out = new Map<string, string>();
      for (const [ref, url] of Object.entries(images)) {
        if (typeof url === "string") out.set(ref, url);
      }
      return out;
    },

    async variables(fileKey) {
      const body = await get(`/v1/files/${fileKey}/variables/local`, { enterpriseGated: true });
      const meta = isRecord(body) && isRecord(body.meta) ? body.meta : {};
      const variables = isRecord(meta.variables) ? meta.variables : {};
      const collections = isRecord(meta.variableCollections) ? meta.variableCollections : {};
      const typed: Record<string, FigmaVariablePayload> = {};
      for (const [id, payload] of Object.entries(variables)) {
        const v = toVariablePayload(payload);
        if (v) typed[id] = v;
      }
      return { variables: typed, variableCollections: collections };
    },

    async styles(fileKey) {
      const body = await get(`/v1/files/${fileKey}/styles`, {
        scopeHint: SCOPE_HINTS.libraryContent,
      });
      const meta = isRecord(body) && isRecord(body.meta) ? body.meta : {};
      const styles = Array.isArray(meta.styles) ? meta.styles : [];
      return styles.filter(
        (s): s is FigmaStyleMeta =>
          isRecord(s) &&
          typeof s.key === "string" &&
          typeof s.name === "string" &&
          typeof s.style_type === "string",
      );
    },

    async nodeTree(ref) {
      const nodeId = requireNodeId(ref);
      const params = new URLSearchParams({ ids: nodeId, geometry: "paths" });
      const body = await get(`/v1/files/${ref.fileKey}/nodes?${params}`, {
        scopeHint: SCOPE_HINTS.fileContent,
      });
      const nodes = isRecord(body) && isRecord(body.nodes) ? body.nodes : {};
      const entry = nodes[nodeId];
      const doc = isRecord(entry) ? entry.document : undefined;
      if (
        !isRecord(doc) ||
        typeof doc.id !== "string" ||
        typeof doc.name !== "string" ||
        typeof doc.type !== "string"
      )
        throw new FigmaClientError("NODE_NOT_FOUND", `node ${nodeId} not found in ${ref.fileKey}`);
      return { ...doc, id: doc.id, name: doc.name, type: doc.type };
    },

    async fileVersion(fileKey) {
      const body = await get(`/v1/files/${fileKey}?depth=1`, {
        scopeHint: SCOPE_HINTS.fileMetadata,
      });
      const version = isRecord(body) && typeof body.version === "string" ? body.version : "";
      const lastModified =
        isRecord(body) && typeof body.lastModified === "string" ? body.lastModified : "";
      return { version, lastModified };
    },
  };
}
