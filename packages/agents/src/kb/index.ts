/**
 * Knowledge Base public surface. Sub-agents and route handlers import
 * from "@marketing/agents/kb" rather than reaching into individual files.
 */
export {
  listCollections,
  getCollectionBySlug,
  upsertCollection,
  ensureCollection,
  listDocuments,
  getDocument,
  getDocumentBySlug,
  upsertDocument,
  archiveDocument,
  listChunks,
  deleteChunksFor,
  type CollectionKind,
  type DocSource,
  type DocStatus,
  type UpsertDocumentInput,
} from "./store";
export {
  chunkAndEmbed,
  chunkMarkdown,
} from "./ingest";
export {
  kbSearch,
  renderHitsForPrompt,
  type KbSearchHit,
  type KbSearchOptions,
  type KbSearchMode,
} from "./retrieve";
export {
  rerank,
  resolveReranker,
  type RerankProvider,
  type RerankCandidate,
  type RerankResult,
} from "./rerank";
export {
  embedText,
  embedBatch,
  vectorLiteral,
  EMBED_DIMS,
  getEmbeddingConfig,
  invalidateEmbedConfigCache,
  DEFAULT_EMBEDDING_PROVIDER,
  DEFAULT_EMBEDDING_MODEL,
} from "./embed-client";
